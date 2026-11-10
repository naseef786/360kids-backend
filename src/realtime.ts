import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { NotificationService } from "./notifications.js";
import { authenticate, type Authenticator } from "./routes.js";
import type { Platform } from "./platform.js";
interface Options {
  origin: string;
  authenticate?: Authenticator;
  pollIntervalMs?: number;
  reauthIntervalMs?: number;
}
export function attachRealtime(
  http: HttpServer,
  platform: Platform | undefined,
  options: Options,
) {
  const auth = options.authenticate ?? authenticate;
  const attempts = new Map<string, { count: number; expires: number }>();
  const io = new Server(http, {
    serveClient: false,
    maxHttpBufferSize: 8192,
    connectTimeout: 10000,
    cors: { origin: options.origin, methods: ["GET", "POST"] },
    allowRequest(req, done) {
      if (req.headers.origin && req.headers.origin !== options.origin) {
        done("Origin not allowed", false);
        return;
      }
      const now = Date.now(),
        ip = req.socket.remoteAddress ?? "unknown";
      for (const [key, v] of attempts)
        if (v.expires <= now) attempts.delete(key);
      let state = attempts.get(ip);
      if (!state) {
        if (attempts.size >= 10000) {
          done("Too many connections", false);
          return;
        }
        state = { count: 0, expires: now + 60000 };
        attempts.set(ip, state);
      }
      if (++state.count > 120) {
        done("Too many connections", false);
        return;
      }
      done(null, true);
    },
  });
  const notifications = platform ? new NotificationService(platform.db) : null;
  const room = (id: string) => "user:" + id;
  const signatures = new Map<string, string>();
  // Include authenticated handshakes that have not joined their room yet.
  // Counting room members alone lets simultaneous handshakes exceed the cap.
  const connections = new Map<string, number>();
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (
        !platform ||
        typeof token !== "string" ||
        !token ||
        token.length > 8192
      )
        throw new Error("Unavailable");
      const user = await auth(token);
      if (!(await platform.ready())) throw new Error("Database is not ready");
      const profile = await platform.me(user.id, user.email);
      if (socket.conn.readyState !== "open")
        throw new Error("Connection closed");
      const count = connections.get(profile.id) ?? 0;
      if (count >= 10) throw new Error("Connection limit");
      connections.set(profile.id, count + 1);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        const remaining = (connections.get(profile.id) ?? 1) - 1;
        if (remaining) connections.set(profile.id, remaining);
        else connections.delete(profile.id);
      };
      socket.conn.once("close", release);
      socket.once("disconnect", release);
      socket.data.userId = profile.id;
      socket.data.token = token;
      next();
    } catch {
      next(
        new Error("Sign in with an active account to receive live updates."),
      );
    }
  });
  io.on("connection", (socket) => {
    void socket.join(room(socket.data.userId));
    socket.emit("sync:required", { reason: "connected" });
    socket.on("disconnect", () => {
      if (!io.sockets.adapter.rooms.has(room(socket.data.userId)))
        signatures.delete(socket.data.userId);
    });
    // No client-selected rooms, notification targets or booking mutations are accepted.
  });
  let closed = false,
    polling = false,
    reauthenticating = false;
  async function sweep() {
    if (closed || polling || !notifications) return;
    polling = true;
    try {
      const ids = [
        ...new Set(
          [...io.sockets.sockets.values()].map((s) => s.data.userId as string),
        ),
      ];
      if (!ids.length) return;
      const rows = await notifications.fingerprints(ids);
      const valid = new Set<string>();
      for (const row of rows) {
        valid.add(row.id);
        if (!row.active) {
          io.in(room(row.id)).disconnectSockets(true);
          signatures.delete(row.id);
          continue;
        }
        const signature = `${row.role}:${row.total}:${row.unread}`;
        if (signatures.get(row.id) !== signature) {
          signatures.set(row.id, signature);
          io.to(room(row.id)).emit("sync:required", { reason: "changed" });
        }
      }
      for (const id of ids)
        if (!valid.has(id)) io.in(room(id)).disconnectSockets(true);
    } catch {
      io.emit("sync:unavailable");
      signatures.clear();
    } finally {
      polling = false;
    }
  }
  async function revalidate() {
    if (closed || reauthenticating || !platform) return;
    reauthenticating = true;
    try {
      const groups = new Map<string, Socket[]>();
      for (const socket of io.sockets.sockets.values()) {
        const key = socket.data.token as string;
        const group = groups.get(key) ?? [];
        group.push(socket);
        groups.set(key, group);
      }
      const batches = [...groups.values()];
      for (let offset = 0; offset < batches.length && !closed; offset += 16)
        await Promise.all(
          batches.slice(offset, offset + 16).map(async (sockets) => {
            const socket = sockets[0];
            try {
              const user = await auth(socket.data.token);
              if (user.id !== socket.data.userId)
                throw new Error("Identity changed");
              await platform.me(user.id, user.email);
            } catch {
              for (const connection of sockets) connection.disconnect(true);
            }
          }),
        );
    } finally {
      reauthenticating = false;
    }
  }
  const poll = setInterval(() => void sweep(), options.pollIntervalMs ?? 1500);
  poll.unref();
  const reauth = setInterval(
    () => void revalidate(),
    options.reauthIntervalMs ?? 60000,
  );
  reauth.unref();
  async function close() {
    closed = true;
    clearInterval(poll);
    clearInterval(reauth);
    await new Promise<void>((resolve) => io.close(() => resolve()));
    attempts.clear();
    signatures.clear();
    connections.clear();
  }
  return { io, close, sweep, revalidate };
}

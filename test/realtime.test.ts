import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { io, type Socket } from "socket.io-client";
import { Platform, type Actor } from "../src/platform.js";
import { NotificationService } from "../src/notifications.js";
import { attachRealtime } from "../src/realtime.js";
import { createApp } from "../src/app.js";
import { createTestDatabase } from "./helpers.js";
function event(socket: Socket, name: string) {
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(name, done);
      reject(new Error("Timed out waiting for " + name));
    }, 4000);
    function done(value: any) {
      clearTimeout(timer);
      resolve(value);
    }
    socket.once(name, done);
  });
}
test(
  "authenticated real-time delivery, tenant isolation, read state, reconnect and account revocation",
  { timeout: 25000 },
  async () => {
    const { pg, db } = await createTestDatabase();
    const p = new Platform(db),
      notifications = new NotificationService(db);
    const parent: Actor = { id: randomUUID(), role: "parent" },
      provider: Actor = { id: randomUUID(), role: "provider" },
      other: Actor = { id: randomUUID(), role: "parent" },
      admin: Actor = { id: randomUUID(), role: "admin" };
    const actors: Record<string, Actor> = { parent, provider, other, admin };
    for (const a of Object.values(actors)) {
      await p.me(a.id, "synthetic@example.invalid");
      await p.read("UPDATE app.profiles SET role=$2 WHERE id=$1", [
        a.id,
        a.role,
      ]);
    }
    const business = await p.apply(provider, {
      name: "Synthetic provider",
      description: "Only synthetic test activity data",
    });
    await p.approve(admin, business.id, "approved");
    const activity = await p.createActivity(admin, {
      providerId: business.id,
      title: "Synthetic session",
      description: "Synthetic test",
      category: "Sports",
      area: "Dubai",
      minAge: 1,
      maxAge: 17,
      priceFils: 10000,
      policy: "Synthetic policy for integration testing.",
      published: true,
      startsAt: "2030-05-01T12:00:00Z",
      cutoffAt: "2030-04-30T12:00:00Z",
      capacity: 4,
    });
    const child = await p.addChild(parent, {
      firstName: "Synthetic",
      surname: "Child",
      birthDate: "2018-01-01",
    });
    const auth = async (token: string) => {
      const a = actors[token];
      if (!a) throw new Error("Invalid credentials");
      return { id: a.id, email: "synthetic@example.invalid" };
    };
    const http = createServer(createApp("http://localhost:3000", p, auth));
    const gateway = attachRealtime(http, p, {
      origin: "http://localhost:3000",
      authenticate: auth,
      pollIntervalMs: 60000,
      reauthIntervalMs: 60000,
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const origin =
      "http://127.0.0.1:" + (http.address() as { port: number }).port;
    const sockets: Socket[] = [];
    function make(
      token: string,
      originHeader = "http://localhost:3000",
      transports = ["websocket"],
    ) {
      const socket = io(origin, {
        forceNew: true,
        autoConnect: false,
        reconnection: false,
        transports,
        auth: { token, userId: provider.id, role: "admin" },
        extraHeaders: { Origin: originHeader },
      });
      sockets.push(socket);
      return socket;
    }
    async function connect(socket: Socket) {
      const ready = event(socket, "sync:required");
      socket.connect();
      assert.equal((await ready).reason, "connected");
    }
    try {
      for (const bad of [
        make("invalid"),
        make(""),
        make("parent", "https://untrusted.example"),
      ]) {
        const rejected = event(bad, "connect_error");
        bad.connect();
        assert.ok(await rejected);
        assert.equal(bad.connected, false);
        bad.disconnect();
      }
      const family = make("parent"),
        partner = make("provider", "http://localhost:3000", [
          "polling",
          "websocket",
        ]),
        stranger = make("other"),
        staff = make("admin");
      for (const s of [family, partner, stranger, staff]) await connect(s);

      await notifications.fingerprints(Object.values(actors).map((a) => a.id));
      const baseline = [family, partner, stranger, staff].map((s) =>
        event(s, "sync:required"),
      );
      await gateway.sweep();
      await Promise.all(baseline);
      const rooms = gateway.io.sockets.sockets.get(stranger.id!)!.rooms;
      assert.ok(rooms.has("user:" + other.id));
      assert.equal(rooms.has("user:" + provider.id), false);
      stranger.emit("join", "user:" + provider.id);
      stranger.emit("subscribe", { userId: provider.id });
      let strangerChanges = 0;
      stranger.on("sync:required", () => strangerChanges++);
      const changes = [family, partner, staff].map((s) =>
        event(s, "sync:required"),
      );
      const request = await p.request(parent, "socket-request", {
        sessionId: activity.sessionId,
        childIds: [child.id],
        policyAccepted: true,
      });
      await gateway.sweep();
      for (const signal of await Promise.all(changes))
        assert.deepEqual(signal, { reason: "changed" });

      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(strangerChanges, 0);
      const partnerFeed = await notifications.list(provider);
      assert.ok(
        partnerFeed.items.some(
          (n) => n.subject_id === request.id && n.event === "request.submitted",
        ),
      );
      const fingerprints = await notifications.fingerprints([
        parent.id,
        provider.id,
        admin.id,
      ]);
      for (const actor of [parent, provider, admin])
        assert.equal(
          Number(fingerprints.find((f) => f.id === actor.id)!.total),
          (await notifications.list(actor)).total,
        );
      const strangerFeed = await notifications.list(other);
      assert.equal(strangerFeed.total, 0);
      const notice = partnerFeed.items.find(
        (n) => n.subject_id === request.id,
      )!;
      await notifications.markRead(parent, [notice.id]);
      assert.equal(
        (await notifications.list(provider)).items.find(
          (n) => n.id === notice.id,
        )!.read_at,
        null,
      );
      const before = (await notifications.list(parent)).total;
      await assert.rejects(
        () =>
          p.command(parent, "rollback-notice", { test: true }, async (c) => {
            await p.audit(c, parent, parent.id, "profile.updated");
            throw new Error("Synthetic rollback");
          }),
        /rollback/,
      );
      assert.equal((await notifications.list(parent)).total, before);
      partner.disconnect();
      await p.act(parent, "socket-cancel", request.id, {
        action: "cancel",
        version: 1,
        reason: "Synthetic cancellation while partner disconnected",
      });
      await connect(partner);
      assert.ok(
        (await notifications.list(provider)).items.some(
          (n) => n.event === "cancel" && n.subject_id === request.id,
        ),
      );
      // Both partner tabs observe a read-count change, not only the tab that marked it read.

      const partnerTab = make("provider");
      await connect(partnerTab);
      const warm = event(partner, "sync:required");
      const warmTab = event(partnerTab, "sync:required");
      await gateway.sweep();
      await Promise.all([warm, warmTab]);
      const readSignals = [partner, partnerTab].map((s) =>
        event(s, "sync:required"),
      );
      await notifications.markRead(provider, null);
      await gateway.sweep();
      await Promise.all(readSignals);
      assert.equal((await notifications.list(provider)).unread, 0);
      // All handshakes start together; pending authenticated connections count
      // toward the cap before Socket.IO has added them to recipient rooms.
      const extra = Array.from({ length: 10 }, () => make("other"));
      const results = await Promise.all(
        extra.map(
          (socket) =>
            new Promise<boolean>((resolve, reject) => {
              const timeout = setTimeout(
                () => reject(new Error("Connection limit test timed out")),
                4000,
              );
              socket.once("connect", () => {
                clearTimeout(timeout);
                resolve(true);
              });
              socket.once("connect_error", () => {
                clearTimeout(timeout);
                resolve(false);
              });
              socket.connect();
            }),
        ),
      );
      assert.equal(results.filter(Boolean).length, 9);
      assert.equal(results.filter((value) => !value).length, 1);
      await Promise.all(
        extra
          .filter((socket) => socket.connected)
          .map(
            (socket) =>
              new Promise<void>((resolve) => {
                const serverSocket = gateway.io.sockets.sockets.get(
                  socket.id!,
                )!;
                serverSocket.once("disconnect", () => resolve());
                socket.disconnect();
              }),
          ),
      );
      await connect(make("other"));
      await p.read("UPDATE app.profiles SET role='parent' WHERE id=$1", [
        admin.id,
      ]);
      assert.equal(
        (await notifications.list({ ...admin, role: "parent" })).total,
        0,
      );
      const disconnected = event(partner, "disconnect");
      await p.read("UPDATE app.profiles SET active=false WHERE id=$1", [
        provider.id,
      ]);
      await gateway.sweep();
      assert.equal(await disconnected, "io server disconnect");
      const revoked = event(family, "disconnect");
      delete actors.parent;
      await gateway.revalidate();
      assert.equal(await revoked, "io server disconnect");
    } finally {
      for (const socket of sockets) socket.disconnect();
      await gateway.close();
      await pg.close();
    }
  },
);

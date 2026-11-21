import pg from "pg";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
export interface Connection {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, any>[]; rowCount?: number | null }>;
  release(destroy?: boolean): void;
}
export interface Database {
  connect(): Promise<Connection>;
  end?(): Promise<void>;
}
export function connectionOptions(
  env: NodeJS.ProcessEnv = process.env,
): pg.PoolConfig {
  if (!env.DATABASE_URL)
    throw Object.assign(new Error("Database is not configured."), {
      status: 503,
    });
  let url: URL;
  try {
    url = new URL(env.DATABASE_URL);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error();
  } catch {
    throw Object.assign(new Error("Database connection string is invalid."), {
      status: 503,
    });
  }
  const mode = url.searchParams.get("sslmode");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    !local &&
    ["disable", "allow", "prefer", "no-verify"].includes(mode ?? "")
  ) {
    throw Object.assign(
      new Error("Remote database connections require verified TLS."),
      { status: 503 },
    );
  }
  if (url.searchParams.has("sslcert") || url.searchParams.has("sslkey")) {
    throw Object.assign(
      new Error("Client-certificate database URLs are not supported."),
      { status: 503 },
    );
  }
  const rootFile = env.DATABASE_CA_CERT || url.searchParams.get("sslrootcert");
  const supabase =
    url.hostname.endsWith(".pooler.supabase.com") ||
    url.hostname.endsWith(".supabase.co");
  let ca: string | undefined;
  try {
    if (rootFile) ca = readFileSync(rootFile, "utf8");
    else if (supabase)
      ca = readFileSync(
        new URL("../certificates/supabase-ca.crt", import.meta.url),
        "utf8",
      );
  } catch {
    throw Object.assign(
      new Error("Database TLS root certificate is unavailable."),
      { status: 503 },
    );
  }
  // pg URL SSL parameters override its explicit ssl object. Keep one verified configuration.
  url.searchParams.delete("sslmode");
  url.searchParams.delete("sslrootcert");
  return {
    connectionString: url.toString(),
    ssl:
      local && (!mode || mode === "disable")
        ? false
        : {
            rejectUnauthorized: true,
            ...(ca ? { ca } : {}),
            ...(!isIP(url.hostname) ? { servername: url.hostname } : {}),
          },
    max: 10,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
    idle_in_transaction_session_timeout: 15000,
  };
}
export function database(): Database {
  const pool = new pg.Pool(connectionOptions());
  // An idle connection error must not become an unhandled EventEmitter error.
  pool.on("error", () => console.error("Idle database connection failed; the pool will reconnect."));
  return pool;
}
export async function transaction<T>(
  db: Database,
  fn: (c: Connection) => Promise<T>,
): Promise<T> {
  const c = await db.connect();
  let destroy = false;
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    destroy = fatalConnectionError(e);
    try {
      await c.query("ROLLBACK");
    } catch {
      // A failed rollback leaves connection state unknown. Preserve the root error.
      destroy = true;
    }
    throw e;
  } finally {
    c.release(destroy);
  }
}

function fatalConnectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, severity, message } = error as {
    code?: string;
    severity?: string;
    message?: string;
  };
  return (
    severity === "FATAL" || severity === "PANIC" ||
    Boolean(code && (
      /^08/.test(code) ||
      ["57P01", "57P02", "57P03", "ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNREFUSED"].includes(code)
    )) ||
    /connection (?:terminated|closed)|client (?:is not queryable|has already been connected)/i.test(message ?? "")
  );
}

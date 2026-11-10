import pg from "pg";
export interface Connection {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, any>[]; rowCount?: number | null }>;
  release(): void;
}
export interface Database {
  connect(): Promise<Connection>;
  end?(): Promise<void>;
}
export function database(): Database {
  if (!process.env.DATABASE_URL)
    throw Object.assign(new Error("Database is not configured."), {
      status: 503,
    });
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 5000,
    query_timeout: 20000,
    keepAlive: true,
    statement_timeout: 15000,
    idle_in_transaction_session_timeout: 20000,
  });
  // An idle connection can fail after a restart/network interruption. Without
  // a listener, EventEmitter would terminate the whole API process.
  pool.on("error", () => console.error("An idle database connection failed."));
  return pool;
}
export async function transaction<T>(
  db: Database,
  fn: (c: Connection) => Promise<T>,
): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/migrations.js";
import type { Connection, Database } from "../src/database.js";

export async function createTestDatabase() {
  const pg = new PGlite();
  const query: Connection["query"] = async (sql, params = []) => {
    if (!params.length && sql.includes(";")) {
      const results = await pg.exec(sql),
        result = results[results.length - 1];
      return {
        rows: (result?.rows ?? []) as Record<string, any>[],
        rowCount: result?.affectedRows,
      };
    }
    const result = await pg.query(sql, params);
    return {
      rows: result.rows as Record<string, any>[],
      rowCount: result.affectedRows,
    };
  };
  const connection: Connection = { query, release() {} };
  await migrate({connect: async () => connection});
  // PGlite has one embedded connection; serialize transactions and standalone
  // reads so a background sweep cannot observe another transaction's writes.
  let tail = Promise.resolve();
  const db: Database = {
    async connect() {
      const before = tail;
      let unlock!: () => void;
      tail = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      await before;
      return { query, release: unlock };
    },
  };
  return { pg, db, connection };
}

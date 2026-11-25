import type { PGlite } from "@electric-sql/pglite";
import type { Database } from "../../src/database.js";

export function databaseFor(pg: PGlite): Database {
  return {
    connect: async () => ({
      query: async (sql, params) => {
        const result =
          params === undefined
            ? (await pg.exec(sql)).at(-1)!
            : await pg.query(sql, params);
        return {
          rows: result.rows as Record<string, any>[],
          rowCount: result.affectedRows,
        };
      },
      release() {},
    }),
  };
}

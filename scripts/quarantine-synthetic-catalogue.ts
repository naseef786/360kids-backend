import "dotenv/config";
import { database } from "../src/database.js";

// One-time, narrowly scoped cleanup of known fictional E2E listings.
// Unpublish only; preserve bookings, sessions and provider records.
const db = database();
const connection = await db.connect();
try {
  await connection.query("BEGIN");
  const selected = (await connection.query(`
    SELECT id,published FROM app.activities
    WHERE title ~ '^Synthetic E2E [0-9a-f]{8} Creative Explorers$'
    ORDER BY id FOR UPDATE
  `)).rows;
  if (selected.length !== 3) throw new Error("Expected exactly three known fictional listings; no changes committed.");
  const ids = selected.filter((row) => row.published).map((row) => row.id);
  const updated = await connection.query(`
    UPDATE app.activities SET published=false,version=version+1
    WHERE id=ANY($1::uuid[]) AND published RETURNING id
  `, [ids]);
  if (updated.rows.length !== ids.length) throw new Error("Catalogue changed during quarantine; no changes committed.");
  for (const row of updated.rows) {
    await connection.query(`
      INSERT INTO app.audit(id,subject_id,action,details)
      VALUES(gen_random_uuid(),$1,'catalogue.synthetic_quarantined',$2::jsonb)
    `, [row.id, JSON.stringify({source:"database_operator",reason:"Prevent fictional E2E listings appearing in the public catalogue"})]);
  }
  await connection.query("COMMIT");
  console.log(`Unpublished ${updated.rows.length} known synthetic E2E listings; preserved existing bookings and recorded audit entries for changes.`);
} catch {
  try { await connection.query("ROLLBACK"); } catch { /* preserve failure */ }
  console.error("Synthetic catalogue quarantine did not complete.");
  process.exitCode = 1;
} finally {
  connection.release();
  await db.end?.();
}

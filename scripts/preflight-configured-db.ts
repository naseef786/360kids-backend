import "dotenv/config";
import { database } from "../src/database.js";

// Read-only operational preflight. Never print credentials or row contents.
const db = database();
const connection = await db.connect();
try {
  await connection.query("BEGIN READ ONLY");
  const counts = (await connection.query(`
    SELECT
      (SELECT count(*)::int FROM app.profiles) AS profiles,
      (SELECT count(*)::int FROM app.providers) AS providers,
      (SELECT count(*)::int FROM app.activities) AS activities,
      (SELECT count(*)::int FROM app.bookings) AS bookings,
      (SELECT count(*)::int FROM app.bookings WHERE state='PAYMENT_CHECKING') AS reviews,
      (SELECT count(*)::int FROM app.payments) AS payments,
      (SELECT count(*)::int FROM app.refunds) AS refunds
  `)).rows[0];
  console.log(`Existing records: profiles=${counts.profiles}, providers=${counts.providers}, activities=${counts.activities}, bookings=${counts.bookings}, reviews=${counts.reviews}, payments=${counts.payments}, refunds=${counts.refunds}`);
  const listings = (await connection.query(`
    SELECT a.title,a.published,count(DISTINCT b.id)::int AS bookings
    FROM app.activities a
    LEFT JOIN app.sessions s ON s.activity_id=a.id
    LEFT JOIN app.bookings b ON b.session_id=s.id
    GROUP BY a.id ORDER BY a.title,a.id
  `)).rows;
  for (const listing of listings)
    console.log(`Listing: ${JSON.stringify(String(listing.title))}; published=${listing.published}; bookings=${listing.bookings}`);
  const pages = (await connection.query("SELECT slug,title,published FROM app.content ORDER BY slug")).rows;
  for (const page of pages)
    console.log(`Content: ${page.slug}; published=${page.published}; title=${JSON.stringify(String(page.title))}`);
  await connection.query("COMMIT");
} catch (error) {
  try { await connection.query("ROLLBACK"); } catch { /* preserve root error */ }
  console.error("Read-only preflight failed.");
  process.exitCode = 1;
} finally {
  connection.release();
  await db.end?.();
}

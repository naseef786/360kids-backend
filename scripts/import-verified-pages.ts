import "dotenv/config";
import { database } from "../src/database.js";

// Owner-requested, source-verified informational content only. No activity,
// price, schedule, provider or legal text is created by this import.
const pages = [
  {
    slug: "about",
    title: "About 360 Kids Activity",
    body: "360 Kids Activity was founded by Ana Mincic, a piano teacher and parent of three. Her experience helping children learn music and organizing activities for her own family inspired a Dubai portal connecting parents with children's activity providers.\n\nSource: https://360kidsactivity.com/about/",
  },
  {
    slug: "contact",
    title: "Contact 360 Kids Activity",
    body: "Phone: +971 55 888 3305\nEmail: info@360kidsactivity.com\nLocation: Dubai, UAE\n\nSource: https://360kidsactivity.com/contact/",
  },
] as const;

const db = database();
const connection = await db.connect();
try {
  await connection.query("BEGIN");
  const added: string[] = [];
  for (const page of pages) {
    const result = await connection.query(`
      INSERT INTO app.content(slug,title,body,published)
      VALUES($1,$2,$3,true) ON CONFLICT(slug) DO NOTHING RETURNING slug
    `, [page.slug, page.title, page.body]);
    if (result.rows.length) added.push(page.slug);
  }
  await connection.query("COMMIT");
  console.log(`Verified public pages added: ${added.join(", ") || "none (existing content preserved)"}.`);
} catch {
  try { await connection.query("ROLLBACK"); } catch { /* preserve failure */ }
  console.error("Verified page import failed; no pages committed.");
  process.exitCode = 1;
} finally {
  connection.release();
  await db.end?.();
}

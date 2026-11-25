import { randomUUID } from "node:crypto";
import { transaction, type Database } from "./database.js";
import { BRAND_LOGO_CID, emailConfig, sendEmail, type EmailMessage } from "./email.js";
import { displayReference } from "./display-reference.js";

export function contactAcknowledgment(contactId: string, recipient: string): EmailMessage {
  const subject = "Thank you for contacting 360 Kids Activity";
  const text = [
    "Thank you for getting in touch with 360 Kids Activity.",
    "We have received your message. Our team will review it and reply by email.",
    `Your reference: ${displayReference("contact",contactId)}`,
    "A contact message is not a booking request or a confirmed place in an activity.",
    "If you did not send this message, you can ignore this email.",
    "360 Kids Activity",
  ].join("\n\n");
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#fffcf8;color:#172b3a;font-family:Arial,sans-serif">
    <div style="max-width:600px;margin:auto;background:#fff;border:1px solid #dfe6e9;border-radius:20px;overflow:hidden">
      <div style="height:9px;background:#f5a300"></div>
      <div style="padding:32px">
        <img src="cid:${BRAND_LOGO_CID}" width="96" height="96" alt="360 Kids Activity" style="display:block;width:96px;height:96px;margin:0 0 20px;border:0">
        <h1 style="margin:0 0 20px;font-size:28px;line-height:1.2">Thanks for reaching out.</h1>
        <p style="font-size:16px;line-height:1.6">We have received your message. Our team will review it and reply by email.</p>
        <p style="padding:14px 16px;background:#e5f7f6;border-radius:12px;font-size:14px">Your reference: <strong>${displayReference("contact",contactId)}</strong></p>
        <p style="font-size:14px;line-height:1.6;color:#52616b">A contact message is not a booking request or a confirmed place in an activity.</p>
        <p style="font-size:13px;color:#52616b">If you did not send this message, you can ignore this email.</p>
      </div>
    </div>
  </body></html>`;
  return { to: recipient, subject, text, html, brandLogo: true };
}

/** Disabled by default because the public form can be used to target third-party mailboxes. */
export async function dispatchContactAcknowledgments(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
  deliver: (message: EmailMessage, environment: NodeJS.ProcessEnv) => Promise<"disabled" | "accepted"> = sendEmail,
): Promise<number> {
  if (env.CONTACT_ACK_ENABLED !== "true" || emailConfig(env).mode !== "smtp") return 0;
  const contacts = await transaction(db, async connection => {
    await connection.query(`UPDATE app.contact_ack_attempts a SET status='failed',finished_at=now()
      FROM app.contact_acknowledgments q WHERE a.contact_id=q.contact_id AND a.attempt_number=q.attempts
      AND a.status='sending' AND q.status='sending' AND q.lease_until<now() AND q.attempts>=5`);
    await connection.query(`UPDATE app.contact_acknowledgments SET status='failed',lease_until=NULL
      WHERE status='sending' AND lease_until<now() AND attempts>=5`);
    const result = await connection.query(`WITH due AS (
      SELECT contact_id FROM app.contact_acknowledgments
      WHERE (status IN ('pending','retry') AND next_attempt_at<=now())
         OR (status='sending' AND lease_until<now() AND attempts<5)
      ORDER BY next_attempt_at,contact_id FOR UPDATE SKIP LOCKED LIMIT 10
    ) UPDATE app.contact_acknowledgments q SET status='sending',attempts=q.attempts+1,
        lease_until=now()+interval '2 minutes'
      FROM due WHERE q.contact_id=due.contact_id
      RETURNING q.contact_id,q.attempts`);
    for (const row of result.rows) {
      await connection.query(`UPDATE app.contact_ack_attempts SET status='failed',finished_at=now()
        WHERE contact_id=$1 AND attempt_number=$2 AND status='sending'`,[row.contact_id,row.attempts-1]);
      await connection.query(`INSERT INTO app.contact_ack_attempts(id,contact_id,attempt_number)
        VALUES($1,$2,$3)`,[randomUUID(),row.contact_id,row.attempts]);
    }
    return result.rows as {contact_id:string;attempts:number}[];
  });
  for (const contact of contacts) {
    const connection = await db.connect();
    let recipient: string;
    try {
      const row = (await connection.query(`SELECT email FROM app.contact_submissions WHERE id=$1`,[contact.contact_id])).rows[0];
      recipient = row.email;
    } finally { connection.release(); }
    let accepted = false;
    try { accepted = (await deliver(contactAcknowledgment(contact.contact_id,recipient),env)) === "accepted"; }
    catch { /* Do not expose recipient data or SMTP credentials. */ }
    const delay = Math.min(3600,60 * 2 ** Math.min(contact.attempts-1,5));
    await transaction(db, async connection => {
      await connection.query(`UPDATE app.contact_ack_attempts SET status=$3,finished_at=now()
        WHERE contact_id=$1 AND attempt_number=$2 AND status='sending'`,
        [contact.contact_id,contact.attempts,accepted ? "accepted" : "failed"]);
      await connection.query(`UPDATE app.contact_acknowledgments SET
        status=CASE WHEN $3::boolean THEN 'accepted' WHEN attempts>=5 THEN 'failed' ELSE 'retry' END,
        accepted_at=CASE WHEN $3::boolean THEN now() ELSE accepted_at END,
        next_attempt_at=CASE WHEN $3::boolean OR attempts>=5 THEN next_attempt_at
          ELSE now()+($4::int*interval '1 second') END,lease_until=NULL
        WHERE contact_id=$1 AND status='sending' AND attempts=$2`,
        [contact.contact_id,contact.attempts,accepted,delay]);
    });
  }
  return contacts.length;
}

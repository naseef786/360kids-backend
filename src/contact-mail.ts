import { randomUUID } from "node:crypto";
import { transaction, type Database } from "./database.js";
import { BRAND_LOGO_CID, emailConfig, sendEmail, type EmailMessage } from "./email.js";
import { displayReference } from "./display-reference.js";

type Contact = {
  id: string;
  name: string;
  email: string;
  topic: string;
  message: string;
  email_attempts: number;
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;",
  })[character] ?? character);
}

function notification(contact: Contact, to: string): EmailMessage {
  return {
    to,
    subject: "New 360 Kids contact enquiry",
    text: [
      "A new website contact message is ready for follow-up.",
      `Reference: ${displayReference("contact",contact.id)}`,
      `Name: ${contact.name}`,
      `Reply to: ${contact.email}`,
      `Topic: ${contact.topic}`,
      "Message:",
      contact.message,
    ].join("\n"),
    html: `<!doctype html><html><body style="margin:0;padding:24px;background:#fffcf8;color:#172b3a;font-family:Arial,sans-serif">
      <div style="max-width:600px;margin:auto;background:#fff;border:1px solid #dfe6e9;border-radius:20px;overflow:hidden">
        <div style="height:9px;background:#f5a300"></div>
        <div style="padding:32px">
          <img src="cid:${BRAND_LOGO_CID}" width="96" height="96" alt="360 Kids Activity" style="display:block;width:96px;height:96px;margin:0 0 20px;border:0">
          <h1 style="margin:0 0 16px;font-size:26px;line-height:1.2">New contact enquiry</h1>
          <p style="font-size:14px;line-height:1.5;color:#52616b">A website visitor has sent a message for your team to review.</p>
          <p style="padding:14px 16px;background:#e5f7f6;border-radius:12px;font-size:14px">Reference: <strong>${displayReference("contact",contact.id)}</strong></p>
          <p style="font-size:15px;line-height:1.6"><strong>Name:</strong> ${escapeHtml(contact.name)}<br><strong>Reply to:</strong> ${escapeHtml(contact.email)}<br><strong>Topic:</strong> ${escapeHtml(contact.topic)}</p>
          <div style="padding:16px;background:#f6f8f8;border-radius:12px;font-size:15px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(contact.message)}</div>
        </div>
      </div>
    </body></html>`,
    brandLogo: true,
  };
}

/** At-least-once SMTP dispatch; database state and attempts are durable. */
export async function dispatchContactEmails(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
  deliver: (message: EmailMessage, environment: NodeJS.ProcessEnv) => Promise<"disabled" | "accepted"> = sendEmail,
): Promise<number> {
  const config = emailConfig(env);
  if (config.mode === "disabled") return 0;
  const contacts = await transaction(db, async connection => {
    await connection.query(`
      UPDATE app.contact_email_attempts a SET status='failed',finished_at=now()
      FROM app.contact_submissions c
      WHERE a.contact_id=c.id AND a.attempt_number=c.email_attempts
        AND a.status='sending' AND c.email_status='sending'
        AND c.email_lease_until < now() AND c.email_attempts>=5`);
    await connection.query(`
      UPDATE app.contact_submissions SET email_status='failed',email_lease_until=NULL,
        email_next_attempt_at=NULL
      WHERE email_status='sending' AND email_lease_until < now() AND email_attempts>=5`);
    const result = await connection.query(`
      WITH due AS (
        SELECT id FROM app.contact_submissions
        WHERE (email_status IN ('pending','retry') AND email_next_attempt_at <= now())
           OR (email_status='sending' AND email_lease_until < now() AND email_attempts<5)
        ORDER BY email_next_attempt_at,id
        FOR UPDATE SKIP LOCKED LIMIT 10
      )
      UPDATE app.contact_submissions c
      SET email_status='sending',email_attempts=email_attempts+1,
          email_lease_until=now()+interval '2 minutes'
      FROM due WHERE c.id=due.id
      RETURNING c.id,c.name,c.email,c.topic,c.message,c.email_attempts`);
    for (const contact of result.rows) {
      await connection.query(`
        UPDATE app.contact_email_attempts SET status='failed',finished_at=now()
        WHERE contact_id=$1 AND attempt_number=$2 AND status='sending'`,
        [contact.id,contact.email_attempts-1],
      );
      await connection.query(
        `INSERT INTO app.contact_email_attempts(id,contact_id,attempt_number)
         VALUES($1,$2,$3)`,
        [randomUUID(),contact.id,contact.email_attempts],
      );
    }
    return result.rows as Contact[];
  });
  for (const contact of contacts) {
    let accepted = false;
    try {
      accepted = (await deliver(notification(contact,config.user),env)) === "accepted";
    } catch { /* Do not log recipient data or SMTP credentials. */ }
    const nextDelaySeconds = Math.min(3600,60 * 2 ** Math.min(contact.email_attempts - 1,5));
    await transaction(db, async connection => {
      await connection.query(
        `UPDATE app.contact_email_attempts SET finished_at=now(),status=$3
         WHERE contact_id=$1 AND attempt_number=$2 AND status='sending'`,
        [contact.id,contact.email_attempts,accepted ? "accepted" : "failed"],
      );
      await connection.query(`
        UPDATE app.contact_submissions
        SET email_status=CASE WHEN $3::boolean THEN 'accepted'
              WHEN email_attempts>=5 THEN 'failed' ELSE 'retry' END,
            email_accepted_at=CASE WHEN $3::boolean THEN now() ELSE email_accepted_at END,
            email_next_attempt_at=CASE WHEN $3::boolean OR email_attempts>=5 THEN NULL
              ELSE now()+($4::int * interval '1 second') END,
            email_lease_until=NULL
        WHERE id=$1 AND email_status='sending' AND email_attempts=$2`,
        [contact.id,contact.email_attempts,accepted,nextDelaySeconds],
      );
    });
  }
  return contacts.length;
}

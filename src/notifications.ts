import { randomUUID } from "node:crypto";
import { transaction, type Connection, type Database } from "./database.js";
import type { Actor } from "./platform.js";
/** All expressions passed here are server-owned SQL identifiers, never client input. */
function visible(user: string, role: string) {
  return `(n.audience='admin' AND ${role}='admin') OR (n.audience='member' AND (
 (n.kind='booking' AND EXISTS(SELECT 1 FROM app.bookings b JOIN app.providers p ON p.id=b.provider_id WHERE b.id=n.subject_id AND (b.parent_id=${user} OR p.owner_id=${user}))) OR
 (n.kind='provider' AND EXISTS(SELECT 1 FROM app.providers p WHERE p.id=n.subject_id AND p.owner_id=${user})) OR
 (n.kind='activity' AND EXISTS(SELECT 1 FROM app.activities a JOIN app.providers p ON p.id=a.provider_id WHERE a.id=n.subject_id AND p.owner_id=${user})) OR
 (n.kind='correction' AND EXISTS(SELECT 1 FROM app.corrections c JOIN app.providers p ON p.id=c.provider_id WHERE c.id=n.subject_id AND p.owner_id=${user})) OR
 (n.kind='support' AND EXISTS(SELECT 1 FROM app.support s WHERE s.id=n.subject_id AND s.owner_id=${user})) OR
 (n.kind='account' AND (n.subject_id=${user} OR EXISTS(SELECT 1 FROM app.children c WHERE c.id=n.subject_id AND c.parent_id=${user})))
))`;
}
/** Runs in the caller's transaction. Rolled-back changes cannot produce notifications. */
export async function recordNotifications(
  c: Connection,
  auditId: string,
  subject: string,
  event: string,
) {
  const recipients = (
    await c.query(
      `SELECT 'booking' AS kind,b.parent_id AS owner_id FROM app.bookings b WHERE b.id=$1
 UNION SELECT 'booking',p.owner_id FROM app.bookings b JOIN app.providers p ON p.id=b.provider_id WHERE b.id=$1
 UNION SELECT 'provider',owner_id FROM app.providers WHERE id=$1
 UNION SELECT 'activity',p.owner_id FROM app.activities a JOIN app.providers p ON p.id=a.provider_id WHERE a.id=$1
 UNION SELECT 'correction',p.owner_id FROM app.corrections c JOIN app.providers p ON p.id=c.provider_id WHERE c.id=$1
 UNION SELECT 'support',owner_id FROM app.support WHERE id=$1
 UNION SELECT 'account',parent_id FROM app.children WHERE id=$1
 UNION SELECT 'account',id FROM app.profiles WHERE id=$1`,
      [subject],
    )
  ).rows;
  const targets = new Map<string, { kind: string; audience: string }>();
  for (const r of recipients)
    targets.set(r.owner_id, { kind: r.kind, audience: "member" });
  // Account/child-profile updates are private to the family. Admins receive operational events only.
  const kind = recipients[0]?.kind ?? "admin";
  if (kind !== "account")
    for (const p of (
      await c.query("SELECT id FROM app.profiles WHERE role='admin' AND active")
    ).rows) {
      if (!targets.has(p.id)) targets.set(p.id, { kind, audience: "admin" });
    }
  for (const [id, target] of targets)
    await c.query(
      `INSERT INTO app.notifications(id,audit_id,recipient_id,audience,kind,subject_id,event) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(audit_id,recipient_id) DO NOTHING`,
      [randomUUID(), auditId, id, target.audience, target.kind, subject, event],
    );
}
export class NotificationService {
  constructor(readonly db: Database) {}
  async list(a: Actor, before?: string) {
    return transaction(this.db, async (c) => {
      const scope = visible("$1", "$2");
      const items = (
        await c.query(
          `SELECT n.id,n.sequence::text,n.kind,n.subject_id,n.event,n.created_at,n.read_at FROM app.notifications n WHERE n.recipient_id=$1 AND (${scope}) AND ($3::bigint IS NULL OR n.sequence<$3) ORDER BY n.sequence DESC LIMIT 50`,
          [a.id, a.role, before ?? null],
        )
      ).rows;
      const counts = (
        await c.query(
          `SELECT COUNT(*)::text AS total,COUNT(*) FILTER(WHERE n.read_at IS NULL)::text AS unread FROM app.notifications n WHERE n.recipient_id=$1 AND (${scope})`,
          [a.id, a.role],
        )
      ).rows[0];
      return {
        items,
        total: Number(counts.total),
        unread: Number(counts.unread),
        nextBefore:
          items.length === 50 ? items[items.length - 1].sequence : null,
      };
    });
  }
  async markRead(a: Actor, ids: string[] | null) {
    return transaction(this.db, async (c) => {
      await c.query(
        `UPDATE app.notifications n SET read_at=now() WHERE n.recipient_id=$1 AND n.read_at IS NULL AND (${visible("$1", "$2")}) AND ($3::uuid[] IS NULL OR n.id=ANY($3))`,
        [a.id, a.role, ids],
      );
      return { saved: true };
    });
  }
  /** Count-based change detection also sees transactions that commit out of sequence. */
  async fingerprints(ids: string[]) {
    const c = await this.db.connect();
    try {
      return (
        await c.query(
          `SELECT recipient.id,recipient.active,recipient.role,COUNT(n.id)::text AS total,COUNT(n.id) FILTER(WHERE n.read_at IS NULL)::text AS unread FROM app.profiles recipient LEFT JOIN app.notifications n ON n.recipient_id=recipient.id AND (${visible("recipient.id", "recipient.role")}) WHERE recipient.id=ANY($1::uuid[]) GROUP BY recipient.id,recipient.active,recipient.role`,
          [ids],
        )
      ).rows;
    } finally {
      c.release();
    }
  }
}

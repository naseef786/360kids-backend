import { transaction, type Connection, type Database } from "./database.js";
import type { Actor } from "./platform.js";
import { paginationSchema, type Pagination } from "./pagination.js";
function member(provider: string, user: string) {
  return `EXISTS(SELECT 1 FROM app.provider_memberships m JOIN app.providers org ON org.id=m.provider_id WHERE m.provider_id=${provider} AND m.user_id=${user} AND m.active AND org.status='approved')`;
}
/** All expressions passed here are server-owned SQL identifiers, never client input. */
function visible(user: string, role: string) {
  return `(n.audience='admin' AND ${role}='admin') OR (n.audience='member' AND (
 (n.kind='booking' AND EXISTS(SELECT 1 FROM app.bookings b WHERE b.id=n.subject_id AND (b.parent_id=${user} OR ${member('b.provider_id',user)}))) OR
 (n.kind='provider' AND EXISTS(SELECT 1 FROM app.providers p WHERE p.id=n.subject_id AND p.owner_id=${user})) OR
 (n.kind='activity' AND EXISTS(SELECT 1 FROM app.activities a WHERE a.id=n.subject_id AND ${member('a.provider_id',user)})) OR
 (n.kind='correction' AND EXISTS(SELECT 1 FROM app.corrections c WHERE c.id=n.subject_id AND ${member('c.provider_id',user)})) OR
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
  if (event === "refund.completed") {
    const refund = (
      await c.query("SELECT booking_id FROM app.refunds WHERE id=$1", [subject])
    ).rows[0];
    if (refund) subject = refund.booking_id;
  }
  // Fan out in SQL: neither the staff list nor the admin list is loaded into memory.
  await c.query(`WITH recipients AS (
    SELECT 'booking' AS kind,b.parent_id AS recipient_id FROM app.bookings b WHERE b.id=$1
    UNION SELECT 'booking',m.user_id FROM app.bookings b JOIN app.provider_memberships m ON m.provider_id=b.provider_id JOIN app.providers p ON p.id=m.provider_id WHERE b.id=$1 AND m.active AND p.status='approved'
    UNION SELECT 'provider',owner_id FROM app.providers WHERE id=$1
    UNION SELECT 'activity',m.user_id FROM app.activities a JOIN app.provider_memberships m ON m.provider_id=a.provider_id JOIN app.providers p ON p.id=m.provider_id WHERE a.id=$1 AND m.active AND p.status='approved'
    UNION SELECT 'correction',m.user_id FROM app.corrections c JOIN app.provider_memberships m ON m.provider_id=c.provider_id JOIN app.providers p ON p.id=m.provider_id WHERE c.id=$1 AND m.active AND p.status='approved'
    UNION SELECT 'support',owner_id FROM app.support WHERE id=$1
    UNION SELECT 'account',parent_id FROM app.children WHERE id=$1 AND $3 ~ '^(profile|child|account)\\.'
    UNION SELECT 'account',id FROM app.profiles WHERE id=$1 AND $3 ~ '^(profile|child|account)\\.'
  ), targets AS (
    SELECT recipient_id,kind,'member' AS audience FROM recipients
    UNION ALL SELECT p.id,COALESCE((SELECT kind FROM recipients LIMIT 1),'admin'),'admin'
      FROM app.profiles p WHERE p.role='admin' AND p.active
      AND $3 !~ '^(profile|child|account)\\.'
      AND NOT EXISTS(SELECT 1 FROM recipients r WHERE r.recipient_id=p.id)
  )
  INSERT INTO app.notifications(id,audit_id,recipient_id,audience,kind,subject_id,event)
    SELECT gen_random_uuid(),$2,t.recipient_id,t.audience,t.kind,$1,$3 FROM targets t
    JOIN app.profiles profile ON profile.id=t.recipient_id AND profile.active
    ON CONFLICT(audit_id,recipient_id) DO NOTHING`,[subject,auditId,event]);
}
export class NotificationService {
  constructor(readonly db: Database) {}
  async list(a: Actor, paging: Pagination = {page:1,pageSize:20}) {
    paging = paginationSchema.parse(paging);
    return transaction(this.db, async (c) => {
      const scope = visible("$1", "$2");
      const items = (
        await c.query(
          `SELECT n.id,n.sequence::text,n.kind,n.subject_id,n.event,n.created_at,n.read_at,
          CASE WHEN n.kind IN ('account','support') OR (n.kind='booking' AND EXISTS(SELECT 1 FROM app.bookings own WHERE own.id=n.subject_id AND own.parent_id=$1)) THEN 'family' WHEN n.audience='admin' THEN 'admin' ELSE 'provider' END AS workspace
          FROM app.notifications n WHERE n.recipient_id=$1 AND (${scope}) ORDER BY n.sequence DESC,n.id LIMIT $3 OFFSET $4`,
          [a.id, a.role, paging.pageSize, (paging.page-1)*paging.pageSize],
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
        page: paging.page,
        pageSize: paging.pageSize,
        pages: Math.ceil(Number(counts.total)/paging.pageSize),
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

import { NotificationService } from "./notifications.js";
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { Platform, fail, type Actor } from "./platform.js";
import { dubaiCalendarDate } from "./age.js";
const uuid = z.string().uuid();
const text = z.string().trim().min(1).max(200);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (s) =>
      !Number.isNaN(Date.parse(s)) &&
      new Date(s).toISOString().slice(0, 10) === s &&
      s <= dubaiCalendarDate(new Date()),
    "Invalid birth date",
  );
export type Authenticator = (
  token: string,
) => Promise<{ id: string; email: string }>;
export const authenticate: Authenticator = async (token) => {
  const origin = process.env.SUPABASE_URL,
    key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!origin || !key) fail(503, "Supabase authentication is not configured.");
  let response: Response;
  try {
    response = await fetch(new URL("/auth/v1/user", origin), {
      headers: { apikey: key, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    fail(503, "Sign-in verification is temporarily unavailable.");
  }
  if (response.status >= 500 || response.status === 429)
    fail(503, "Sign-in verification is temporarily unavailable.");
  if (!response.ok) fail(401, "Please sign in again.");
  let user: { id: string; email?: string };
  try {
    user = await response.json();
  } catch {
    fail(503, "Sign-in verification is temporarily unavailable.");
  }
  if (!user || typeof user !== "object")
    fail(503, "Sign-in verification is temporarily unavailable.");
  if (!uuid.safeParse(user.id).success)
    fail(503, "Sign-in verification is temporarily unavailable.");
  if (typeof user.email !== "string" || !user.email)
    fail(401, "Verified account required.");
  return { id: user.id, email: user.email };
};
export function routes(p: Platform, auth: Authenticator = authenticate) {
  const r = Router();
  const notifications = new NotificationService(p.db);
  r.get("/activities", async (_q, s) => {
    s.json(await p.catalog());
  });
  r.get("/content", async (_q, s) => s.json(await p.contents()));
  const secure: RequestHandler = async (q, s, next) => {
    try {
      const token = q.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
      if (!token) fail(401, "Sign in to continue.");
      const u = await auth(token);
      s.locals.actor = await p.me(u.id, u.email);
      next();
    } catch (e) {
      next(e);
    }
  };
  r.use(secure);
  r.use((_q, s, next) => {
    s.setHeader("Cache-Control", "no-store");
    next();
  });
  const actor = (s: { locals: Record<string, any> }) => s.locals.actor as Actor;
  const key = (q: { headers: Record<string, unknown> }) =>
    z.string().min(8).max(128).parse(q.headers["idempotency-key"]);
  r.get("/me", (_q, s) => {
    s.json(s.locals.actor);
  });
  r.get("/children", async (_q, s) => s.json(await p.children(actor(s))));
  r.post("/children", async (q, s) => {
    const b = z
      .object({ firstName: text, surname: text, birthDate: date })
      .parse(q.body);
    s.status(201).json(await p.addChild(actor(s), b));
  });
  r.get("/bookings", async (q, s) => {
    const scope = z
      .enum(["all", "family", "provider"])
      .default("all")
      .parse(q.query.scope);
    s.json(await p.bookings(actor(s), scope));
  });
  r.post("/bookings", async (q, s) => {
    const b = z
      .object({
        sessionId: uuid,
        childIds: z
          .array(uuid)
          .min(1)
          .max(10)
          .refine((x) => new Set(x).size === x.length),
        policyAccepted: z.literal(true),
      })
      .parse(q.body);
    s.status(201).json(await p.request(actor(s), key(q), b));
  });
  r.post("/bookings/:id/actions", async (q, s) => {
    const b = z
      .object({
        action: z.enum([
          "accept",
          "offer",
          "accept-offer",
          "decline",
          "proof",
          "verify",
          "cancel",
        ]),
        version: z.number().int().positive(),
        reason: z.string().trim().min(1).max(2000).optional(),
        sessionId: uuid.optional(),
        amountFils: z.number().int().positive().max(100000000).optional(),
        reference: z.string().trim().min(3).max(200).optional(),
      })
      .parse(q.body);
    s.json(await p.act(actor(s), key(q), uuid.parse(q.params.id), b));
  });
  r.get("/providers", async (_q, s) => s.json(await p.providers(actor(s))));
  r.post("/providers", async (q, s) =>
    s.status(201).json(
      await p.apply(
        actor(s),
        z
          .object({
            name: text,
            description: z.string().trim().min(10).max(4000),
          })
          .parse(q.body),
      ),
    ),
  );
  r.post("/providers/:id/review", async (q, s) => {
    const b = z
      .object({ status: z.enum(["approved", "rejected", "suspended"]) })
      .parse(q.body);
    s.json(await p.approve(actor(s), uuid.parse(q.params.id), b.status));
  });
  r.post("/activities", async (q, s) => {
    const b = z
      .object({
        providerId: uuid,
        title: text,
        description: z.string().min(10).max(8000),
        category: text,
        area: text,
        minAge: z.number().int().min(0).max(18),
        maxAge: z.number().int().min(0).max(18),
        priceFils: z.number().int().positive().max(10000000),
        policy: z.string().min(10).max(8000),
        published: z.boolean(),
        startsAt: z.string().datetime(),
        cutoffAt: z.string().datetime(),
        capacity: z.number().int().min(1).max(10000),
      })
      .refine(
        (b) =>
          b.maxAge >= b.minAge &&
          Date.parse(b.cutoffAt) < Date.parse(b.startsAt) &&
          Date.parse(b.cutoffAt) > Date.now(),
      )
      .parse(q.body);
    s.status(201).json(await p.createActivity(actor(s), b));
  });
  r.post("/admin/refunds/:id/complete", async (q, s) => {
    const b = z
      .object({ reference: z.string().trim().min(5).max(500) })
      .parse(q.body);
    s.json(
      await p.completeRefund(actor(s), uuid.parse(q.params.id), b.reference),
    );
  });
  r.post("/activities/:id/corrections", async (q, s) => {
    const b = z
      .object({ message: z.string().trim().min(10).max(4000) })
      .parse(q.body);
    s.status(201).json(
      await p.correction(actor(s), uuid.parse(q.params.id), b.message),
    );
  });
  r.get("/admin/operations", async (_q, s) =>
    s.json(await p.operations(actor(s))),
  );
  r.post("/admin/contacts/import", async (q, s) => {
    const b = z
      .object({
        rows: z.array(z.object({ phone: text, name: text })).max(1000),
        source: text,
        commit: z.boolean().default(false),
      })
      .parse(q.body);
    s.json(await p.importContacts(actor(s), b.rows, b.source, b.commit));
  });
  r.post("/admin/contacts/:id/suppress", async (q, s) =>
    s.json(await p.suppress(actor(s), uuid.parse(q.params.id))),
  );
  r.post("/admin/campaigns", async (q, s) =>
    s.status(201).json(
      await p.campaign(
        actor(s),
        z
          .object({
            name: text,
            template: text,
            language: z.string().min(2).max(20),
          })
          .parse(q.body),
      ),
    ),
  );

  r.post("/me", async (q, s) => {
    const b = z.object({ displayName: text }).parse(q.body);
    s.json(await p.updateProfile(actor(s), b.displayName));
  });
  r.post("/me/deletion-request", async (_q, s) =>
    s.json(await p.requestDeletion(actor(s))),
  );
  r.post("/children/:id/update", async (q, s) => {
    const b = z
      .object({ firstName: text, surname: text, birthDate: date })
      .parse(q.body);
    s.json(await p.updateChild(actor(s), uuid.parse(q.params.id), b));
  });
  r.post("/children/:id/archive", async (q, s) =>
    s.json(await p.updateChild(actor(s), uuid.parse(q.params.id), null)),
  );
  r.get("/manage/activities", async (_q, s) =>
    s.json(await p.managementCatalog(actor(s))),
  );
  r.post("/activities/:id/update", async (q, s) => {
    const b = z
      .object({
        version: z.number().int().positive(),
        title: text,
        description: z.string().min(10).max(8000),
        category: text,
        area: text,
        minAge: z.number().int().min(0).max(18),
        maxAge: z.number().int().min(0).max(18),
        priceFils: z.number().int().positive().max(10000000),
        policy: z.string().min(10).max(8000),
        published: z.boolean(),
      })
      .refine((b) => b.maxAge >= b.minAge)
      .parse(q.body);
    s.json(await p.editActivity(actor(s), uuid.parse(q.params.id), b));
  });
  r.post("/activities/:id/sessions", async (q, s) => {
    const b = z
      .object({
        startsAt: z.string().datetime(),
        cutoffAt: z.string().datetime(),
        capacity: z.number().int().min(1).max(10000),
      })
      .refine(
        (b) =>
          Date.parse(b.cutoffAt) > Date.now() &&
          Date.parse(b.cutoffAt) < Date.parse(b.startsAt),
      )
      .parse(q.body);
    s.status(201).json(
      await p.addSession(actor(s), uuid.parse(q.params.id), b),
    );
  });
  r.get("/corrections", async (_q, s) => s.json(await p.corrections(actor(s))));
  r.post("/corrections/:id/review", async (q, s) => {
    const b = z
      .object({
        status: z.enum(["resolved", "rejected"]),
        note: z.string().trim().min(5).max(2000),
      })
      .parse(q.body);
    s.json(
      await p.reviewCorrection(
        actor(s),
        uuid.parse(q.params.id),
        b.status,
        b.note,
      ),
    );
  });
  r.get("/manage/content", async (_q, s) => {
    p.admin(actor(s));
    s.json(await p.contents(actor(s)));
  });
  r.post("/manage/content/:slug", async (q, s) => {
    const slug = z
      .enum(["about", "contact", "faq", "terms", "privacy"])
      .parse(q.params.slug);
    const b = z
      .object({
        title: text,
        body: z.string().trim().min(10).max(20000),
        published: z.boolean(),
        version: z.number().int().positive(),
      })
      .parse(q.body);
    s.json(await p.saveContent(actor(s), slug, b));
  });
  r.get("/support", async (_q, s) => s.json(await p.tickets(actor(s))));
  r.post("/support", async (q, s) => {
    const b = z
      .object({ topic: text, message: z.string().trim().min(10).max(4000) })
      .parse(q.body);
    s.status(201).json(await p.ticket(actor(s), b.topic, b.message));
  });
  r.post("/support/:id/reply", async (q, s) => {
    const b = z
      .object({
        status: z.enum(["open", "in_progress", "resolved"]),
        reply: z.string().trim().min(5).max(4000),
      })
      .parse(q.body);
    s.json(
      await p.replyTicket(actor(s), uuid.parse(q.params.id), b.status, b.reply),
    );
  });
  r.get("/bookings/:id/history", async (q, s) =>
    s.json(await p.history(actor(s), uuid.parse(q.params.id))),
  );

  r.get("/notifications", async (q, s) => {
    const before = z
      .string()
      .regex(/^[1-9][0-9]{0,17}$/)
      .optional()
      .parse(q.query.before);
    s.json(await notifications.list(actor(s), before));
  });
  r.post("/notifications/read", async (q, s) => {
    const b = z
      .union([
        z.object({ all: z.literal(true) }),
        z.object({ ids: z.array(uuid).min(1).max(100) }),
      ])
      .parse(q.body);
    s.json(await notifications.markRead(actor(s), "all" in b ? null : b.ids));
  });
  return r;
}

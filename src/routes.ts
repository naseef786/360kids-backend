import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { Platform, fail, type Actor } from "./platform.js";
import { paginationSchema } from "./pagination.js";
import { dubaiDate } from "./eligibility.js";
import { NotificationService } from "./notifications.js";
const uuid = z.string().uuid();
const text = z.string().trim().min(1).max(200);
const optionalFilter = z
  .string()
  .trim()
  .max(100)
  .optional()
  .transform((value) => value || undefined);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (s) =>
      !Number.isNaN(Date.parse(s)) &&
      new Date(s).toISOString().slice(0, 10) === s &&
      s <= dubaiDate(),
    "Invalid birth date",
  );
const childProfile = z
  .object({
    firstName: text,
    surname: text.optional(),
    birthDate: date.optional(),
    ageYears: z.number().int().min(0).max(17).optional(),
  })
  .strict()
  .refine(
    (body) => (body.birthDate !== undefined) !== (body.ageYears !== undefined),
    "Provide either an age or a birth date.",
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
    response = await fetch(`${origin.replace(/\/$/, "")}/auth/v1/user`, {
      headers: { apikey: key, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    fail(503, "Authentication service is temporarily unavailable.");
  }
  if (response.status === 401 || response.status === 403)
    fail(401, "Please sign in again.");
  if (!response.ok)
    fail(503, "Authentication service is temporarily unavailable.");
  try {
    return z
      .object({ id: uuid, email: z.string().email() })
      .parse(await response.json());
  } catch {
    fail(503, "Authentication service returned an invalid response.");
  }
};
export function routes(p: Platform, auth: Authenticator = authenticate) {
  const r = Router();
  // Catalogue responses may include the signed-in family's saved state.
  r.use((_q,s,next) => { s.setHeader("Cache-Control","private, no-store"); next(); });
  const catalogueActor = async (authorization?: string): Promise<Actor> => {
    if(!authorization) return {id:"",role:"public"};
    const token = authorization.match(/^Bearer (.+)$/)?.[1];
    if(!token) fail(401,"Sign in to continue.");
    const user = await auth(token);
    return p.me(user.id,user.email);
  };
  const slug = z.enum(["about","contact","faq","terms","privacy"]);
  r.get("/content/:slug", async(q,s) => s.json(await p.content(slug.parse(q.params.slug))));
  r.get("/activities", async (q, s) => {
    const filters = paginationSchema
      .extend({
        q: optionalFilter,
        category: optionalFilter,
        area: optionalFilter,
        age: z.preprocess(
          (value) => (value === "" ? undefined : value),
          z.coerce.number().int().min(0).max(18).optional(),
        ),
      })
      .strict()
      .parse(q.query);
    s.json(
      await p.list("activities", await catalogueActor(q.headers.authorization), filters, filters),
    );
  });
  r.get("/activities/:id", async (q, s) =>
    s.json(await p.activity(uuid.parse(q.params.id), await catalogueActor(q.headers.authorization))),
  );
  r.get("/activities/:id/sessions", async (q, s) =>
    s.json(
      await p.list(
        "sessions",
        { id: "", role: "public" },
        paginationSchema.strict().parse(q.query),
        { activityId: uuid.parse(q.params.id) },
      ),
    ),
  );
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
  r.use((_q, s, next) => {
    s.setHeader("Cache-Control", "no-store");
    next();
  });
  r.use(secure);
  const actor = (s: { locals: Record<string, any> }) => s.locals.actor as Actor;
  const key = (q: { headers: Record<string, unknown> }) =>
    z.string().min(8).max(128).parse(q.headers["idempotency-key"]);
  r.get("/me", (_q, s) => {
    s.json(s.locals.actor);
  });
  const paging = (query: unknown) => paginationSchema.strict().parse(query);
  const notifications = new NotificationService(p.db);
  r.get("/notifications", async(q,s) => s.json(await notifications.list(actor(s),paging(q.query))));
  r.post("/notifications/read", async(q,s) => {
    const body = z.union([
      z.object({all:z.literal(true)}).strict(),
      z.object({ids:z.array(uuid).min(1).max(100)}).strict(),
    ]).parse(q.body);
    s.json(await notifications.markRead(actor(s),'all' in body ? null : body.ids));
  });
  r.get("/support", async(q,s) => {
    const query = paginationSchema.extend({status:z.enum(["open","in_progress","resolved"]).optional()}).strict().parse(q.query);
    s.json(await p.support(actor(s),query,query.status));
  });
  r.post("/support", async(q,s) => {
    const body = z.object({topic:text,message:z.string().trim().min(10).max(4000)}).strict().parse(q.body);
    s.status(201).json(await p.createSupport(actor(s),body.topic,body.message));
  });
  r.put("/support/:id", async(q,s) => {
    const body = z.object({status:z.enum(["open","in_progress","resolved"]),reply:z.string().trim().min(1).max(4000)}).strict().parse(q.body);
    s.json(await p.replySupport(actor(s),uuid.parse(q.params.id),body.status,body.reply));
  });
  r.get("/manage/content/:slug", async(q,s) => {
    if(actor(s).role !== "admin") fail(403,"Administrator access required.");
    s.json(await p.content(slug.parse(q.params.slug),actor(s)));
  });
  r.put("/manage/content/:slug", async(q,s) => {
    const body = z.object({title:text,body:z.string().trim().min(1).max(12000),published:z.boolean(),version:z.number().int().nonnegative()}).strict().parse(q.body);
    s.json(await p.saveContent(actor(s),slug.parse(q.params.slug),body));
  });
  r.get("/children", async (q, s) =>
    s.json(await p.list("children", actor(s), paging(q.query))),
  );
  r.get("/saved", async (q, s) =>
    s.json(await p.list("saved", actor(s), paging(q.query))),
  );
  r.put("/saved/:id", async (q, s) =>
    s.json(
      await p.save(
        actor(s),
        uuid.parse(q.params.id),
        z.object({ saved: z.boolean() }).strict().parse(q.body).saved,
      ),
    ),
  );
  r.get("/managed-activities", async (q, s) =>
    s.json(await p.list("managed-activities", actor(s), paging(q.query))),
  );
  r.put("/activities/:id/publication", async (q, s) =>
    s.json(
      await p.publishActivity(
        actor(s),
        uuid.parse(q.params.id),
        z.object({ published: z.boolean() }).strict().parse(q.body).published,
      ),
    ),
  );
  r.put("/activities/:id", async (q, s) => {
    const body = z
      .object({
        title: text,
        description: z.string().trim().min(10).max(8000),
        category: text,
        area: text,
        minAge: z.number().int().min(0).max(18),
        maxAge: z.number().int().min(0).max(18),
        priceFils: z.number().int().positive().max(10000000),
        policy: z.string().trim().min(10).max(8000),
      })
      .strict()
      .refine((b) => b.maxAge >= b.minAge)
      .parse(q.body);
    s.json(await p.updateActivity(actor(s), uuid.parse(q.params.id), body));
  });
  r.post("/activities/:id/sessions", async (q, s) => {
    const body = z
      .object({
        startsAt: z.string().datetime(),
        cutoffAt: z.string().datetime(),
        capacity: z.number().int().min(1).max(10000),
      })
      .strict()
      .refine(
        (b) =>
          Date.parse(b.cutoffAt) > Date.now() &&
          Date.parse(b.startsAt) > Date.parse(b.cutoffAt),
      )
      .parse(q.body);
    s.status(201).json(
      await p.addSession(actor(s), uuid.parse(q.params.id), body),
    );
  });
  r.post("/admin/corrections/:id/review", async (q, s) => {
    const body = z
      .object({
        status: z.enum(["resolved", "rejected"]),
        reason: z.string().trim().min(1).max(2000),
      })
      .strict()
      .parse(q.body);
    s.json(
      await p.reviewCorrection(
        actor(s),
        uuid.parse(q.params.id),
        body.status,
        body.reason,
      ),
    );
  });
  r.post("/children", async (q, s) => {
    const b = childProfile.parse(q.body);
    s.status(201).json(await p.addChild(actor(s), b));
  });
  r.put("/children/:id", async (q, s) =>
    s.json(
      await p.updateChild(
        actor(s),
        uuid.parse(q.params.id),
        childProfile.parse(q.body),
      ),
    ),
  );
  r.get("/bookings", async (q, s) => {
    const query = paginationSchema
      .extend({
        scope: z.enum(["all", "parent", "partner"]).default("all"),
        state: z
          .enum([
            "REQUESTED",
            "OFFER_PENDING",
            "PAYMENT_DUE",
            "PAYMENT_CHECKING",
            "CONFIRMED",
            "DECLINED",
            "EXPIRED",
            "CANCELLED",
          ])
          .optional(),
      })
      .strict()
      .parse(q.query);
    s.json(await p.list("bookings", actor(s), query, query));
  });
  r.get("/bookings/:id", async (q, s) =>
    s.json(await p.booking(actor(s), uuid.parse(q.params.id))),
  );
  r.post("/bookings", async (q, s) => {
    const b = z
      .object({
        sessionId: uuid,
        activityVersion: z.number().int().positive(),
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
        amountFils: z.number().int().positive().max(100000000).optional(),
        reference: z.string().trim().min(3).max(200).optional(),
      })
      .parse(q.body);
    s.json(await p.act(actor(s), key(q), uuid.parse(q.params.id), b));
  });
  r.get("/providers", async (q, s) => {
    const query = paginationSchema
      .extend({
        status: z
          .enum(["pending", "approved", "rejected", "suspended"])
          .optional(),
        owned: z
          .enum(["true", "false"])
          .optional()
          .transform((value) => value === "true"),
      })
      .strict()
      .parse(q.query);
    s.json(await p.list("providers", actor(s), query, query));
  });
  r.get("/providers/:id/members", async (q, s) =>
    s.json(
      await p.list("members", actor(s), paging(q.query), {
        providerId: uuid.parse(q.params.id),
      }),
    ),
  );
  r.post("/providers/:id/members", async (q, s) => {
    const body = z
      .object({ userId: uuid, role: z.literal("staff"), active: z.boolean() })
      .strict()
      .parse(q.body);
    s.json(
      await p.setMember(
        actor(s),
        uuid.parse(q.params.id),
        body.userId,
        body.active,
      ),
    );
  });
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
      .object({
        status: z.enum(["approved", "rejected", "suspended"]),
        reason: z.string().trim().min(1).max(2000).optional(),
      })
      .parse(q.body);
    s.json(
      await p.approve(actor(s), uuid.parse(q.params.id), b.status, b.reason),
    );
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
  r.get("/admin/lists/:resource", async (q, s) => {
    const resource = z
      .enum([
        "audit",
        "refunds",
        "contacts",
        "campaigns",
        "subscriptions",
        "corrections",
      ])
      .parse(q.params.resource);
    s.json(await p.list(resource, actor(s), paging(q.query)));
  });
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
  return r;
}

import express from "express";
import cors from "cors";
import helmet from "helmet";
import type { ErrorRequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { ZodError } from "zod";
import { Platform } from "./platform.js";
import { database } from "./database.js";
import { routes, type Authenticator } from "./routes.js";
import { stripeTestConfig } from "./stripe-test.js";
import { StripeCheckout } from "./stripe-checkout.js";
export function createApp(
  webOrigin: string,
  platform?: Platform,
  auth?: Authenticator,
  checkout?: StripeCheckout,
) {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: webOrigin }));
  app.use(
    "/v1",
    rateLimit({
      windowMs: 60000,
      limit: 120,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );
  // The web BFF shares an upstream IP; keep this as a coarse flood guard.
  // Per-visitor distributed limits belong at the trusted web/edge boundary.
  app.use("/v1/contact",rateLimit({windowMs:60000,limit:60,standardHeaders:"draft-8",legacyHeaders:false}));
  app.use(express.json({ limit: "32kb" }));
  // Liveness only: this does not assert database or integration readiness.
  app.get("/health/live", (_req, res) =>
    res.json({ status: "ok", service: "360kids-backend" }),
  );
  let service = platform;
  let router: ReturnType<typeof routes> | undefined;
  app.get("/v1/status", async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const authenticationConfigured = Boolean(auth ||
      (process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY));
    let bookingsAvailable = false;
    try {
      if (process.env.DATABASE_URL || service) {
        service ??= new Platform(database(), process.env.FINANCE_WORKFLOW_ENABLED === "true");
        bookingsAvailable = authenticationConfigured && await service.ready();
      }
    } catch { /* A configured but unavailable database is not a working booking service. */ }
    let stripeTestEnabled = false;
    try { stripeTestEnabled = bookingsAvailable && stripeTestConfig().enabled; }
    catch { /* Invalid configuration fails closed. */ }
    res.json({
      version: "0.1.0",
      stage: "development",
      bookingsAvailable,
      financeEnabled: bookingsAvailable && Boolean(service?.financeEnabled),
      stripeTestEnabled,
      whatsappSendingAvailable: false,
      financeWorkflowEnabled: process.env.FINANCE_WORKFLOW_ENABLED === "true",
    });
  });
  app.get("/health/ready", async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const authenticationConfigured = Boolean(
      auth ||
      (process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY),
    );
    try {
      service ??= new Platform(
        database(),
        process.env.FINANCE_WORKFLOW_ENABLED === "true",
      );
      if (!(await service.ready())) throw new Error("Schema is not ready");
      res.status(authenticationConfigured ? 200 : 503).json({
        status: authenticationConfigured ? "ready" : "not_ready",
        database: true,
        authenticationConfigured,
      });
    } catch {
      res
        .status(503)
        .json({
          status: "not_ready",
          database: false,
          authenticationConfigured,
        });
    }
  });
  app.use("/v1", (req, res, next) => {
    try {
      service ??= new Platform(
        database(),
        process.env.FINANCE_WORKFLOW_ENABLED === "true",
      );
      router ??= routes(service, auth, checkout);
      router(req, res, next);
    } catch (e) {
      next(e);
    }
  });
  app.use((_req, res) =>
    res.status(404).json({ code: "NOT_FOUND", message: "Route not found." }),
  );
  const handleError: ErrorRequestHandler = (
    error: unknown,
    _req,
    res,
    _next,
  ) => {
    if (error instanceof ZodError) {
      res.status(422).json({
        code: "VALIDATION_ERROR",
        message: error.issues.map((x) => x.message).join(" "),
      });
      return;
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505"
    ) {
      res.status(409).json({
        code: "CONFLICT",
        message: "A matching active record already exists.",
      });
      return;
    }
    const status =
      typeof error === "object" && error !== null && "status" in error
        ? error.status
        : undefined;
    if (status === 400 || status === 413) {
      res.status(status).json({
        code: "INVALID_REQUEST",
        message:
          status === 413
            ? "Request body is too large."
            : "Invalid request body.",
      });
      return;
    }
    if (
      typeof status === "number" &&
      [401, 403, 404, 409, 422, 503].includes(status)
    ) {
      res.status(status).json({
        code: "REQUEST_FAILED",
        message: error instanceof Error ? error.message : "Request failed.",
      });
      return;
    }
    res.status(500).json({
      code: "INTERNAL_ERROR",
      message: "Unable to process the request.",
    });
  };
  app.use(handleError);
  return app;
}

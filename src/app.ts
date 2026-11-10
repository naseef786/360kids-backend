import express from "express";
import cors from "cors";
import helmet from "helmet";
import type { ErrorRequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { ZodError } from "zod";
import { Platform } from "./platform.js";
import { database } from "./database.js";
import { routes, type Authenticator } from "./routes.js";
export function createApp(
  webOrigin: string,
  platform?: Platform,
  auth?: Authenticator,
) {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: webOrigin }));
  app.use(["/v1", "/health/ready"], (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(
    "/v1",
    rateLimit({
      windowMs: 60000,
      limit: 120,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );
  app.use(express.json({ limit: "32kb" }));
  // Liveness only: this does not assert database or integration readiness.
  app.get("/health/live", (_req, res) =>
    res.json({ status: "ok", service: "360kids-backend" }),
  );
  let service = platform;
  let router = platform ? routes(platform, auth) : undefined;
  const getService = () =>
    (service ??= new Platform(
      database(),
      process.env.FINANCE_WORKFLOW_ENABLED === "true",
    ));
  let probe:
    | {
        until: number;
        result: Promise<{ database: boolean; authentication: boolean }>;
      }
    | undefined;
  const readiness = () => {
    if (!probe || probe.until <= Date.now()) {
      const result = (async () => {
        let ready = false;
        try {
          ready = await getService().ready();
        } catch {
          /* Never reveal database errors publicly. */
        }
        return {
          database: ready,
          authentication: Boolean(
            auth ||
              (process.env.SUPABASE_URL &&
                process.env.SUPABASE_PUBLISHABLE_KEY),
          ),
        };
      })();
      // Keep concurrent health calls on the same in-flight database query.
      // The cache window starts after completion, including connection failures.
      const entry = { until: Infinity, result };
      probe = entry;
      void result.then(() => {
        entry.until = Date.now() + 2000;
      });
    }
    return probe.result;
  };
  app.get("/health/ready", async (_req, res) => {
    const checks = await readiness(),
      ready = checks.database && checks.authentication;
    res
      .status(ready ? 200 : 503)
      .json({ status: ready ? "ready" : "not_ready", checks });
  });
  app.get("/v1/status", async (_req, res) => {
    const checks = await readiness(),
      ready = checks.database && checks.authentication;
    res.json({
      version: "0.1.0",
      stage:
        process.env.NODE_ENV === "production" ? "production" : "development",
      bookingsAvailable: ready,
      financeEnabled: ready && Boolean(service?.financeEnabled),
      whatsappSendingAvailable: false,
    });
  });
  app.use("/v1", async (req, res, next) => {
    try {
      if (!(await readiness()).database) {
        res
          .status(503)
          .json({
            code: "SERVICE_UNAVAILABLE",
            message: "Database setup is not ready. Please try again later.",
          });
        return;
      }
      router ??= routes(getService(), auth);
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
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";
    if (
      /^(08|53|57)/.test(code) ||
      [
        "ECONNREFUSED",
        "ECONNRESET",
        "ETIMEDOUT",
        "EAI_AGAIN",
        "ENOTFOUND",
        "42P01",
        "42703",
      ].includes(code)
    ) {
      res.status(503).json({
        code: "SERVICE_UNAVAILABLE",
        message:
          "The database service is temporarily unavailable. Please try again.",
      });
      return;
    }
    if (["40001", "40P01"].includes(code)) {
      res.status(409).json({
        code: "CONFLICT",
        message:
          "Another operation changed this request. Refresh and try again.",
      });
      return;
    }
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
        message:
          "constraint" in error && error.constraint === "active_child_session"
            ? "A selected child already has an active request for this session. Check your bookings."
            : "A matching active record already exists.",
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

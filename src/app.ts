import express from "express";
import cors from "cors";
import helmet from "helmet";
import type { ErrorRequestHandler } from "express";
export function createApp(webOrigin: string) {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: webOrigin }));
  app.use(express.json({ limit: "32kb" }));
  // Liveness only: this does not assert database or integration readiness.
  app.get("/health/live", (_req, res) => res.json({ status: "ok", service: "360kids-backend" }));
  app.get("/v1/status", (_req, res) => res.json({ version: "0.1.0", stage: "scaffold", bookingsAvailable: false, whatsappSendingAvailable: false }));
  app.use((_req, res) => res.status(404).json({ code: "NOT_FOUND", message: "Route not found." }));
  const handleError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
    if (status === 400 || status === 413) {
      res.status(status).json({ code: "INVALID_REQUEST", message: status === 413 ? "Request body is too large." : "Invalid request body." });
      return;
    }
    res.status(500).json({ code: "INTERNAL_ERROR", message: "Unable to process the request." });
  };
  app.use(handleError);
  return app;
}

import "dotenv/config";
import { createServer } from "node:http";
import { createApp } from "../src/app.js";
import { database } from "../src/database.js";
import { Platform } from "../src/platform.js";

// Local catalogue/UI verification only. No authenticated or mutating routes.
const db = database();
const app = createApp("http://127.0.0.1:3000", new Platform(db, false));
const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (request.method !== "GET" || !(["/health/live", "/health/ready", "/v1/status", "/v1/activities"].includes(path) || path.startsWith("/v1/content/"))) {
    response.writeHead(405, {"Content-Type":"application/json"});
    response.end('{"message":"Read-only preview route."}');
    return;
  }
  app(request, response);
});
server.listen(4000, "127.0.0.1", () => console.log("Read-only API preview listening on loopback port 4000."));
process.once("SIGINT", () => server.close(() => void db.end?.()));
process.once("SIGTERM", () => server.close(() => void db.end?.()));

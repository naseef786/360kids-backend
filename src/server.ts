import "dotenv/config";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { database } from "./database.js";
import { Platform } from "./platform.js";
import { attachRealtime } from "./realtime.js";
const db = process.env.DATABASE_URL ? database() : undefined;
const platform = db
  ? new Platform(db, process.env.FINANCE_WORKFLOW_ENABLED === "true")
  : undefined;
const server = createServer(createApp(config.WEB_ORIGIN, platform));
const realtime = attachRealtime(server, platform, {
  origin: config.WEB_ORIGIN,
});
server.listen(config.PORT, () =>
  console.log(`360 Kids API listening on port ${config.PORT}`),
);
server.on("error", (error: NodeJS.ErrnoException) => {
  console.error(`Server failed to start (${error.code ?? "unknown"}).`);
  process.exitCode = 1;
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const timer = setTimeout(() => process.exit(1), 10000);
  timer.unref();
  try {
    await realtime.close();
    await db?.end?.();
    clearTimeout(timer);
    process.exit(0);
  } catch {
    process.exit(1);
  }
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

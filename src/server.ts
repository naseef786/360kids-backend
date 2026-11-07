import "dotenv/config";
import { createApp } from "./app.js";
import { config } from "./config.js";
const server = createApp(config.WEB_ORIGIN).listen(config.PORT, () => {
  console.log(`360 Kids API listening on port ${config.PORT}`);
});
server.on("error", (error: NodeJS.ErrnoException) => {
  console.error(`Server failed to start (${error.code ?? "unknown"}).`);
  process.exitCode = 1;
});
function shutdown() {
  const timer = setTimeout(() => process.exit(1), 10000);
  timer.unref();
  server.close(() => { clearTimeout(timer); process.exit(0); });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

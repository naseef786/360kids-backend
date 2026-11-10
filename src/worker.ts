import "dotenv/config";
import { database } from "./database.js";
import { Platform } from "./platform.js";
const service = new Platform(database());
async function run() {
  try {
    await service.expire();
  } catch {
    console.error("Expiry sweep failed; check database connectivity.");
  } finally {
    setTimeout(run, 30000);
  }
}
void run();

// Temporary loopback-only simulation. Never included in the production build.
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { createApp } from "../src/app.js";
import { Platform, fail } from "../src/platform.js";
import { database } from "../src/database.js";
import { authenticate } from "../src/routes.js";
if (
  process.env.NODE_ENV === "production" ||
  !process.argv.includes("--development-only")
)
  throw new Error("This simulation is development-only.");
const fixture = JSON.parse(
  await readFile(new URL("../.e2e-accounts.json", import.meta.url), "utf8"),
);
const allowed = new Set(
  Object.values(fixture.accounts).map((value) => (value as { id: string }).id),
);
process.env.FINANCE_WORKFLOW_ENABLED = "true";
const app = createApp(
  "http://localhost:3100",
  new Platform(database(), true),
  async (token) => {
    const identity = await authenticate(token);
    if (!allowed.has(identity.id))
      fail(403, "Only synthetic fixture accounts may use this simulation.");
    return identity;
  },
);
const server = app.listen(4100, "127.0.0.1", () =>
  console.log(
    "Synthetic confirmation/refund simulation listening on loopback port 4100.",
  ),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => server.close(() => process.exit(0)));

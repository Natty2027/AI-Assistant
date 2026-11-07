/**
 * Server entrypoint. `npm start` (Railway runs this).
 *
 * Boots without a database or AI key — /health reports what's missing — so a first deploy
 * can be verified before every secret is in place.
 */
import { createServer } from "node:http";
import { config } from "./config.ts";
import { closePool } from "./db.ts";
import { buildRouter } from "./routes.ts";

// moderation.ts posts its content-free safety events to process.env.INTERNAL_API directly.
process.env.INTERNAL_API ??= config.internalApi;

if (config.devUserId && process.env.RAILWAY_ENVIRONMENT) {
  // DEV_USER_ID makes every request that user. Refuse to run that way on a public host.
  console.error("[boot] DEV_USER_ID is set on Railway; refusing to start. Use TEST_ACCESS_TOKEN + TEST_USER_ID.");
  process.exit(1);
}

if (config.testAccessToken && config.testAccessToken.length < 32) {
  // The test token is the only thing between the public internet and a user's data.
  console.error("[boot] TEST_ACCESS_TOKEN must be at least 32 characters. Refusing to start.");
  process.exit(1);
}

const router = buildRouter();
const server = createServer((req, res) => {
  router.handle(req, res).catch((e) => {
    console.error("[unhandled]", e instanceof Error ? e.message : e);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal error" }));
  });
});

server.listen(config.port, "0.0.0.0", () => {
  console.log(`cyber-companion api listening on :${config.port}`);
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    server.close(async () => { await closePool(); process.exit(0); });
  });
}

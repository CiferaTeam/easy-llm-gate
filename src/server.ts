import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { admin } from "./routes/admin.js";
import { proxy } from "./routes/proxy.js";
import "./db.js"; // ensure SQLite is initialized on startup
import { connectRedis } from "./redis.js";
import { startStats } from "./stats.js";
import { startPromptCache } from "./prompt-cache.js";
import { startRateLimiter } from "./rate-limiter.js";

const app = new Hono();

const PORT = Number(process.env.PORT) || 16890;

// CORS for dev (Vite runs on 16891)
app.use("/*", cors({ origin: "http://localhost:16891" }));

// Health check
app.get("/health", (c) => c.json({ status: "ok", service: "llm-rate-gate" }));

// Mount routes
app.route("/api", admin);
app.route("/v1", proxy);

// Start server
async function main() {
  await connectRedis();
  startStats();
  startPromptCache();
  startRateLimiter();

  serve({ fetch: app.fetch, hostname: "0.0.0.0", port: PORT }, () => {
    console.log(`[llm-rate-gate] listening on http://0.0.0.0:${PORT}`);
    console.log(`  AI API:    http://0.0.0.0:${PORT}/v1/`);
    console.log(`  Admin API: http://0.0.0.0:${PORT}/api/`);
  });
}

main().catch((err) => {
  console.error("[llm-rate-gate] failed to start:", err);
  process.exit(1);
});

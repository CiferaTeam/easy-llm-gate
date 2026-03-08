import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { admin } from "./routes/admin.js";
import { proxy } from "./routes/proxy.js";
import "./db.js"; // ensure SQLite is initialized on startup
import { connectRedis } from "./redis.js";
import { startStats } from "./stats.js";
import { startPromptCache } from "./prompt-cache.js";

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

  serve({ fetch: app.fetch, port: PORT }, () => {
    console.log(`[llm-rate-gate] listening on http://localhost:${PORT}`);
    console.log(`  AI API:    http://localhost:${PORT}/v1/`);
    console.log(`  Admin API: http://localhost:${PORT}/api/`);
  });
}

main().catch((err) => {
  console.error("[llm-rate-gate] failed to start:", err);
  process.exit(1);
});

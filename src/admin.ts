import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { cors } from "hono/cors";

const app = new Hono();

const ADMIN_PORT = Number(process.env.ADMIN_PORT) || 16891;

// CORS for dev (Vite runs on 5173)
app.use("/api/*", cors({ origin: "http://localhost:5173" }));

// Health check
app.get("/api/health", (c) =>
  c.json({ status: "ok", service: "admin" })
);

// Placeholder management APIs
app.get("/api/providers", (c) => c.json([]));
app.get("/api/upstream-keys", (c) => c.json([]));
app.get("/api/downstream-keys", (c) => c.json([]));
app.get("/api/stats/overview", (c) =>
  c.json({
    total_requests: 0,
    success: 0,
    failed: 0,
    queued: 0,
  })
);

// Serve built frontend (production)
app.use("/*", serveStatic({ root: "./web/dist" }));

// SPA fallback
app.get("*", (c) =>
  c.html("<h1>LLM Rate Gate Admin</h1><p>Run <code>npm run build:web</code> first, or use dev mode on port 5173.</p>")
);

serve({ fetch: app.fetch, port: ADMIN_PORT }, () => {
  console.log(`[admin] listening on http://localhost:${ADMIN_PORT}`);
});

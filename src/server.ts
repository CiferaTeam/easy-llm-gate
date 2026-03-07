import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";

const app = new Hono();

const PORT = Number(process.env.PORT) || 16890;

// CORS for dev (Vite runs on 16891)
app.use("/api/*", cors({ origin: "http://localhost:16891" }));

// ── Health check ──────────────────────────────────────────
app.get("/health", (c) => c.json({ status: "ok", service: "llm-rate-gate" }));

// ── Admin API (/api/*) ────────────────────────────────────
app.get("/api/health", (c) =>
  c.json({ status: "ok", service: "admin" })
);

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

// ── AI Proxy API (/v1/*) ──────────────────────────────────
app.get("/v1/models", (c) =>
  c.json({
    object: "list",
    data: [],
  })
);

app.post("/v1/chat/completions", (c) =>
  c.json({ message: "LLM Rate Gate proxy — not yet implemented" }, 501)
);

app.post("/v1/completions", (c) =>
  c.json({ message: "LLM Rate Gate proxy — not yet implemented" }, 501)
);

app.post("/v1/embeddings", (c) =>
  c.json({ message: "LLM Rate Gate proxy — not yet implemented" }, 501)
);

app.post("/v1/messages", (c) =>
  c.json({ message: "LLM Rate Gate proxy — not yet implemented" }, 501)
);

// ── Start server ──────────────────────────────────────────
serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`[llm-rate-gate] listening on http://localhost:${PORT}`);
  console.log(`  AI API:    http://localhost:${PORT}/v1/`);
  console.log(`  Admin API: http://localhost:${PORT}/api/`);
});

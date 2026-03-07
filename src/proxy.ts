import { Hono } from "hono";
import { serve } from "@hono/node-server";

const app = new Hono();

const PROXY_PORT = Number(process.env.PROXY_PORT) || 16890;

// Health check
app.get("/health", (c) => c.json({ status: "ok", service: "proxy" }));

// OpenAI-compatible placeholder
app.get("/v1/models", (c) =>
  c.json({
    object: "list",
    data: [],
  })
);

app.post("/v1/chat/completions", (c) =>
  c.json({ message: "LLM Rate Gate proxy — not yet implemented" }, 501)
);

// Catch-all
app.all("*", (c) =>
  c.json({ message: "LLM Rate Gate proxy is running" })
);

serve({ fetch: app.fetch, port: PROXY_PORT }, () => {
  console.log(`[proxy] listening on http://localhost:${PROXY_PORT}`);
});

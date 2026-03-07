import { Hono } from "hono";
import {
  getProviders,
  getProvider,
  addProvider,
  deleteProvider,
  getUpstreamKeys,
  getUpstreamKey,
  addUpstreamKey,
  deleteUpstreamKey,
  maskKey,
} from "../store.js";

const admin = new Hono();

// ── Health ──
admin.get("/health", (c) => c.json({ status: "ok", service: "admin" }));

// ── Providers ──
admin.get("/providers", (c) => c.json(getProviders()));

admin.post("/providers", async (c) => {
  const body = await c.req.json();
  if (!body.name || !body.base_url) {
    return c.json({ error: "name and base_url are required" }, 400);
  }
  const p = addProvider({
    name: body.name,
    type: body.type,
    base_url: body.base_url,
  });
  return c.json(p, 201);
});

admin.delete("/providers/:id", (c) => {
  const ok = deleteProvider(c.req.param("id"));
  return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});

// ── Upstream Keys ──
admin.get("/upstream-keys", (c) => {
  const keys = getUpstreamKeys().map((k) => ({
    ...k,
    api_key: maskKey(k.api_key),
  }));
  return c.json(keys);
});

admin.post("/upstream-keys", async (c) => {
  const body = await c.req.json();
  if (!body.provider_id || !body.api_key) {
    return c.json({ error: "provider_id and api_key are required" }, 400);
  }
  if (!getProvider(body.provider_id)) {
    return c.json({ error: "provider not found" }, 400);
  }
  const k = addUpstreamKey({
    provider_id: body.provider_id,
    api_key: body.api_key,
    alias: body.alias,
    rpm_limit: body.rpm_limit,
    tpm_limit: body.tpm_limit,
  });
  return c.json({ ...k, api_key: maskKey(k.api_key) }, 201);
});

admin.delete("/upstream-keys/:id", (c) => {
  const ok = deleteUpstreamKey(c.req.param("id"));
  return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});

admin.post("/upstream-keys/:id/test", async (c) => {
  const key = getUpstreamKey(c.req.param("id"));
  if (!key) return c.json({ error: "key not found" }, 404);

  const provider = getProvider(key.provider_id);
  if (!provider) return c.json({ error: "provider not found" }, 404);

  try {
    if (provider.type === "anthropic") {
      // Anthropic-compatible: send a minimal messages request
      const resp = await fetch(`${provider.base_url}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key.api_key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "MiniMax-M1",
          max_tokens: 16,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      if (!resp.ok) {
        const text = await resp.text();
        return c.json({ ok: false, status: resp.status, error: text });
      }
      const data = await resp.json();
      return c.json({ ok: true, result: data });
    }

    // OpenAI-compatible: fetch models list
    const resp = await fetch(`${provider.base_url}/models`, {
      headers: { Authorization: `Bearer ${key.api_key}` },
    });
    if (!resp.ok) {
      const text = await resp.text();
      return c.json({ ok: false, status: resp.status, error: text });
    }
    const data = await resp.json();
    return c.json({ ok: true, models: data });
  } catch (err: any) {
    return c.json({ ok: false, error: err.message });
  }
});

export { admin };

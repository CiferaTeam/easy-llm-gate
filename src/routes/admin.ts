import { Hono } from "hono";
import {
  getProviders,
  getProvider,
  addProvider,
  updateProvider,
  deleteProvider,
  getUpstreamKeys,
  getUpstreamKey,
  addUpstreamKey,
  deleteUpstreamKey,
  getGateKeys,
  addGateKey,
  deleteGateKey,
  maskKey,
} from "../store.js";
import { builtinProviders } from "../builtin-providers.js";
import { getTrafficSnapshots, getStatsUpstreamKeyIds } from "../stats.js";

const admin = new Hono();

// ── Health ──
admin.get("/health", (c) => c.json({ status: "ok", service: "admin" }));

// ── Builtin Providers (for frontend preset selection) ──
admin.get("/builtin-providers", (c) => c.json(builtinProviders));

// ── Providers ──
admin.get("/providers", async (c) => c.json(await getProviders()));

admin.post("/providers", async (c) => {
  const body = await c.req.json();
  if (!body.name || !body.base_url) {
    return c.json({ error: "name and base_url are required" }, 400);
  }
  const p = await addProvider({
    name: body.name,
    type: body.type,
    base_url: body.base_url,
    models: body.models,
  });
  return c.json(p, 201);
});

admin.put("/providers/:id", async (c) => {
  const body = await c.req.json();
  const id = c.req.param("id");
  const existing = await getProvider(id);
  if (!existing) return c.json({ error: "not found" }, 404);

  // Builtin providers are immutable — create a user copy instead
  if (existing.builtin) {
    const newName = body.name ?? existing.name;
    const copy = await addProvider({
      name: newName === existing.name ? newName + " (副本)" : newName,
      type: body.type ?? existing.type,
      base_url: body.base_url ?? existing.base_url,
      models: body.models ?? existing.models,
    });
    return c.json(copy, 201);
  }

  const updated = await updateProvider(id, {
    name: body.name,
    type: body.type,
    base_url: body.base_url,
    models: body.models,
  });
  return c.json(updated!);
});

admin.delete("/providers/:id", async (c) => {
  const ok = await deleteProvider(c.req.param("id"));
  return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});

// ── Upstream Keys ──
admin.get("/upstream-keys", async (c) => {
  const keys = (await getUpstreamKeys()).map((k) => ({
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
  if (!(await getProvider(body.provider_id))) {
    return c.json({ error: "provider not found" }, 400);
  }
  const k = await addUpstreamKey({
    provider_id: body.provider_id,
    api_key: body.api_key,
    alias: body.alias,
    rpm_limit: body.rpm_limit,
    tpm_limit: body.tpm_limit,
  });
  return c.json({ ...k, api_key: maskKey(k.api_key) }, 201);
});

admin.delete("/upstream-keys/:id", async (c) => {
  const ok = await deleteUpstreamKey(c.req.param("id"));
  return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});

admin.post("/upstream-keys/:id/test", async (c) => {
  const key = await getUpstreamKey(c.req.param("id"));
  if (!key) return c.json({ error: "key not found" }, 404);

  const provider = await getProvider(key.provider_id);
  if (!provider) return c.json({ error: "provider not found" }, 404);

  try {
    // Pick a test model from the provider's model list
    const testModel = provider.models?.[0] || (provider.type === "anthropic" ? "claude-3-5-haiku-20241022" : "gpt-3.5-turbo");

    if (provider.type === "anthropic") {
      const resp = await fetch(`${provider.base_url}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key.api_key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: testModel,
          max_tokens: 16,
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        }),
      });
      if (!resp.ok) {
        const text = await resp.text();
        return c.json({ ok: false, status: resp.status, error: text });
      }
      const contentType = resp.headers.get("content-type") || "";
      if (contentType.includes("text/event-stream")) {
        // Some proxies always return SSE regardless of stream:false
        const text = await resp.text();
        return c.json({ ok: true, result: "连通正常 (SSE)" });
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

admin.post("/upstream-keys/:id/chat-test", async (c) => {
  const key = await getUpstreamKey(c.req.param("id"));
  if (!key) return c.json({ error: "key not found" }, 404);

  const provider = await getProvider(key.provider_id);
  if (!provider) return c.json({ error: "provider not found" }, 404);

  const testModel = provider.models?.[0] || (provider.type === "anthropic" ? "claude-3-5-haiku-20241022" : "gpt-3.5-turbo");

  try {
    let resp: Response;

    if (provider.type === "anthropic") {
      resp = await fetch(`${provider.base_url}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key.api_key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: testModel,
          max_tokens: 64,
          messages: [{ role: "user", content: "你好，请用一句话介绍你自己" }],
          stream: false,
        }),
      });
    } else {
      resp = await fetch(`${provider.base_url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key.api_key}`,
        },
        body: JSON.stringify({
          model: testModel,
          messages: [{ role: "user", content: "你好，请用一句话介绍你自己" }],
          stream: false,
        }),
      });
    }

    if (!resp.ok) {
      const text = await resp.text();
      return c.json({ ok: false, status: resp.status, error: text });
    }

    const data = await resp.json();
    // Extract text content from response
    const content =
      data.content?.[0]?.text ??
      data.choices?.[0]?.message?.content ??
      JSON.stringify(data);
    return c.json({ ok: true, content });
  } catch (err: any) {
    return c.json({ ok: false, error: err.message });
  }
});

// ── Gate Keys ──
admin.get("/gate-keys", async (c) => c.json(await getGateKeys()));

admin.post("/gate-keys", async (c) => {
  const body = await c.req.json();
  if (!body.name) {
    return c.json({ error: "name is required" }, 400);
  }
  const gk = await addGateKey({
    name: body.name,
    upstream_key_ids: body.upstream_key_ids,
  });
  return c.json(gk, 201);
});

admin.delete("/gate-keys/:id", async (c) => {
  const ok = await deleteGateKey(c.req.param("id"));
  return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});

// ── Stats ──

admin.get("/stats/upstream-keys", async (c) => {
  const ids = await getStatsUpstreamKeyIds();
  return c.json(ids);
});

admin.get("/stats/upstream-keys/:id/traffic", async (c) => {
  const id = c.req.param("id");
  const from = Number(c.req.query("from") || 0);
  const to = Number(c.req.query("to") || Math.floor(Date.now() / 1000));
  const snapshots = await getTrafficSnapshots(id, from, to);
  return c.json(snapshots);
});

export { admin };

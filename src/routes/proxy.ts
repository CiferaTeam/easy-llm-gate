import { Hono } from "hono";
import { stream } from "hono/streaming";
import type { Context } from "hono";
import {
  authenticateGateKey,
  findUpstreamForGateKey,
  type GateKey,
  type UpstreamKey,
  type Provider,
} from "../store.js";

const proxy = new Hono();

// ── Auth helper ──

function extractApiKey(c: Context): string | null {
  // Anthropic style: x-api-key header
  const xApiKey = c.req.header("x-api-key");
  if (xApiKey) return xApiKey;
  // OpenAI style: Authorization: Bearer xxx
  const auth = c.req.header("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

async function resolveUpstream(
  c: Context,
  providerType?: Provider["type"]
): Promise<{ gateKey: GateKey; key: UpstreamKey; provider: Provider } | Response> {
  const apiKey = extractApiKey(c);
  if (!apiKey) {
    return c.json(
      { error: { message: "Missing API key", type: "auth_error" } },
      401
    );
  }

  const gateKey = await authenticateGateKey(apiKey);
  if (!gateKey) {
    return c.json(
      { error: { message: "Invalid API key", type: "auth_error" } },
      401
    );
  }

  const match = await findUpstreamForGateKey(gateKey, providerType);
  if (!match) {
    return c.json(
      { error: { message: "No upstream key available for this gate key", type: "proxy_error" } },
      503
    );
  }

  return { gateKey, ...match };
}

// ── Stream helper ──

async function proxyStream(c: Context, resp: globalThis.Response) {
  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");

  return stream(c, async (s) => {
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await s.write(decoder.decode(value, { stream: true }));
      }
    } finally {
      reader.cancel();
    }
  });
}

// ── OpenAI: POST /v1/chat/completions ──

proxy.post("/chat/completions", async (c) => {
  const result = await resolveUpstream(c);
  if (result instanceof Response) return result;
  const { key, provider } = result;

  const body = await c.req.json();
  const isStream = body.stream === true;
  const upstreamUrl = `${provider.base_url}/chat/completions`;

  try {
    const resp = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key.api_key}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return c.json(
        { error: { message: `Upstream error: ${resp.status} ${errText}`, type: "upstream_error" } },
        resp.status as any
      );
    }

    const ct = resp.headers.get("content-type") || "";
    if ((isStream || ct.includes("text/event-stream")) && resp.body) return proxyStream(c, resp);
    return c.json(await resp.json());
  } catch (err: any) {
    return c.json({ error: { message: err.message, type: "proxy_error" } }, 502);
  }
});

// ── Anthropic: POST /v1/messages ──

proxy.post("/messages", async (c) => {
  const result = await resolveUpstream(c, "anthropic");
  if (result instanceof Response) return result;
  const { key, provider } = result;

  const body = await c.req.json();
  const isStream = body.stream === true;
  const upstreamUrl = `${provider.base_url}/v1/messages`;

  try {
    const resp = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key.api_key,
        "anthropic-version": c.req.header("anthropic-version") || "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return c.json(
        { type: "error", error: { type: "upstream_error", message: `Upstream error: ${resp.status} ${errText}` } },
        resp.status as any
      );
    }

    const ct = resp.headers.get("content-type") || "";
    if ((isStream || ct.includes("text/event-stream")) && resp.body) return proxyStream(c, resp);
    return c.json(await resp.json());
  } catch (err: any) {
    return c.json(
      { type: "error", error: { type: "proxy_error", message: err.message } },
      502
    );
  }
});

// ── GET /v1/models ──

proxy.get("/models", async (c) => {
  const result = await resolveUpstream(c);
  if (result instanceof Response) return result;
  const { key, provider } = result;

  try {
    const resp = await fetch(`${provider.base_url}/models`, {
      headers: { Authorization: `Bearer ${key.api_key}` },
    });
    if (!resp.ok) return c.json({ object: "list", data: [] });
    return c.json(await resp.json());
  } catch {
    return c.json({ object: "list", data: [] });
  }
});

export { proxy };

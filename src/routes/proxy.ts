import { Hono } from "hono";
import { stream } from "hono/streaming";
import { findKeyForProxy } from "../store.js";

const proxy = new Hono();

proxy.post("/chat/completions", async (c) => {
  const match = await findKeyForProxy();
  if (!match) {
    return c.json(
      { error: { message: "No upstream key available", type: "proxy_error" } },
      503
    );
  }

  const { key, provider } = match;
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
        {
          error: {
            message: `Upstream error: ${resp.status} ${errText}`,
            type: "upstream_error",
          },
        },
        resp.status as any
      );
    }

    if (isStream && resp.body) {
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

    const data = await resp.json();
    return c.json(data);
  } catch (err: any) {
    return c.json(
      { error: { message: err.message, type: "proxy_error" } },
      502
    );
  }
});

// ── Anthropic Messages API ──
proxy.post("/messages", async (c) => {
  const match = await findKeyForProxy("anthropic");
  if (!match) {
    return c.json(
      { type: "error", error: { type: "proxy_error", message: "No upstream anthropic key available" } },
      503
    );
  }

  const { key, provider } = match;
  const body = await c.req.json();
  const isStream = body.stream === true;
  const upstreamUrl = `${provider.base_url}/v1/messages`;

  try {
    const resp = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key.api_key,
        "anthropic-version": "2023-06-01",
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

    if (isStream && resp.body) {
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

    const data = await resp.json();
    return c.json(data);
  } catch (err: any) {
    return c.json(
      { type: "error", error: { type: "proxy_error", message: err.message } },
      502
    );
  }
});

proxy.get("/models", async (c) => {
  const match = await findKeyForProxy();
  if (!match) {
    return c.json({ object: "list", data: [] });
  }

  try {
    const resp = await fetch(`${match.provider.base_url}/models`, {
      headers: { Authorization: `Bearer ${match.key.api_key}` },
    });
    if (!resp.ok) {
      return c.json({ object: "list", data: [] });
    }
    const data = await resp.json();
    return c.json(data);
  } catch {
    return c.json({ object: "list", data: [] });
  }
});

export { proxy };

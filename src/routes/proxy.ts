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
import { recordRequest } from "../stats.js";
import { recordPrompt, recordPromptResponse, recordCacheUsage } from "../prompt-cache.js";

const proxy = new Hono();

// ── Model resolution with sticky cache ──

const MODEL_CACHE_TTL = 60 * 60 * 1000; // 1 hour
const modelCache = new Map<string, { model: string; ts: number }>();

/**
 * Resolve the actual model to use for an upstream key.
 * - If provider.models is empty, pass through the original model (backward compat).
 * - If requestModel is in provider.models, use it.
 * - Otherwise (including "auto"), pick provider.models[0].
 * Results are cached per upstream_key_id:requestModel for stability (prompt cache friendly).
 */
function resolveModel(
  upstreamKeyId: string,
  providerModels: string[],
  requestModel: string
): string {
  if (providerModels.length === 0) return requestModel;

  const cacheKey = `${upstreamKeyId}:${requestModel}`;
  const cached = modelCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < MODEL_CACHE_TTL) {
    return cached.model;
  }

  const resolved = providerModels.includes(requestModel)
    ? requestModel
    : providerModels[0];

  modelCache.set(cacheKey, { model: resolved, ts: Date.now() });
  return resolved;
}

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

// ── Token extraction helpers ──

function extractTokensFromOpenAI(data: any): number {
  return data?.usage?.total_tokens ?? 0;
}

function extractTokensFromAnthropic(data: any): number {
  const u = data?.usage;
  if (!u) return 0;
  return (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
}

function extractAnthropicCacheTokens(data: any): {
  creation: number;
  read: number;
} {
  const u = data?.usage;
  return {
    creation: u?.cache_creation_input_tokens ?? 0,
    read: u?.cache_read_input_tokens ?? 0,
  };
}

// ── Stream helper (with stats recording) ──

function proxyStreamWithStats(
  c: Context,
  resp: globalThis.Response,
  upstreamKeyId: string,
  gateKeyId: string,
  tokenExtractor: (data: any) => number,
  onChunkParsed?: (data: any) => void,
  onStreamEnd?: () => void
) {
  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");

  return stream(c, async (s) => {
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let totalTokens = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        await s.write(chunk);

        // Try to extract usage from SSE chunks (typically in the last chunk)
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
          try {
            const parsed = JSON.parse(line.slice(6));
            const tokens = tokenExtractor(parsed);
            if (tokens > 0) totalTokens = tokens;
            onChunkParsed?.(parsed);
          } catch {
            // not valid JSON, skip
          }
        }
      }
    } finally {
      reader.cancel();
    }
    // Record with best-effort token count (stream may not report usage)
    recordRequest(upstreamKeyId, gateKeyId, totalTokens);
    onStreamEnd?.();
  });
}

// ── OpenAI: POST /v1/chat/completions ──

proxy.post("/chat/completions", async (c) => {
  const result = await resolveUpstream(c);
  if (result instanceof Response) return result;
  const { gateKey, key, provider } = result;

  const body = await c.req.json();
  const isStream = body.stream === true;
  const upstreamUrl = `${provider.base_url}/chat/completions`;

  // Resolve model
  const originalModel = body.model ?? "unknown";
  body.model = resolveModel(key.id, provider.models, originalModel);

  // Record prompt fingerprint
  if (body.messages) {
    recordPrompt({
      messages: body.messages,
      model: body.model ?? "unknown",
      upstreamKeyId: key.id,
      gateKeyId: gateKey.id,
      gateKeyName: gateKey.name,
      tokens: 0, // updated after response
    });
  }

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
    if ((isStream || ct.includes("text/event-stream")) && resp.body) {
      // Accumulate streamed assistant content for prompt recording
      let streamedContent = "";
      return proxyStreamWithStats(c, resp, key.id, gateKey.id, extractTokensFromOpenAI, (parsed) => {
        const delta = parsed?.choices?.[0]?.delta;
        if (delta?.content) streamedContent += delta.content;
      }, () => {
        if (streamedContent) {
          recordPromptResponse({
            messages: body.messages,
            upstreamKeyId: key.id,
            assistantMessage: { role: "assistant", content: streamedContent },
          });
        }
      });
    }

    const data = await resp.json();
    recordRequest(key.id, gateKey.id, extractTokensFromOpenAI(data));
    // Record assistant response
    const choice = data?.choices?.[0]?.message;
    if (choice) {
      recordPromptResponse({
        messages: body.messages,
        upstreamKeyId: key.id,
        assistantMessage: choice,
      });
    }
    return c.json(data);
  } catch (err: any) {
    return c.json({ error: { message: err.message, type: "proxy_error" } }, 502);
  }
});

// ── Anthropic: POST /v1/messages ──

proxy.post("/messages", async (c) => {
  const result = await resolveUpstream(c, "anthropic");
  if (result instanceof Response) return result;
  const { gateKey, key, provider } = result;

  const body = await c.req.json();
  const isStream = body.stream === true;
  const upstreamUrl = `${provider.base_url}/v1/messages`;

  // Resolve model
  const originalModel = body.model ?? "unknown";
  body.model = resolveModel(key.id, provider.models, originalModel);

  // Record prompt fingerprint (Anthropic uses system + messages)
  const allMessages = [
    ...(body.system ? [{ role: "system", content: body.system }] : []),
    ...(body.messages ?? []),
  ];
  if (allMessages.length > 0) {
    recordPrompt({
      messages: allMessages,
      model: body.model ?? "unknown",
      upstreamKeyId: key.id,
      gateKeyId: gateKey.id,
      gateKeyName: gateKey.name,
      tokens: 0,
    });
  }

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
    if ((isStream || ct.includes("text/event-stream")) && resp.body) {
      // Accumulate streamed assistant content for prompt recording
      let streamedContent = "";
      return proxyStreamWithStats(c, resp, key.id, gateKey.id, extractTokensFromAnthropic, (parsed) => {
        const cache = extractAnthropicCacheTokens(parsed);
        if (cache.creation || cache.read) {
          recordCacheUsage(key.id, cache.creation, cache.read);
        }
        // Anthropic streams content_block_delta with text
        if (parsed?.type === "content_block_delta" && parsed?.delta?.text) {
          streamedContent += parsed.delta.text;
        }
      }, () => {
        if (streamedContent) {
          recordPromptResponse({
            messages: allMessages,
            upstreamKeyId: key.id,
            assistantMessage: { role: "assistant", content: streamedContent },
          });
        }
      });
    }

    const data = await resp.json();
    recordRequest(key.id, gateKey.id, extractTokensFromAnthropic(data));
    const cache = extractAnthropicCacheTokens(data);
    if (cache.creation || cache.read) {
      recordCacheUsage(key.id, cache.creation, cache.read);
    }
    // Record assistant response
    if (data?.content) {
      const textParts = data.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
      if (textParts) {
        recordPromptResponse({
          messages: allMessages,
          upstreamKeyId: key.id,
          assistantMessage: { role: "assistant", content: textParts },
        });
      }
    }
    return c.json(data);
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

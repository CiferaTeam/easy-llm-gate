import { useEffect, useState, useRef } from "react";
import {
  fetchUpstreamKeys,
  fetchProviders,
  type UpstreamKey,
  type Provider,
} from "./api";

// ── Types matching backend PromptEntry / CacheStats ──

interface PromptEntry {
  prefixHash: string;
  model: string;
  upstreamKeyId: string;
  gateKeyId: string;
  gateKeyName: string;
  suffixPreview: string;
  hitCount: number;
  totalTokens: number;
  createdAt: number;
  updatedAt: number;
  lastRequestId?: string;
  /** Resolved from rate limiter: null = completed/idle */
  requestStatus: "queued" | "executing" | "streaming" | null;
}

interface CacheStats {
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalRequests: number;
}

interface BucketStats {
  rpm: { limit: number; available: number; queued: number };
  tpm: { limit: number; used: number };
}

interface LivePayload {
  entries: PromptEntry[];
  cacheStats: CacheStats;
  reuse: { totalEntries: number; totalHits: number; reuseRate: number };
  bucket: BucketStats | null;
}

interface Message {
  role: string;
  content: any;
}

function timeAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

function formatContent(content: any): string {
  if (typeof content === "string") return content;
  return JSON.stringify(content, null, 2);
}

const ROLE_COLORS: Record<string, string> = {
  system: "#f59e0b",
  user: "#3b82f6",
  assistant: "#22c55e",
  tool: "#8b5cf6",
};

function StatusBadge({ status }: { status: PromptEntry["requestStatus"] }) {
  if (!status) return <span className="q-badge q-badge-done">已完成</span>;
  const cls =
    status === "queued"
      ? "q-badge-queued"
      : status === "executing"
      ? "q-badge-executing"
      : "q-badge-streaming";
  const label =
    status === "queued"
      ? "排队中"
      : status === "executing"
      ? "请求中"
      : "流式传输";
  return <span className={`q-badge ${cls}`}>{label}</span>;
}

function GaugeBar({
  label,
  value,
  max,
  extra,
}: {
  label: string;
  value: number;
  max: number;
  extra?: string;
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const color =
    pct > 90 ? "var(--danger)" : pct > 70 ? "#eab308" : "var(--accent)";
  return (
    <div className="q-gauge">
      <div className="q-gauge-header">
        <span className="q-gauge-label">{label}</span>
        <span className="q-gauge-value">
          {value.toLocaleString()} / {max.toLocaleString()}
          {extra ? ` ${extra}` : ""}
        </span>
      </div>
      <div className="q-gauge-track">
        <div
          className="q-gauge-fill"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
    </div>
  );
}

export function PromptCachePage() {
  const [upstreamKeys, setUpstreamKeys] = useState<UpstreamKey[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selectedKeyId, setSelectedKeyId] = useState("");
  const [data, setData] = useState<LivePayload | null>(null);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  // Expand state: prefixHash → messages (loaded on demand)
  const [expanded, setExpanded] = useState<Record<string, Message[] | "loading">>({});

  useEffect(() => {
    Promise.all([fetchUpstreamKeys(), fetchProviders()]).then(([uks, provs]) => {
      setUpstreamKeys(uks);
      setProviders(provs);
      if (uks.length > 0) setSelectedKeyId(uks[0].id);
    });
  }, []);

  // SSE connection
  useEffect(() => {
    if (!selectedKeyId) return;

    setData(null);
    setExpanded({});
    const es = new EventSource(`/api/prompt-cache/${selectedKeyId}/live`);
    esRef.current = es;

    es.onopen = () => setConnected(true);
    es.onmessage = (e) => {
      try {
        setData(JSON.parse(e.data));
      } catch {}
    };
    es.onerror = () => setConnected(false);

    return () => {
      es.close();
      esRef.current = null;
      setConnected(false);
    };
  }, [selectedKeyId]);

  const toggleExpand = async (prefixHash: string) => {
    if (expanded[prefixHash]) {
      // Collapse
      setExpanded((prev) => {
        const next = { ...prev };
        delete next[prefixHash];
        return next;
      });
      return;
    }

    // Fetch full entry with messages from JSON endpoint
    setExpanded((prev) => ({ ...prev, [prefixHash]: "loading" }));
    try {
      const r = await fetch(`/api/prompt-cache/${selectedKeyId}`);
      const payload = await r.json();
      const entry = payload.entries.find(
        (e: any) => e.prefixHash === prefixHash
      );
      setExpanded((prev) => ({
        ...prev,
        [prefixHash]: entry?.messages ?? [],
      }));
    } catch {
      setExpanded((prev) => ({ ...prev, [prefixHash]: [] }));
    }
  };

  const selectedKey = upstreamKeys.find((k) => k.id === selectedKeyId);

  const cacheHitRate =
    data?.cacheStats && data.cacheStats.totalRequests > 0
      ? data.cacheStats.cacheReadTokens /
        (data.cacheStats.cacheCreationTokens + data.cacheStats.cacheReadTokens || 1)
      : 0;

  return (
    <>
      {/* Controls */}
      <div className="card stats-controls">
        <div className="stats-row">
          <div className="form-group" style={{ flex: 2 }}>
            <label>Upstream Key</label>
            <select
              value={selectedKeyId}
              onChange={(e) => setSelectedKeyId(e.target.value)}
            >
              {upstreamKeys.length === 0 && <option value="">暂无 Key</option>}
              {upstreamKeys.map((uk) => {
                const prov = providers.find((p) => p.id === uk.provider_id);
                return (
                  <option key={uk.id} value={uk.id}>
                    {uk.alias || uk.api_key} ({prov?.name ?? uk.provider_id})
                  </option>
                );
              })}
            </select>
          </div>
          <div className="form-group" style={{ flex: 0, minWidth: 100 }}>
            <label>SSE</label>
            <span className={`pc-status ${connected ? "pc-connected" : ""}`}>
              {connected ? "已连接" : "未连接"}
            </span>
          </div>
        </div>
      </div>

      {/* Bucket gauges — rate limit status */}
      {selectedKey && data?.bucket && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="q-gauges">
            <GaugeBar
              label="RPM"
              value={data.bucket.rpm.limit - data.bucket.rpm.available}
              max={data.bucket.rpm.limit}
              extra={
                data.bucket.rpm.queued > 0
                  ? `(${data.bucket.rpm.queued} 排队)`
                  : undefined
              }
            />
            <GaugeBar
              label="TPM"
              value={data.bucket.tpm.used}
              max={data.bucket.tpm.limit}
            />
          </div>
        </div>
      )}

      {/* Summary cards */}
      {selectedKey && (
        <div className="pc-summary">
          <div className="pc-summary-card">
            <div className="pc-summary-label">活跃前缀</div>
            <div className="pc-summary-value">{data?.reuse.totalEntries ?? 0}</div>
          </div>
          <div className="pc-summary-card">
            <div className="pc-summary-label">总命中</div>
            <div className="pc-summary-value">{data?.reuse.totalHits ?? 0}</div>
          </div>
          <div className="pc-summary-card">
            <div className="pc-summary-label">前缀重复率</div>
            <div className="pc-summary-value">
              {data ? `${(data.reuse.reuseRate * 100).toFixed(1)}%` : "-"}
            </div>
          </div>
          <div className="pc-summary-card">
            <div className="pc-summary-label">Cache 命中率</div>
            <div className="pc-summary-value">
              {data?.cacheStats.totalRequests
                ? `${(cacheHitRate * 100).toFixed(1)}%`
                : "-"}
            </div>
          </div>
          <div className="pc-summary-card">
            <div className="pc-summary-label">Cache 创建</div>
            <div className="pc-summary-value pc-summary-dim">
              {data?.cacheStats.cacheCreationTokens.toLocaleString() ?? 0} tokens
            </div>
          </div>
          <div className="pc-summary-card">
            <div className="pc-summary-label">Cache 读取</div>
            <div className="pc-summary-value pc-summary-dim">
              {data?.cacheStats.cacheReadTokens.toLocaleString() ?? 0} tokens
            </div>
          </div>
        </div>
      )}

      {/* Live entries table */}
      <div className="card">
        <h2>在途请求窗口</h2>
        {(!data || data.entries.length === 0) ? (
          <div style={{ textAlign: "center", color: "var(--text-dim)", padding: "32px 0" }}>
            {selectedKeyId ? "该 Key 暂无活跃的 prompt 条目" : "请先选择 Upstream Key"}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>状态</th>
                <th>前缀指纹</th>
                <th>模型</th>
                <th>Gate Key</th>
                <th>命中</th>
                <th>Tokens</th>
                <th>最新内容</th>
                <th>更新</th>
              </tr>
            </thead>
            <tbody>
              {data.entries
                .sort((a, b) => {
                  // Active requests first, then by updatedAt desc
                  const aActive = a.requestStatus ? 1 : 0;
                  const bActive = b.requestStatus ? 1 : 0;
                  if (aActive !== bActive) return bActive - aActive;
                  return b.updatedAt - a.updatedAt;
                })
                .map((entry) => {
                  const isExpanded = !!expanded[entry.prefixHash];
                  const messages = expanded[entry.prefixHash];
                  return (
                    <>
                      <tr key={entry.prefixHash}>
                        <td>
                          <StatusBadge status={entry.requestStatus} />
                        </td>
                        <td>
                          <code className="pc-hash">{entry.prefixHash}</code>
                        </td>
                        <td>
                          <span className="badge badge-success">{entry.model}</span>
                        </td>
                        <td style={{ fontSize: 12 }}>{entry.gateKeyName}</td>
                        <td>
                          <span className={`pc-hit-count ${entry.hitCount > 5 ? "pc-hot" : ""}`}>
                            {entry.hitCount}
                          </span>
                        </td>
                        <td style={{ fontSize: 12 }}>{entry.totalTokens.toLocaleString()}</td>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <div className="pc-preview">{entry.suffixPreview || "-"}</div>
                            <button
                              className="btn-outline btn-sm pc-expand-btn"
                              onClick={() => toggleExpand(entry.prefixHash)}
                            >
                              {messages === "loading" ? "..." : isExpanded ? "收起" : "展开"}
                            </button>
                          </div>
                        </td>
                        <td style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
                          {timeAgo(entry.updatedAt)}
                        </td>
                      </tr>
                      {isExpanded && messages !== "loading" && (
                        <tr key={`${entry.prefixHash}-detail`}>
                          <td colSpan={8} style={{ padding: 0 }}>
                            <div className="pc-messages">
                              {(messages as Message[]).length === 0 && (
                                <div className="pc-msg-empty">无消息内容</div>
                              )}
                              {(messages as Message[]).map((msg, i) => (
                                <div key={i} className="pc-msg">
                                  <span
                                    className="pc-msg-role"
                                    style={{ color: ROLE_COLORS[msg.role] ?? "var(--text-dim)" }}
                                  >
                                    {msg.role}
                                  </span>
                                  <pre className="pc-msg-content">{formatContent(msg.content)}</pre>
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

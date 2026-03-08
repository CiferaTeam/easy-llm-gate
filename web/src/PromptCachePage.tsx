import { useEffect, useState, useRef, useCallback } from "react";
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
}

interface CacheStats {
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalRequests: number;
}

interface LivePayload {
  entries: PromptEntry[];
  cacheStats: CacheStats;
  reuse: { totalEntries: number; totalHits: number; reuseRate: number };
}

function timeAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

export function PromptCachePage() {
  const [upstreamKeys, setUpstreamKeys] = useState<UpstreamKey[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selectedKeyId, setSelectedKeyId] = useState("");
  const [data, setData] = useState<LivePayload | null>(null);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

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

  const selectedKey = upstreamKeys.find((k) => k.id === selectedKeyId);
  const providerName = selectedKey
    ? providers.find((p) => p.id === selectedKey.provider_id)?.name ?? ""
    : "";

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
                .sort((a, b) => b.updatedAt - a.updatedAt)
                .map((entry) => (
                  <tr key={entry.prefixHash}>
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
                      <div className="pc-preview">{entry.suffixPreview || "-"}</div>
                    </td>
                    <td style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
                      {timeAgo(entry.updatedAt)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

import { useEffect, useState, useCallback, useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import {
  fetchUpstreamKeys,
  fetchGateKeys,
  fetchProviders,
  fetchTrafficSnapshots,
  type UpstreamKey,
  type GateKey,
  type Provider,
  type TrafficSnapshot,
} from "./api";

// ── Color palette for gate keys ──
const GATE_COLORS = [
  "#6366f1", "#22c55e", "#f59e0b", "#ef4444", "#06b6d4",
  "#ec4899", "#8b5cf6", "#14b8a6", "#f97316", "#a855f7",
];

// ── Time range presets ──
const TIME_RANGES = [
  { label: "5 分钟", seconds: 5 * 60 },
  { label: "30 分钟", seconds: 30 * 60 },
  { label: "1 小时", seconds: 60 * 60 },
  { label: "6 小时", seconds: 6 * 60 * 60 },
  { label: "24 小时", seconds: 24 * 60 * 60 },
  { label: "7 天", seconds: 7 * 24 * 60 * 60 },
  { label: "30 天", seconds: 30 * 24 * 60 * 60 },
];

function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  const s = d.getSeconds().toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function formatDate(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

interface ChartDataPoint {
  ts: number;
  time: string;
  limit: number;
  actual: number;
  [gateKeyId: string]: number | string;
}

function buildChartData(
  snapshots: TrafficSnapshot[],
  type: "rpm" | "tpm",
  allGateKeyIds: string[]
): ChartDataPoint[] {
  const rangeSec = snapshots.length > 0 ? snapshots[snapshots.length - 1].ts - snapshots[0].ts : 0;
  const useDate = rangeSec > 6 * 3600;

  return snapshots.map((s) => {
    const point: ChartDataPoint = {
      ts: s.ts,
      time: useDate ? formatDate(s.ts) : formatTime(s.ts),
      limit: type === "rpm" ? s.rpmLimit : s.tpmLimit,
      actual: type === "rpm" ? s.rpmActual : s.tpmActual,
    };
    const byGate = type === "rpm" ? s.rpmByGate : s.tpmByGate;
    for (const gkId of allGateKeyIds) {
      point[gkId] = byGate[gkId] ?? 0;
    }
    return point;
  });
}

interface TrafficChartProps {
  title: string;
  data: ChartDataPoint[];
  gateKeys: { id: string; name: string }[];
  unit: string;
}

function TrafficChart({ title, data, gateKeys, unit }: TrafficChartProps) {
  if (data.length === 0) {
    return (
      <div className="chart-container">
        <h3 className="chart-title">{title}</h3>
        <div className="chart-empty">暂无数据</div>
      </div>
    );
  }

  const maxLimit = Math.max(...data.map((d) => d.limit));

  return (
    <div className="chart-container">
      <h3 className="chart-title">{title}</h3>
      <ResponsiveContainer width="100%" height={320}>
        <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3a" />
          <XAxis
            dataKey="time"
            stroke="#8b8fa3"
            fontSize={11}
            tick={{ fill: "#8b8fa3" }}
            interval="preserveStartEnd"
          />
          <YAxis
            stroke="#8b8fa3"
            fontSize={11}
            tick={{ fill: "#8b8fa3" }}
            tickFormatter={(v: number) =>
              v >= 10000 ? `${(v / 1000).toFixed(0)}k` : String(v)
            }
          />
          <Tooltip
            contentStyle={{
              background: "#1a1d27",
              border: "1px solid #2a2d3a",
              borderRadius: 8,
              fontSize: 12,
              color: "#e1e4ed",
            }}
            labelStyle={{ color: "#8b8fa3" }}
            formatter={(value: any, name: any) => [
              Number(value).toLocaleString() + ` ${unit}`,
              String(name),
            ]}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: "#8b8fa3" }} />

          {/* Limit line (red dashed) */}
          {maxLimit > 0 && (
            <Line
              type="stepAfter"
              dataKey="limit"
              name={`上限 (${maxLimit.toLocaleString()} ${unit})`}
              stroke="#ef4444"
              strokeDasharray="6 3"
              strokeWidth={1.5}
              dot={false}
              activeDot={false}
            />
          )}

          {/* Total line */}
          <Line
            type="monotone"
            dataKey="actual"
            name="总量"
            stroke="#3b82f6"
            strokeWidth={2}
            dot={false}
          />

          {/* Per gate key lines */}
          {gateKeys.map((gk, i) => (
            <Line
              key={gk.id}
              type="monotone"
              dataKey={gk.id}
              name={gk.name}
              stroke={GATE_COLORS[i % GATE_COLORS.length]}
              strokeWidth={1.5}
              dot={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function StatsPage() {
  const [upstreamKeys, setUpstreamKeys] = useState<UpstreamKey[]>([]);
  const [gateKeys, setGateKeys] = useState<GateKey[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selectedKeyId, setSelectedKeyId] = useState<string>("");
  const [rangeIdx, setRangeIdx] = useState(2); // default: 1 hour
  const [snapshots, setSnapshots] = useState<TrafficSnapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Load metadata
  useEffect(() => {
    Promise.all([fetchUpstreamKeys(), fetchGateKeys(), fetchProviders()]).then(
      ([uks, gks, provs]) => {
        setUpstreamKeys(uks);
        setGateKeys(gks);
        setProviders(provs);
        if (uks.length > 0 && !selectedKeyId) {
          setSelectedKeyId(uks[0].id);
        }
      }
    );
  }, []);

  // Fetch traffic data
  const fetchData = useCallback(async () => {
    if (!selectedKeyId) return;
    setLoading(true);
    try {
      const now = Math.floor(Date.now() / 1000);
      const from = now - TIME_RANGES[rangeIdx].seconds;
      const data = await fetchTrafficSnapshots(selectedKeyId, from, now);
      setSnapshots(data);
    } finally {
      setLoading(false);
    }
  }, [selectedKeyId, rangeIdx]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Auto-refresh every 5 seconds
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(fetchData, 5000);
    return () => clearInterval(timer);
  }, [autoRefresh, fetchData]);

  // Collect all gate key IDs that appear in the data
  const gateKeyIdsInData = useMemo(() => {
    const ids = new Set<string>();
    for (const s of snapshots) {
      for (const gkId of Object.keys(s.rpmByGate)) ids.add(gkId);
      for (const gkId of Object.keys(s.tpmByGate)) ids.add(gkId);
    }
    return Array.from(ids);
  }, [snapshots]);

  // Map gate key IDs to display names
  const gateKeyInfos = useMemo(() => {
    return gateKeyIdsInData.map((id) => {
      const gk = gateKeys.find((g) => g.id === id);
      return { id, name: gk?.name ?? id.slice(0, 12) };
    });
  }, [gateKeyIdsInData, gateKeys]);

  const rpmData = useMemo(
    () => buildChartData(snapshots, "rpm", gateKeyIdsInData),
    [snapshots, gateKeyIdsInData]
  );
  const tpmData = useMemo(
    () => buildChartData(snapshots, "tpm", gateKeyIdsInData),
    [snapshots, gateKeyIdsInData]
  );

  const selectedKey = upstreamKeys.find((k) => k.id === selectedKeyId);
  const providerName = selectedKey
    ? providers.find((p) => p.id === selectedKey.provider_id)?.name ?? ""
    : "";

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

          <div className="form-group" style={{ flex: 0, minWidth: 140 }}>
            <label>自动刷新</label>
            <button
              className={autoRefresh ? "btn-primary btn-sm" : "btn-outline btn-sm"}
              onClick={() => setAutoRefresh(!autoRefresh)}
              style={{ width: "100%" }}
            >
              {autoRefresh ? "开启 (5s)" : "已关闭"}
            </button>
          </div>
        </div>

        <div className="time-range-bar">
          {TIME_RANGES.map((tr, i) => (
            <button
              key={tr.seconds}
              className={`time-range-btn ${i === rangeIdx ? "active" : ""}`}
              onClick={() => setRangeIdx(i)}
            >
              {tr.label}
            </button>
          ))}
        </div>
      </div>

      {/* Key info badge */}
      {selectedKey && (
        <div className="stats-key-info">
          <span className="badge badge-builtin">{providerName}</span>
          <span className="stats-key-meta">
            RPM 上限: <strong>{selectedKey.rpm_limit}</strong>
          </span>
          <span className="stats-key-meta">
            TPM 上限: <strong>{selectedKey.tpm_limit.toLocaleString()}</strong>
          </span>
          {loading && <span className="stats-loading">加载中...</span>}
        </div>
      )}

      {/* RPM Chart */}
      <div className="card">
        <TrafficChart
          title="RPM (Requests Per Minute-window)"
          data={rpmData}
          gateKeys={gateKeyInfos}
          unit="req"
        />
      </div>

      {/* TPM Chart */}
      <div className="card">
        <TrafficChart
          title="TPM (Tokens Per Minute-window)"
          data={tpmData}
          gateKeys={gateKeyInfos}
          unit="tokens"
        />
      </div>

      {snapshots.length === 0 && !loading && (
        <div className="card" style={{ textAlign: "center", color: "var(--text-dim)" }}>
          <p>
            {selectedKeyId
              ? "该 Key 在所选时间范围内暂无流量数据"
              : "请先添加 Upstream Key"}
          </p>
          <p style={{ fontSize: 12, marginTop: 4 }}>
            流量数据每 5 秒采集一次，通过代理发送请求后即可看到数据
          </p>
        </div>
      )}
    </>
  );
}

import { useEffect, useState, useCallback } from "react";
import {
  fetchProviders,
  fetchUpstreamKeys,
  fetchGateKeys,
  createProvider,
  deleteProvider,
  createUpstreamKey,
  deleteUpstreamKey,
  testUpstreamKey,
  createGateKey,
  deleteGateKey,
  type Provider,
  type UpstreamKey,
  type GateKey,
} from "./api";

export function App() {
  const [tab, setTab] = useState<"providers" | "gatekeys">("providers");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [keys, setKeys] = useState<UpstreamKey[]>([]);
  const [gateKeys, setGateKeys] = useState<GateKey[]>([]);

  // Provider form
  const [provName, setProvName] = useState("");
  const [provType, setProvType] = useState<"openai" | "anthropic">("openai");
  const [provUrl, setProvUrl] = useState("https://open.bigmodel.cn/api/paas/v4");

  // Key form
  const [keyProviderId, setKeyProviderId] = useState("");
  const [keyApiKey, setKeyApiKey] = useState("");
  const [keyAlias, setKeyAlias] = useState("");
  const [keyRpm, setKeyRpm] = useState(60);
  const [keyTpm, setKeyTpm] = useState(100000);

  // Gate Key form
  const [gkName, setGkName] = useState("");
  const [gkFormat, setGkFormat] = useState<"openai" | "anthropic">("openai");
  const [gkSelectedKeys, setGkSelectedKeys] = useState<string[]>([]);

  // Test states per key
  const [testState, setTestState] = useState<
    Record<string, { loading: boolean; result?: string; ok?: boolean }>
  >({});

  const reload = useCallback(async () => {
    const [p, k, gk] = await Promise.all([fetchProviders(), fetchUpstreamKeys(), fetchGateKeys()]);
    setProviders(p);
    setKeys(k);
    setGateKeys(gk);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const handleAddProvider = async () => {
    if (!provName || !provUrl) return;
    await createProvider({ name: provName, type: provType, base_url: provUrl });
    setProvName("");
    setProvType("openai");
    setProvUrl("https://open.bigmodel.cn/api/paas/v4");
    reload();
  };

  const handleDeleteProvider = async (id: string) => {
    if (!confirm("删除该服务商及其所有 Key？")) return;
    await deleteProvider(id);
    reload();
  };

  const handleAddKey = async () => {
    if (!keyProviderId || !keyApiKey) return;
    await createUpstreamKey({
      provider_id: keyProviderId,
      api_key: keyApiKey,
      alias: keyAlias,
      rpm_limit: keyRpm,
      tpm_limit: keyTpm,
    });
    setKeyApiKey("");
    setKeyAlias("");
    reload();
  };

  const handleDeleteKey = async (id: string) => {
    if (!confirm("删除该 Key？")) return;
    await deleteUpstreamKey(id);
    reload();
  };

  const handleTestKey = async (id: string) => {
    setTestState((s) => ({ ...s, [id]: { loading: true } }));
    try {
      const r = await testUpstreamKey(id);
      setTestState((s) => ({
        ...s,
        [id]: { loading: false, ok: r.ok, result: r.ok ? "连通正常" : (r.error ?? "连接失败") },
      }));
    } catch (e: any) {
      setTestState((s) => ({
        ...s,
        [id]: { loading: false, ok: false, result: e.message },
      }));
    }
  };

  const handleProxyTest = async (id: string) => {
    const key = keys.find((k) => k.id === id);
    if (!key) return;
    const prov = providers.find((p) => p.id === key.provider_id);
    if (!prov) return;
    setTestState((s) => ({ ...s, [id]: { loading: true } }));

    try {
      let resp: Response;

      if (prov.type === "anthropic") {
        resp = await fetch("/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "MiniMax-M1",
            max_tokens: 64,
            messages: [{ role: "user", content: "你好，请用一句话介绍你自己" }],
            stream: false,
          }),
        });
      } else {
        resp = await fetch("/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "glm-4-flash",
            messages: [{ role: "user", content: "你好，请用一句话介绍你自己" }],
            stream: false,
          }),
        });
      }

      if (!resp.ok) {
        const err = await resp.text();
        setTestState((s) => ({
          ...s,
          [id]: { loading: false, ok: false, result: `代理错误 ${resp.status}: ${err}` },
        }));
        return;
      }

      const data = await resp.json();
      // Anthropic format: data.content[0].text; OpenAI format: data.choices[0].message.content
      const content =
        data.content?.[0]?.text ??
        data.choices?.[0]?.message?.content ??
        JSON.stringify(data);
      setTestState((s) => ({
        ...s,
        [id]: { loading: false, ok: true, result: content },
      }));
    } catch (e: any) {
      setTestState((s) => ({
        ...s,
        [id]: { loading: false, ok: false, result: e.message },
      }));
    }
  };

  const providerName = (id: string) =>
    providers.find((p) => p.id === id)?.name ?? id;

  const handleAddGateKey = async () => {
    if (!gkName) return;
    await createGateKey({
      name: gkName,
      format: gkFormat,
      upstream_key_ids: gkSelectedKeys,
    });
    setGkName("");
    setGkFormat("openai");
    setGkSelectedKeys([]);
    reload();
  };

  const handleDeleteGateKey = async (id: string) => {
    if (!confirm("删除该 Gate Key？")) return;
    await deleteGateKey(id);
    reload();
  };

  const toggleUpstreamKey = (ukId: string) => {
    setGkSelectedKeys((prev) =>
      prev.includes(ukId) ? prev.filter((k) => k !== ukId) : [...prev, ukId]
    );
  };

  const upstreamKeyLabel = (ukId: string) => {
    const uk = keys.find((k) => k.id === ukId);
    if (!uk) return ukId;
    const prov = providers.find((p) => p.id === uk.provider_id);
    return `${uk.alias || uk.api_key}${prov ? ` (${prov.name})` : ""}`;
  };

  return (
    <div className="container">
      <h1>LLM Rate Gate</h1>

      <div className="tabs">
        <button className={`tab ${tab === "providers" ? "active" : ""}`} onClick={() => setTab("providers")}>
          服务商 & Key
        </button>
        <button className={`tab ${tab === "gatekeys" ? "active" : ""}`} onClick={() => setTab("gatekeys")}>
          Gate Key
        </button>
      </div>

      {tab === "providers" && (
        <>
          {/* ── 已有服务商 ── */}
          {providers.length > 0 && (
            <div className="card">
              <h2>已有服务商</h2>
              <table>
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>类型</th>
                    <th>Base URL</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {providers.map((p) => (
                    <tr key={p.id}>
                      <td>{p.name}</td>
                      <td>{p.type}</td>
                      <td style={{ fontFamily: "monospace", fontSize: 12 }}>{p.base_url}</td>
                      <td>
                        <button className="btn-danger btn-sm" onClick={() => handleDeleteProvider(p.id)}>
                          删除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ── 添加服务商 ── */}
          <div className="card">
            <h2>添加服务商</h2>
            <div className="form-row">
              <div className="form-group">
                <label>名称</label>
                <input
                  value={provName}
                  onChange={(e) => setProvName(e.target.value)}
                  placeholder="如：智谱 AI"
                />
              </div>
              <div className="form-group">
                <label>类型</label>
                <select
                  value={provType}
                  onChange={(e) => {
                    const t = e.target.value as "openai" | "anthropic";
                    setProvType(t);
                    if (t === "anthropic") {
                      setProvUrl("https://api.minimaxi.com/anthropic");
                    } else {
                      setProvUrl("https://open.bigmodel.cn/api/paas/v4");
                    }
                  }}
                >
                  <option value="openai">OpenAI 兼容</option>
                  <option value="anthropic">Anthropic 兼容</option>
                </select>
              </div>
              <div className="form-group" style={{ flex: 2 }}>
                <label>Base URL</label>
                <input
                  value={provUrl}
                  onChange={(e) => setProvUrl(e.target.value)}
                />
              </div>
              <button
                className="btn-primary"
                onClick={handleAddProvider}
                disabled={!provName || !provUrl}
              >
                添加
              </button>
            </div>
          </div>

          {/* ── 已有 Key ── */}
          {keys.length > 0 && (
            <div className="card">
              <h2>已有 Key</h2>
              <table>
                <thead>
                  <tr>
                    <th>别名</th>
                    <th>服务商</th>
                    <th>API Key</th>
                    <th>RPM</th>
                    <th>TPM</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((k) => {
                    const ts = testState[k.id];
                    return (
                      <tr key={k.id}>
                        <td>{k.alias || "-"}</td>
                        <td>{providerName(k.provider_id)}</td>
                        <td style={{ fontFamily: "monospace", fontSize: 12 }}>{k.api_key}</td>
                        <td>{k.rpm_limit}</td>
                        <td>{k.tpm_limit.toLocaleString()}</td>
                        <td>
                          <div className="actions">
                            <button
                              className="btn-outline btn-sm"
                              onClick={() => handleTestKey(k.id)}
                              disabled={ts?.loading}
                            >
                              {ts?.loading ? "..." : "测试连通"}
                            </button>
                            <button
                              className="btn-outline btn-sm"
                              onClick={() => handleProxyTest(k.id)}
                              disabled={ts?.loading}
                            >
                              {ts?.loading ? "..." : "代理测试"}
                            </button>
                            <button className="btn-danger btn-sm" onClick={() => handleDeleteKey(k.id)}>
                              删除
                            </button>
                          </div>
                          {ts && !ts.loading && (
                            <div
                              className={`test-result ${ts.ok ? "test-ok" : "test-fail"}`}
                            >
                              {ts.result}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* ── 添加 Key ── */}
          {providers.length > 0 && (
            <div className="card">
              <h2>添加 API Key</h2>
              <div className="form-row">
                <div className="form-group">
                  <label>服务商</label>
                  <select value={keyProviderId} onChange={(e) => setKeyProviderId(e.target.value)}>
                    <option value="">请选择...</option>
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>别名</label>
                  <input
                    value={keyAlias}
                    onChange={(e) => setKeyAlias(e.target.value)}
                    placeholder="如：GLM 主力 Key"
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group" style={{ flex: 3 }}>
                  <label>API Key</label>
                  <input
                    type="password"
                    value={keyApiKey}
                    onChange={(e) => setKeyApiKey(e.target.value)}
                    placeholder="粘贴你的 API Key"
                  />
                </div>
                <div className="form-group">
                  <label>RPM 限制</label>
                  <input type="number" value={keyRpm} onChange={(e) => setKeyRpm(Number(e.target.value))} />
                </div>
                <div className="form-group">
                  <label>TPM 限制</label>
                  <input type="number" value={keyTpm} onChange={(e) => setKeyTpm(Number(e.target.value))} />
                </div>
              </div>
              <div className="mt-12">
                <button
                  className="btn-primary"
                  onClick={handleAddKey}
                  disabled={!keyProviderId || !keyApiKey}
                >
                  添加 Key
                </button>
              </div>
            </div>
          )}

          {providers.length === 0 && (
            <div className="card" style={{ textAlign: "center", color: "var(--text-dim)" }}>
              <p>还没有服务商，请先添加一个服务商开始使用</p>
            </div>
          )}
        </>
      )}

      {tab === "gatekeys" && (
        <>
          {/* ── 已有 Gate Key ── */}
          {gateKeys.length > 0 && (
            <div className="card">
              <h2>已有 Gate Key</h2>
              <table>
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>兼容格式</th>
                    <th>Key ID</th>
                    <th>关联上游 Key</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {gateKeys.map((gk) => (
                    <tr key={gk.id}>
                      <td>{gk.name}</td>
                      <td>
                        <span className="badge badge-success">
                          {gk.format === "openai" ? "OpenAI" : "Anthropic"}
                        </span>
                      </td>
                      <td>
                        <code style={{ fontSize: 12, cursor: "pointer" }} onClick={() => {
                          navigator.clipboard.writeText(gk.id);
                        }} title="点击复制">
                          {gk.id}
                        </code>
                      </td>
                      <td>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {gk.upstream_key_ids.length === 0 && (
                            <span style={{ color: "var(--text-dim)", fontSize: 12 }}>未关联</span>
                          )}
                          {gk.upstream_key_ids.map((ukId) => (
                            <span key={ukId} className="badge badge-success" style={{ fontSize: 11 }}>
                              {upstreamKeyLabel(ukId)}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td>
                        <button className="btn-danger btn-sm" onClick={() => handleDeleteGateKey(gk.id)}>
                          删除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ── 生成 Gate Key ── */}
          <div className="card">
            <h2>生成 Gate Key</h2>
            <div className="form-row">
              <div className="form-group">
                <label>名称</label>
                <input
                  value={gkName}
                  onChange={(e) => setGkName(e.target.value)}
                  placeholder="如：OpenClaw 主进程"
                />
              </div>
              <div className="form-group">
                <label>兼容格式</label>
                <select value={gkFormat} onChange={(e) => setGkFormat(e.target.value as "openai" | "anthropic")}>
                  <option value="openai">OpenAI 兼容</option>
                  <option value="anthropic">Anthropic 兼容</option>
                </select>
              </div>
            </div>
            {keys.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <label style={{ fontSize: 12, color: "var(--text-dim)", display: "block", marginBottom: 6 }}>
                  选择可路由的上游 Key Pool
                </label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {keys.map((uk) => {
                    const selected = gkSelectedKeys.includes(uk.id);
                    return (
                      <button
                        key={uk.id}
                        className={selected ? "btn-primary btn-sm" : "btn-outline btn-sm"}
                        onClick={() => toggleUpstreamKey(uk.id)}
                        type="button"
                      >
                        {uk.alias || uk.api_key} ({providerName(uk.provider_id)})
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {keys.length === 0 && (
              <p style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 8 }}>
                还没有上游 Key，请先在「服务商 & Key」页面添加
              </p>
            )}
            <div className="mt-12">
              <button
                className="btn-primary"
                onClick={handleAddGateKey}
                disabled={!gkName}
              >
                生成 Gate Key
              </button>
            </div>
          </div>

          {gateKeys.length === 0 && keys.length > 0 && (
            <div className="card" style={{ textAlign: "center", color: "var(--text-dim)" }}>
              <p>还没有 Gate Key，生成一个用于调用方配置</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

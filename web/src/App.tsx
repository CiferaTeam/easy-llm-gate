import React, { useEffect, useState, useCallback, useRef } from "react";
import {
  fetchProviders,
  fetchBuiltinProviders,
  fetchUpstreamKeys,
  fetchGateKeys,
  createProvider,
  updateProvider,
  deleteProvider,
  createUpstreamKey,
  deleteUpstreamKey,
  testUpstreamKey,
  chatTestUpstreamKey,
  createGateKey,
  deleteGateKey,
  type Provider,
  type BuiltinProvider,
  type UpstreamKey,
  type GateKey,
} from "./api";
import { StatsPage } from "./StatsPage";
import { PromptCachePage } from "./PromptCachePage";

// ── Model Multi-Select with Search ──
function ModelSelector({
  models,
  selected,
  onChange,
}: {
  models: string[];
  selected: string[];
  onChange: (v: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const filtered = models.filter((m) =>
    m.toLowerCase().includes(search.toLowerCase())
  );

  // Also allow typing a custom model not in the list
  const toggle = (model: string) => {
    onChange(
      selected.includes(model)
        ? selected.filter((m) => m !== model)
        : [...selected, model]
    );
  };

  const addCustom = () => {
    const trimmed = search.trim();
    if (trimmed && !selected.includes(trimmed)) {
      onChange([...selected, trimmed]);
    }
    setSearch("");
  };

  return (
    <div className="model-selector" ref={ref}>
      <div className="model-selector-input" onClick={() => setOpen(true)}>
        {selected.map((m) => (
          <span key={m} className="model-tag">
            {m}
            <button onClick={(e) => { e.stopPropagation(); toggle(m); }}>&times;</button>
          </span>
        ))}
        <input
          value={search}
          onChange={(e) => { setSearch(e.target.value); setOpen(true); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); addCustom(); }
            if (e.key === "Backspace" && !search && selected.length) {
              onChange(selected.slice(0, -1));
            }
          }}
          placeholder={selected.length ? "" : "搜索或输入模型名..."}
        />
      </div>
      {open && (filtered.length > 0 || search.trim()) && (
        <div className="model-dropdown">
          {filtered.map((m) => (
            <div
              key={m}
              className={`model-option ${selected.includes(m) ? "selected" : ""}`}
              onClick={() => toggle(m)}
            >
              <span className="check">{selected.includes(m) ? "✓" : ""}</span>
              {m}
            </div>
          ))}
          {search.trim() && !models.includes(search.trim()) && (
            <div className="model-option" onClick={addCustom}>
              <span className="check">+</span>
              添加自定义: {search.trim()}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function App() {
  const [tab, setTab] = useState<"providers" | "gatekeys" | "stats" | "promptcache">("stats");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [builtinProvs, setBuiltinProvs] = useState<BuiltinProvider[]>([]);
  const [keys, setKeys] = useState<UpstreamKey[]>([]);
  const [gateKeys, setGateKeys] = useState<GateKey[]>([]);

  // Provider form
  const [provName, setProvName] = useState("");
  const [provType, setProvType] = useState<"openai" | "anthropic">("openai");
  const [provUrl, setProvUrl] = useState("");
  const [provModels, setProvModels] = useState<string[]>([]);
  // Available models for the selector (from builtin or empty for custom)
  const [availableModels, setAvailableModels] = useState<string[]>([]);

  // Editing state: null = adding new, string = editing provider id
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);

  // Key form
  const [keyProviderId, setKeyProviderId] = useState("");
  const [keyApiKey, setKeyApiKey] = useState("");
  const [keyAlias, setKeyAlias] = useState("");
  const [keyRpm, setKeyRpm] = useState(60);
  const [keyTpm, setKeyTpm] = useState(100000);

  // Gate Key form
  const [gkName, setGkName] = useState("");
  const [gkSelectedKeys, setGkSelectedKeys] = useState<string[]>([]);

  // Test states per key
  const [testState, setTestState] = useState<
    Record<string, { loading: boolean; result?: string; ok?: boolean }>
  >({});

  const reload = useCallback(async () => {
    const [p, bp, k, gk] = await Promise.all([
      fetchProviders(), fetchBuiltinProviders(), fetchUpstreamKeys(), fetchGateKeys(),
    ]);
    setProviders(p);
    setBuiltinProvs(bp);
    setKeys(k);
    setGateKeys(gk);
    return { keys: k };
  }, []);

  useEffect(() => {
    reload().then(({ keys: latestKeys }) => {
      for (const k of latestKeys) {
        handleTestKey(k.id);
      }
    });
  }, [reload]);

  const resetProvForm = () => {
    setProvName("");
    setProvType("openai");
    setProvUrl("");
    setProvModels([]);
    setAvailableModels([]);
    setEditingProviderId(null);
  };

  const handleAddProvider = async () => {
    if (!provName || !provUrl) return;
    await createProvider({ name: provName, type: provType, base_url: provUrl, models: provModels });
    resetProvForm();
    reload();
  };

  // Collect all known models from all providers for suggestion in add mode
  const allModels = Array.from(
    new Set(providers.flatMap((p) => p.models || []))
  );

  const handleEditProvider = (p: Provider) => {
    setEditingProviderId(p.id);
    setProvName(p.name);
    setProvType(p.type as "openai" | "anthropic");
    setProvUrl(p.base_url);
    setProvModels(p.models || []);
    const bp = builtinProvs.find((b) => b.id === p.id);
    setAvailableModels(bp ? bp.models : allModels);
  };

  const handleSaveProvider = async () => {
    if (!editingProviderId || !provName || !provUrl) return;
    await updateProvider(editingProviderId, {
      name: provName,
      type: provType,
      base_url: provUrl,
      models: provModels,
    });
    resetProvForm();
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
    setTestState((s) => ({ ...s, [id]: { loading: true } }));
    try {
      const r = await chatTestUpstreamKey(id);
      setTestState((s) => ({
        ...s,
        [id]: { loading: false, ok: r.ok, result: r.ok ? r.content! : (r.error ?? "请求失败") },
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
      upstream_key_ids: gkSelectedKeys,
    });
    setGkName("");
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

  // Check that all selected upstream keys share the same provider type
  const gkFormatError = (() => {
    if (gkSelectedKeys.length < 2) return "";
    const types = new Set(
      gkSelectedKeys.map((ukId) => {
        const uk = keys.find((k) => k.id === ukId);
        if (!uk) return null;
        return providers.find((p) => p.id === uk.provider_id)?.type ?? null;
      })
    );
    types.delete(null);
    return types.size > 1 ? "所选上游 Key 的服务商格式不一致（混合了 OpenAI 和 Anthropic 类型）" : "";
  })();

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
        <button className={`tab ${tab === "promptcache" ? "active" : ""}`} onClick={() => setTab("promptcache")}>
          Prompt 观测
        </button>
        <button className={`tab ${tab === "stats" ? "active" : ""}`} onClick={() => setTab("stats")}>
          流量统计
        </button>
        <button className={`tab ${tab === "providers" ? "active" : ""}`} onClick={() => setTab("providers")}>
          服务商 & Key
        </button>
        <button className={`tab ${tab === "gatekeys" ? "active" : ""}`} onClick={() => setTab("gatekeys")}>
          Gate Key
        </button>
      </div>

      {tab === "providers" && (
        <>
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

          {/* ── 已有服务商 ── */}
          {providers.length > 0 && (
            <div className="card">
              <h2>已有服务商</h2>
              <table>
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>协议类型</th>
                    <th>Base URL</th>
                    <th>模型</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {providers.map((p) => (
                    <React.Fragment key={p.id}>
                      <tr>
                        <td>
                          {p.name}
                          {p.builtin && <span className="badge badge-builtin" style={{ marginLeft: 6 }}>内置</span>}
                        </td>
                        <td>{p.type}</td>
                        <td style={{ fontFamily: "monospace", fontSize: 12 }}>{p.base_url}</td>
                        <td>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 3, maxWidth: 200 }}>
                            {(p.models || []).slice(0, 3).map((m) => (
                              <span key={m} className="badge badge-success" style={{ fontSize: 10 }}>{m}</span>
                            ))}
                            {(p.models || []).length > 3 && (
                              <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
                                +{p.models.length - 3}
                              </span>
                            )}
                            {(!p.models || p.models.length === 0) && (
                              <span style={{ fontSize: 11, color: "var(--text-dim)" }}>-</span>
                            )}
                          </div>
                        </td>
                        <td>
                          <div className="actions">
                            <button
                              className="btn-outline btn-sm"
                              onClick={() => editingProviderId === p.id ? resetProvForm() : handleEditProvider(p)}
                            >
                              {editingProviderId === p.id ? "收起" : "编辑"}
                            </button>
                            {!p.builtin && (
                              <button className="btn-danger btn-sm" onClick={() => handleDeleteProvider(p.id)}>
                                删除
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {editingProviderId === p.id && (
                        <tr>
                          <td colSpan={5} style={{ padding: "12px 8px", background: "var(--bg)" }}>
                            <div className="form-row">
                              <div className="form-group">
                                <label>名称</label>
                                <input
                                  value={provName}
                                  onChange={(e) => setProvName(e.target.value)}
                                />
                              </div>
                              <div className="form-group">
                                <label>类型</label>
                                <select
                                  value={provType}
                                  onChange={(e) => setProvType(e.target.value as "openai" | "anthropic")}
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
                            </div>
                            <div className="form-group" style={{ marginBottom: 8 }}>
                              <label>模型列表</label>
                              <ModelSelector
                                models={availableModels}
                                selected={provModels}
                                onChange={setProvModels}
                              />
                            </div>
                            <div className="actions">
                              <button
                                className="btn-primary btn-sm"
                                onClick={handleSaveProvider}
                                disabled={!provName || !provUrl}
                              >
                                保存
                              </button>
                              <button className="btn-outline btn-sm" onClick={resetProvForm}>
                                取消
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
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
                  value={editingProviderId ? "" : provName}
                  onChange={(e) => { if (!editingProviderId) setProvName(e.target.value); }}
                  onFocus={() => { if (editingProviderId) resetProvForm(); }}
                  placeholder="如：智谱 AI"
                />
              </div>
              <div className="form-group">
                <label>类型</label>
                <select
                  value={editingProviderId ? "openai" : provType}
                  onChange={(e) => { if (!editingProviderId) setProvType(e.target.value as "openai" | "anthropic"); }}
                  onFocus={() => { if (editingProviderId) resetProvForm(); }}
                >
                  <option value="openai">OpenAI 兼容</option>
                  <option value="anthropic">Anthropic 兼容</option>
                </select>
              </div>
              <div className="form-group" style={{ flex: 2 }}>
                <label>Base URL</label>
                <input
                  value={editingProviderId ? "" : provUrl}
                  onChange={(e) => { if (!editingProviderId) setProvUrl(e.target.value); }}
                  onFocus={() => { if (editingProviderId) resetProvForm(); }}
                  placeholder="https://api.example.com/v1"
                />
              </div>
            </div>
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label>模型列表</label>
              <ModelSelector
                models={allModels}
                selected={editingProviderId ? [] : provModels}
                onChange={(v) => { if (!editingProviderId) setProvModels(v); }}
              />
            </div>
            <button
              className="btn-primary"
              onClick={handleAddProvider}
              disabled={editingProviderId !== null || !provName || !provUrl}
            >
              添加
            </button>
          </div>

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
              <div className="form-group" style={{ flex: 1 }}>
                <label>名称</label>
                <input
                  value={gkName}
                  onChange={(e) => setGkName(e.target.value)}
                  placeholder="如：OpenClaw 主进程"
                />
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
                {gkFormatError && (
                  <p style={{ fontSize: 12, color: "var(--danger)", margin: "6px 0 0" }}>{gkFormatError}</p>
                )}
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
                disabled={!gkName || !!gkFormatError}
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

      {tab === "stats" && <StatsPage />}

      {tab === "promptcache" && <PromptCachePage />}
    </div>
  );
}

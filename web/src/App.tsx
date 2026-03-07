import { useEffect, useState, useCallback } from "react";
import {
  fetchProviders,
  fetchUpstreamKeys,
  createProvider,
  deleteProvider,
  createUpstreamKey,
  deleteUpstreamKey,
  testUpstreamKey,
  type Provider,
  type UpstreamKey,
} from "./api";

export function App() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [keys, setKeys] = useState<UpstreamKey[]>([]);

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

  // Test states per key
  const [testState, setTestState] = useState<
    Record<string, { loading: boolean; result?: string; ok?: boolean }>
  >({});

  const reload = useCallback(async () => {
    const [p, k] = await Promise.all([fetchProviders(), fetchUpstreamKeys()]);
    setProviders(p);
    setKeys(k);
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

  return (
    <div className="container">
      <h1>LLM Rate Gate</h1>

      {/* ── 服务商管理 ── */}
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

      {/* ── Key 管理 ── */}
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

      {providers.length === 0 && (
        <div className="card" style={{ textAlign: "center", color: "var(--text-dim)" }}>
          <p>还没有服务商，请先添加一个服务商开始使用</p>
        </div>
      )}
    </div>
  );
}

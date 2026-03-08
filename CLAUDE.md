# LLM Rate Gate

本地 LLM API 网关。核心理念：**削峰填谷** — 请求超频时不拒绝，排队等令牌桶放行，让流量均匀打到上游。

## 核心架构

单进程 Node.js (Hono) 服务，单端口 16890 同时承载代理 API (`/v1/*`) 和管理 API (`/api/*`)。

三层模型：
- **Provider**: 上游服务商（OpenAI / Anthropic / custom），含 base_url 和 type
- **Upstream Key**: 绑定到 Provider 的 API Key，每个 Key 有独立的 RPM/TPM 限制
- **Gate Key**: 下游调用方使用的 Key，绑定一组 upstream_key_ids，认证时 gate key id 就是 api key 本身

请求流：Gate Key 认证 → 从绑定的 upstream keys 中选一个可用的 → 替换 auth header → 转发到上游 Provider

## 限流与排队

进程内令牌桶（Map），按 `{upstream_key_id}:{rpm|tpm}` 维护。无令牌时请求进内存队列等待，后台调度器 100ms 轮询放行。

## 统计

内存计数器每 5s flush 到 Redis sorted set (`stats:{upstream_key_id}`)，score 为时间戳，member 为 JSON snapshot（rpm/tpm actual vs limit，按 gate key 分维度）。30 天保留。

## 待实现：Prompt Cache 观测

Agent 场景下请求前缀高度重复（system prompt + tool definitions 不变，只有尾部对话变化）。需要按 upstream key 维度观测：

- **前缀指纹**：取 messages 前 K 个 message 做 hash，内存 ring buffer 存最近 N 条 digest（timestamp / model / prefix_hash / suffix_preview / total_tokens）
- **前缀重复率**：窗口内相同 prefix_hash 的比例 → prompt cache 理论上限
- **实际 cache 命中率**：从 Anthropic 响应 usage 中提取 `cache_creation_input_tokens` / `cache_read_input_tokens`，按 upstream key 聚合
- 不存原文，只存指纹和元数据

## 开发备忘

- 前端 Vite dev server 跑在 16891，CORS 已配置
- SQLite (better-sqlite3) WAL 模式存配置，Redis 存时序统计
- Builtin providers 硬编码在 `builtin-providers.ts`，首次添加 key 时自动持久化到 DB
- SSE streaming 透传：读 upstream response body stream，逐 chunk 写给下游，同时尝试从最后 chunk 提取 usage

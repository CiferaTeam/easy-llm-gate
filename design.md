# LLM Rate Gate — 设计文档

> 本地部署的 LLM API 网关，核心能力：令牌桶限流 + 请求排队 + 多 Key 轮转 + 可配置 Fallback

---

## 1. 项目概述

### 1.1 要解决的问题

在使用 OpenClaw 等 Agent 编排工具时，大量并发请求打向多个 LLM 服务商 API，频繁触发 rate limit (429)，甚至导致 IP 被临时封禁。现有方案（LiteLLM、One-API 等）遇到限流时直接拒绝请求，而非排队等待。

### 1.2 核心理念

**削峰填谷**：请求超出频率时不拒绝，而是排队等待令牌桶放行，让流量均匀地打到上游。

### 1.3 技术栈

| 组件 | 选型 | 理由 |
|------|------|------|
| 后端 | **Node.js + Express/Hono** | TypeScript 全栈，AI SDK 生态最好 |
| 前端 | **React (内嵌 SPA)** | 与后端同语言，打包后 serve 静态文件 |
| 限流引擎 | **Redis + Lua 脚本** | 原子令牌桶操作 |
| 排队 | **Redis List** | LPUSH/BRPOP 实现请求队列 |
| 存储 | **Redis** | 所有配置、Key、统计 |
| 部署 | **docker-compose** | 单 compose 文件：app + redis |

---

## 2. 架构设计

```
┌─────────────────────────────────────────────────┐
│                    调用方                         │
│  OpenClaw / Cursor / 任意 OpenAI-compatible 客户端 │
│       配置 base_url → http://localhost:9090       │
│       配置 api_key → sk-local-xxxxx              │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────┐
│              LLM Rate Gate (本地网关)              │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ 认证中间件 │→│ 路由分发  │→│  令牌桶 + 排队  │  │
│  │ (下游Key) │  │(model→   │  │  (Redis Lua)  │  │
│  │          │  │ provider) │  │               │  │
│  └──────────┘  └──────────┘  └───────┬───────┘  │
│                                      │          │
│  ┌──────────┐  ┌──────────┐  ┌───────▼───────┐  │
│  │ 统计模块  │←│ 响应处理  │←│  上游 Key 选择  │  │
│  │          │  │ (SSE转发) │  │  + 转发请求    │  │
│  └──────────┘  └──────────┘  └───────────────┘  │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │            管理 Web UI (:9091)            │    │
│  │  上游配置 | 下游Key管理 | 统计面板         │    │
│  └──────────────────────────────────────────┘    │
└──────────────────────────────────────────────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
     ┌─────────┐ ┌─────────┐ ┌──────────┐
     │ OpenAI  │ │Anthropic│ │ 其他服务商 │
     │  API    │ │  API    │ │(可扩展)   │
     └─────────┘ └─────────┘ └──────────┘
```

---

## 3. 数据模型 (Redis)

### 3.1 上游 Provider 配置

```
# Hash: provider:{id}
provider:openai → {
  id: "openai",
  name: "OpenAI",
  type: "openai",              # openai | anthropic | custom
  base_url: "https://api.openai.com/v1",
  created_at: timestamp
}
```

### 3.2 上游 API Key

```
# Hash: upstream_key:{id}
upstream_key:uk_001 → {
  id: "uk_001",
  provider_id: "openai",
  api_key: "sk-proj-xxxxxx",        # 明文存储（本地部署）
  alias: "OpenAI主力Key",
  models: ["gpt-4o", "gpt-4o-mini"],  # 该 Key 允许的模型列表（空=全部）
  rpm_limit: 60,                     # 每分钟请求数上限
  tpm_limit: 150000,                 # 每分钟 Token 上限
  fallback_enabled: true,            # 是否允许作为其他 Key 的 fallback
  enabled: true,
  health: "healthy",                 # healthy | cooldown | disabled
  cooldown_until: null,              # 冷却结束时间
  created_at: timestamp
}

# Set: 快速查询某 provider 下的所有 key
provider_keys:openai → ["uk_001", "uk_002", ...]
```

### 3.3 下游 API Key

```
# Hash: downstream_key:{id}
downstream_key:sk-local-abc123 → {
  id: "sk-local-abc123",
  name: "OpenClaw主进程",
  user_id: "user_default",
  enabled: true,
  created_at: timestamp
}

# Set: 所有下游 Key 列表
downstream_keys → ["sk-local-abc123", "sk-local-def456", ...]
```

### 3.4 令牌桶状态 (由 Lua 脚本管理)

```
# Hash: token_bucket:{upstream_key_id}:rpm
token_bucket:uk_001:rpm → {
  tokens: 58.5,           # 当前可用令牌数
  last_refill: timestamp  # 上次填充时间
}

# Hash: token_bucket:{upstream_key_id}:tpm
token_bucket:uk_001:tpm → {
  tokens: 148000,
  last_refill: timestamp
}
```

### 3.5 统计数据

```
# Hash: stats:downstream:{key_id}:{date}
stats:downstream:sk-local-abc123:2025-03-07 → {
  total_requests: 150,
  success: 140,
  failed: 10,
  total_tokens: 250000,
  queued_requests: 30,
  avg_queue_wait_ms: 1200
}

# Hash: stats:upstream:{key_id}:{date}
stats:upstream:uk_001:2025-03-07 → {
  total_requests: 80,
  success: 78,
  rate_limited: 2,
  total_tokens: 120000
}
```

---

## 4. 核心流程

### 4.1 请求处理流程

```
1. 请求到达 → 提取 Authorization header
2. 认证：校验下游 Key 是否有效
3. 解析请求体：提取 model 名称
4. 路由：model → provider 映射
   - 查找 model 对应的 provider
   - 获取该 provider 下所有 enabled 的上游 Key
5. Key 选择策略：
   a. 过滤：只保留 models 列表匹配的 Key（或 models 为空的通配 Key）
   b. 排序：优先选令牌桶余量最大的 Key
   c. 令牌桶检查 (Redis Lua)：
      - 有令牌 → 扣减令牌，立即转发
      - 无令牌 → 进入排队
6. 排队等待：
   - 将请求放入 Redis Queue
   - 后台调度器轮询：令牌桶有余量时从队列取出请求并转发
   - 超过 max_queue_timeout (默认 30s) → 返回 503
7. 转发请求到上游：
   - 替换 Authorization header 为上游 Key
   - 支持 SSE streaming 透传
8. 响应处理：
   - 解析 usage 字段，扣减 TPM 令牌
   - 记录统计数据
   - 如果上游返回 429 → 将该 Key 标记为 cooldown
   - 如果上游返回 401/403 → 将该 Key 标记为 disabled
9. Fallback（可选）：
   - 如果当前 Key 失败且 fallback_enabled=true
   - 自动尝试同 provider 下的其他可用 Key
   - 如果该 Key 的 fallback_enabled=false → 不 fallback，直接返回错误
```

### 4.2 令牌桶 Lua 脚本 (核心)

```lua
-- token_bucket.lua
-- KEYS[1] = bucket key (e.g. token_bucket:uk_001:rpm)
-- ARGV[1] = capacity (max tokens)
-- ARGV[2] = refill_rate (tokens per second)
-- ARGV[3] = now (current timestamp in ms)
-- ARGV[4] = tokens_needed (usually 1 for RPM)
--
-- Returns: {allowed(0/1), current_tokens, wait_time_ms}

local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local needed = tonumber(ARGV[4])

local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens = tonumber(bucket[1])
local last_refill = tonumber(bucket[2])

-- 初始化
if tokens == nil then
  tokens = capacity
  last_refill = now
end

-- 补充令牌
local elapsed = (now - last_refill) / 1000.0  -- convert to seconds
local refill = elapsed * refill_rate
tokens = math.min(capacity, tokens + refill)
last_refill = now

-- 尝试消费
if tokens >= needed then
  tokens = tokens - needed
  redis.call('HMSET', key, 'tokens', tokens, 'last_refill', last_refill)
  redis.call('EXPIRE', key, 120)
  return {1, math.floor(tokens * 100) / 100, 0}
else
  -- 计算需要等待的时间
  local deficit = needed - tokens
  local wait_ms = math.ceil((deficit / refill_rate) * 1000)
  redis.call('HMSET', key, 'tokens', tokens, 'last_refill', last_refill)
  redis.call('EXPIRE', key, 120)
  return {0, math.floor(tokens * 100) / 100, wait_ms}
end
```

### 4.3 排队调度器

```
后台循环（每 100ms 一次）：
  for each provider:
    for each upstream_key (enabled & healthy):
      检查令牌桶是否有余量
      如果有 → 从该 provider 的等待队列取出请求
      转发并处理响应
```

---

## 5. API 设计

### 5.1 代理 API（供调用方使用）

**端口: 9090**

| 路径 | 方法 | 兼容 | 说明 |
|------|------|------|------|
| `/v1/chat/completions` | POST | OpenAI | Chat 补全 |
| `/v1/completions` | POST | OpenAI | 文本补全 |
| `/v1/embeddings` | POST | OpenAI | Embedding |
| `/v1/models` | GET | OpenAI | 模型列表 |
| `/v1/messages` | POST | Anthropic | Anthropic Messages |

### 5.2 管理 API（供 Web UI 使用）

**端口: 9091**

```
# Provider 管理
GET    /api/providers              # 列出所有 provider
POST   /api/providers              # 创建 provider
PUT    /api/providers/:id          # 更新 provider
DELETE /api/providers/:id          # 删除 provider

# 上游 Key 管理
GET    /api/upstream-keys          # 列出所有上游 Key
POST   /api/upstream-keys          # 添加上游 Key
PUT    /api/upstream-keys/:id      # 更新上游 Key
DELETE /api/upstream-keys/:id      # 删除上游 Key
POST   /api/upstream-keys/:id/test # 测试 Key 可用性

# 下游 Key 管理
GET    /api/downstream-keys        # 列出所有下游 Key
POST   /api/downstream-keys        # 生成下游 Key
PUT    /api/downstream-keys/:id    # 更新下游 Key
DELETE /api/downstream-keys/:id    # 删除下游 Key

# 模型路由
GET    /api/model-routes           # 列出模型 → provider 映射
POST   /api/model-routes           # 添加映射
DELETE /api/model-routes/:model    # 删除映射

# 统计
GET    /api/stats/overview         # 总览（今日请求量、排队量等）
GET    /api/stats/downstream/:id   # 下游 Key 统计详情
GET    /api/stats/upstream/:id     # 上游 Key 统计详情
GET    /api/stats/queue            # 当前队列状态

# 系统
GET    /api/health                 # 健康检查
GET    /api/config                 # 当前运行配置
```

---

## 6. Web UI 设计

简洁的单页应用，4 个 Tab：

### Tab 1: Dashboard（总览）
- 今日请求总量 / 成功率 / 平均排队时间
- 各 Provider 的实时令牌桶状态（进度条显示余量）
- 当前排队请求数
- 最近 24h 请求量折线图

### Tab 2: Providers & Keys（上游管理）
- Provider 列表（卡片式）
  - 展开后显示该 Provider 下的所有上游 Key
  - 每个 Key 显示：别名、RPM/TPM 限制、当前令牌桶状态、健康状态
  - 操作：编辑、禁用、删除、测试连通性
- 添加 Provider / 添加 Key 的表单
- 每个 Key 可选择：绑定模型列表、是否允许 Fallback

### Tab 3: Local Keys（下游 Key 管理）
- 下游 Key 列表
  - 显示：名称、Key（可复制）、创建时间、今日调用量
  - 操作：禁用、删除
- 一键生成新 Key

### Tab 4: Logs（日志 & 统计）
- 实时请求日志流（最近 100 条）
  - 时间、下游Key、模型、上游Key、状态、耗时、排队时间
- 按日期查看统计

---

## 7. Fallback 机制设计

这是你提到的重点需求，设计如下：

### 7.1 Key 级别的 Fallback 配置

每个上游 Key 有两个相关字段：
- `models`: 该 Key 绑定的模型列表
  - 空列表 = 通配（该 Provider 下所有模型都可用）
  - 非空 = 只有列表中的模型才能使用这个 Key
- `fallback_enabled`: 是否允许作为 fallback 目标
  - `true` = 当其他 Key 失败时，可以 fallback 到这个 Key
  - `false` = 这个 Key 只在直接路由时使用，不作为 fallback 目标

### 7.2 Fallback 触发条件

- 上游返回 429（rate limit）
- 上游返回 5xx（服务端错误）
- 连接超时

### 7.3 Fallback 流程

```
请求 model=gpt-4o：
  1. 找到所有匹配的上游 Key（models 包含 gpt-4o 或 models 为空）
  2. 按令牌桶余量排序，选择最优 Key
  3. 转发请求
  4. 如果失败：
     a. 从剩余 Key 中筛选 fallback_enabled=true 的
     b. 选下一个可用 Key 重试
     c. 如果没有可用 Key → 返回排队等待
  5. 如果所有 Key 都失败 → 返回错误
```

### 7.4 使用场景举例

```
# Key A: 只用于 gpt-4o，不做 fallback
upstream_key:uk_A → {
  models: ["gpt-4o"],
  fallback_enabled: false  # 别人失败了不要用我
}

# Key B: 通配 Key，可以作为 fallback
upstream_key:uk_B → {
  models: [],              # 通配
  fallback_enabled: true   # 可以接 fallback 流量
}

# Key C: 只用于 embedding，不做 fallback
upstream_key:uk_C → {
  models: ["text-embedding-3-small"],
  fallback_enabled: false
}
```

---

## 9. Docker 部署

```yaml
# docker-compose.yml
version: '3.8'

services:
  app:
    build: .
    ports:
      - "9090:9090"   # 代理端口
      - "9091:9091"   # 管理端口
    environment:
      - REDIS_URL=redis://redis:6379
      - PROXY_PORT=9090
      - ADMIN_PORT=9091
      - MAX_QUEUE_TIMEOUT=30000     # 最大排队等待 30s
      - QUEUE_POLL_INTERVAL=100     # 调度器轮询间隔 100ms
    depends_on:
      - redis

  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data
    command: redis-server --appendonly yes

volumes:
  redis-data:
```

---

## 10. 开发计划

### Phase 1: 核心骨架 (MVP)
- [ ] 项目初始化、TypeScript + Express 搭建
- [ ] Redis 连接 + 数据模型
- [ ] OpenAI 格式代理转发（含 SSE streaming）
- [ ] 令牌桶实现 (Redis Lua)
- [ ] 基础排队机制
- [ ] 上游 Key 管理 API
- [ ] 下游 Key 认证

### Phase 2: Anthropic 兼容 + Fallback
- [ ] Anthropic Messages API 代理
- [ ] Fallback 机制（可配置）
- [ ] Key 健康检查 + 自动 cooldown

### Phase 3: Web UI + 统计
- [ ] React SPA 骨架
- [ ] Dashboard 总览
- [ ] Provider / Key 管理页面
- [ ] 下游 Key 管理页面
- [ ] 实时日志 + 统计

### Phase 4: Docker 化
- [ ] Dockerfile
- [ ] docker-compose.yml
- [ ] 一键启动脚本

---

## 11. 配置说明

首次启动后，通过 Web UI (http://localhost:9091) 或管理 API 进行配置：

1. **添加 Provider**：配置服务商名称、类型、Base URL
2. **添加上游 Key**：填入 API Key、设置 RPM/TPM 限制、绑定模型、配置 Fallback
3. **生成下游 Key**：一键生成，复制到 OpenClaw 的 provider 配置中
4. **在 OpenClaw 中配置**：
   ```
   base_url: http://localhost:9090/v1
   api_key: sk-local-xxxxx
   ```

---

*文档版本: v0.1 | 最后更新: 2026-03-07*
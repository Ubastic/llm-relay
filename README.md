# llm-relay — 多平台多 Key 中转池

零依赖（仅需 Node ≥ 18）的本地 LLM API 中转代理：把多个平台的一堆 key 池化，
哪个 key 没余额/失效就自动剔除换下一个，同时打通 OpenAI 与 Anthropic 两种协议。

## 启动

```
start.bat        （或手动：node server.js）
```

管理页：http://localhost:8788/ （端口在 config.json 里改，默认 8788）

## 接入方式

| 客户端 | 配置 |
|---|---|
| codex / zcode / 各类 OpenAI 客户端 | `base_url = http://localhost:8788/v1`，key 随意（若设了 proxyKey 则填它） |
| Claude Code | 环境变量 `ANTHROPIC_BASE_URL=http://localhost:8788` |
| 查模型列表 | `GET http://localhost:8788/v1/models`（自动聚合所有平台） |

## 平台配置（管理页操作）

- **平台名称 / Base URL / 协议**：协议选 `OpenAI`（上游走 /chat/completions）或 `Anthropic`（上游走 /v1/messages）。URL 带不带 `/v1` 都行，自动补。
- **限定模型**：填了就只有这些模型路由到该平台；留空 = 兜底接住所有模型。多个平台都接同一个模型时按配置顺序 fallback。
- **API Keys**：一行一个，整段粘贴即可，自动去重。已存在的 key 保留状态。

## key 轮换规则

请求失败时按类型自动处理并换下一个 key（跨平台继续重试，预算为「10 次 / alive key 总数」的较大者）：

| 错误类型 | 识别方式 | 处理 |
|---|---|---|
| 无余额 | HTTP 402 / `INSUFFICIENT_BALANCE` / `insufficient_quota` / `余额不足` 等 | key 永久剔除（管理页可一键恢复） |
| 无效 key | 401/403 / `invalid api key` / `令牌无效` 等 | key 永久剔除 |
| 账号冻结/封禁 | `计费账户已被冻结` / `封禁` / `停用` 等（即便返回 400） | 按 key 级永久问题处理：标记无效并换下一个 key，不会反复撞这把 key |
| 限流 | 429 / `rate limit` 等 | 该 key 冷却 60 秒（`rateCooldownSec` 可调），冷却时长带 ±25% 抖动 |
| 网络/5xx | 超时、连接失败 | 连续 3 次失败后冷却 2 分钟 |
| 单次尝试超时 | 上游连上但 `attemptTimeoutSec`（默认 300s，管理页「尝试超时」可调）内不返回响应头 | 按 transient 处理换下一个 key |
| 模型不存在 / 400 | `MODEL_NOT_AVAILABLE`、参数错误等 | 不换 key；模型不存在则换下一个平台，参数错误原样返回给客户端 |

规则匹配的是响应文本，各家中转站格式不一也能兜住；实测 tokenrhythm 返回
`HTTP 402 {"code":"INSUFFICIENT_BALANCE","message":"余额不足"}` 会被正确剔除。

### 并发分摊（LRU 选 key）

key 不再按配置顺序使用，而是**最久未用优先**，且派发即更新占用时间——并发请求会
自动分摊到不同 key 上，避免所有在途请求压同一把 key 触发同步限流/冷却级联。
多客户端并发（如多线程回测）场景直接受益；冷却抖动避免多把 key 同时到期后再同步相撞。

## 端点

| 本地端点 | 说明 |
|---|---|
| `POST /v1/chat/completions` | OpenAI 格式，流式/非流式 |
| `POST /v1/messages` | Claude 格式（含 thinking 块），流式/非流式，Claude Code 直接用 |
| `POST /v1/messages/count_tokens` | 上游支持则转发，否则本地估算 |
| `POST /v1/responses` `POST /v1/embeddings` `POST /v1/completions` | 仅透传给 OpenAI 协议平台 |
| `GET /v1/models` | 聚合所有平台的模型列表（缓存 60 秒） |

上游协议与客户端协议不同时自动转换（如 Claude Code → OpenAI 上游、OpenAI 客户端 → Anthropic 上游），
支持文本、推理内容（reasoning_content↔thinking）、工具调用（含流式增量参数）；
同协议直通路径对 reasoning_content 等扩展字段一律原样透传，流式与非流式行为一致。

## 出站代理

需要经代理访问上游平台时（如直连不通的官方 API），零依赖支持 `http` / `https` / `socks5` / `socks5h`
（socks5 本地解析域名，socks5h 由代理解析），账号密码写在 URL 里：`socks5://user:pass@host:port`。

- **全局代理**：管理页顶部「全局出站代理」，或 config.json 的 `proxyUrl`，或环境变量 `RELAY_PROXY` / `HTTPS_PROXY`。
- **平台级代理**：平台编辑框里的「上游代理」，留空 = 跟随全局，填 `direct` = 强制直连。
- 流式/非流式、模型列表、key 测试都走代理；管理页本身不受影响。改完即时生效，无需重启。

## 配置备份与密码保护

- **导出/导入**：管理页右上角「导出配置 / 导入配置」。导出为完整 JSON（平台、key、代理、proxyKey 等，**内含明文 key，注意保管**）；导入会覆盖当前全部设置与平台，key 的状态（无效/停用等）一并恢复。
- **管理页密码**：设置环境变量 `RELAY_ADMIN_PASSWORD`（或 `ADMIN_PASSWORD`）后，打开管理页需先输入密码登录（Cookie 保持 30 天，重启不失效）；不设置则维持原样直接访问。中转端点 `/v1/*` 不受影响，仍由 proxyKey 控制；脚本调用管理接口仍可用 `x-admin-key`。

## 安全

- 默认只监听 `127.0.0.1`，局域网访问不到。
- 建议在管理页设置 `proxyKey`：设置后所有中转请求和管理页都需要它。
- key 明文存在 `config.json`（同目录），管理页里只显示掩码。

## 自测

```
node tests/mock.js          # 起两个 mock 上游（9101 OpenAI 协议 / 9102 Anthropic 协议）
node server.js --port 8790  # 再起一个中转实例
# 然后在管理页添加指向 127.0.0.1:9101/9102 的平台即可验证轮换与转换

node tests/proxy.test.js    # 一键自测出站代理：脚本内自建 mock 上游 + HTTP 代理 + SOCKS5 代理
node tests/reasoning.test.js # 一键自测推理内容透传：reasoning_content/thinking 在流式与非流式、跨协议转换下均不丢失
node tests/frozen.test.js   # 一键自测账号冻结类错误：key 自动剔除并换下一个，不透传给客户端
node tests/admin.test.js    # 一键自测配置导出/导入与管理页密码保护
```

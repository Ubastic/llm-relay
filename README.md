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

请求失败时按类型自动处理并换下一个 key（跨平台继续重试，最多 10 次）：

| 错误类型 | 识别方式 | 处理 |
|---|---|---|
| 无余额 | HTTP 402 / `INSUFFICIENT_BALANCE` / `insufficient_quota` / `余额不足` 等 | key 永久剔除（管理页可一键恢复） |
| 无效 key | 401/403 / `invalid api key` / `令牌无效` 等 | key 永久剔除 |
| 限流 | 429 / `rate limit` 等 | 该 key 冷却 60 秒（`rateCooldownSec` 可调） |
| 网络/5xx | 超时、连接失败 | 连续 3 次失败后冷却 2 分钟 |
| 模型不存在 / 400 | `MODEL_NOT_AVAILABLE`、参数错误等 | 不换 key；模型不存在则换下一个平台，参数错误原样返回给客户端 |

规则匹配的是响应文本，各家中转站格式不一也能兜住；实测 tokenrhythm 返回
`HTTP 402 {"code":"INSUFFICIENT_BALANCE","message":"余额不足"}` 会被正确剔除。

## 端点

| 本地端点 | 说明 |
|---|---|
| `POST /v1/chat/completions` | OpenAI 格式，流式/非流式 |
| `POST /v1/messages` | Claude 格式（含 thinking 块），流式/非流式，Claude Code 直接用 |
| `POST /v1/messages/count_tokens` | 上游支持则转发，否则本地估算 |
| `POST /v1/responses` `POST /v1/embeddings` `POST /v1/completions` | 仅透传给 OpenAI 协议平台 |
| `GET /v1/models` | 聚合所有平台的模型列表（缓存 60 秒） |

上游协议与客户端协议不同时自动转换（如 Claude Code → OpenAI 上游、OpenAI 客户端 → Anthropic 上游），
支持文本、推理内容（reasoning↔thinking）、工具调用（含流式增量参数）。

## 出站代理

需要经代理访问上游平台时（如直连不通的官方 API），零依赖支持 `http` / `https` / `socks5` / `socks5h`
（socks5 本地解析域名，socks5h 由代理解析），账号密码写在 URL 里：`socks5://user:pass@host:port`。

- **全局代理**：管理页顶部「全局出站代理」，或 config.json 的 `proxyUrl`，或环境变量 `RELAY_PROXY` / `HTTPS_PROXY`。
- **平台级代理**：平台编辑框里的「上游代理」，留空 = 跟随全局，填 `direct` = 强制直连。
- 流式/非流式、模型列表、key 测试都走代理；管理页本身不受影响。改完即时生效，无需重启。

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
```

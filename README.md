# llm-relay — 多平台多 Key 中转池

零依赖（仅需 Node ≥ 18）的本地 LLM API 中转代理：把多个平台的一堆 key 池化，
哪个 key 没余额/失效就自动剔除换下一个，同时打通 OpenAI 与 Anthropic 两种协议。
支持 Docker 一键部署到 Linux 服务器，管理页密码登录 + API key 调用鉴权。

## 启动

### 方式一：Docker（推荐，服务器部署）

要求：Ubuntu 22.04 等任意装了 Docker（含 compose 插件）的 Linux 服务器。
没装的话：`curl -fsSL https://get.docker.com | sh`（官方脚本，装完自带 compose 插件）。

#### 国内服务器：镜像加速（docker.io 拉不到时）

**方式一（本项目已内置）**：`.env` 里把基础镜像指到国内镜像站（`.env.example` 默认已启用 DaoCloud）：

```
IMAGE_REGISTRY=docker.m.daocloud.io/library
# 备选：docker.1panel.live/library、docker.1ms.run；失效就换一个
```

改完重新构建启动：`docker compose build --no-cache && docker compose up -d`。

**方式二（服务器全局，一劳永逸，root 执行）**：给 Docker 配 registry-mirrors，之后所有 `docker pull` 都走加速：

```bash
sudo tee /etc/docker/daemon.json <<'EOF'
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://docker.1panel.live",
    "https://docker.1ms.run"
  ]
}
EOF
sudo systemctl daemon-reload && sudo systemctl restart docker
```

注意：已有 `/etc/docker/daemon.json` 的话把 `registry-mirrors` 字段合并进去，别整个覆盖；镜像站可用性随时间变化，失效换一个即可（阿里云/腾讯云控制台也提供登录用户专属的加速地址）。配了方式二就不用再设 `IMAGE_REGISTRY`，注释掉即可回落 `docker.io`。

顺带：国内装 Docker 本身慢/失败的话，用官方脚本的 Aliyun 源：`curl -fsSL https://get.docker.com | sh -s -- --mirror Aliyun`。

#### 部署步骤

```bash
# 1. 把整个项目目录传到服务器（git clone 或 scp -r 都行）
scp -r llm-relay user@your-server:~/

# 2. 服务器上：配置鉴权
cd ~/llm-relay
cp .env.example .env
vim .env          # 改 RELAY_PORT / ADMIN_PASSWORD / API_KEYS

# 3. 启动（配置与 key 池状态持久化在 docker 卷 relay-data 里）
docker compose up -d --build

# 查看日志 / 停止
docker compose logs -f
docker compose down
```

打开 `http://<服务器IP>:8787/` → 输入 `ADMIN_PASSWORD` 登录管理页。
云服务器记得在安全组/防火墙放行 `RELAY_PORT` 端口。

说明：

- config.json 存在容器卷 `/data` 里，重建容器不丢。查看：`docker exec llm-relay cat /data/config.json`。
- 想直接用本地已有的 config.json：把它放进宿主机某目录后改用绑定挂载，注意属主要与容器内 node 用户（uid 1000）一致：
  ```yaml
  volumes:
    - ./data:/data        # 替代 relay-data:/data，先执行 sudo chown -R 1000:1000 ./data
  ```
- 改了 `.env` 后：`docker compose up -d` 重建即可（数据不丢）。

### 方式二：本机直接跑

```
start.bat        （Windows，或手动：node server.js）
```

管理页：http://localhost:8788/ （端口在 config.json 里改，默认 8788）。
本机跑也会自动读取项目目录下的 `.env`（不存在则忽略），鉴权行为与 Docker 一致。

## 鉴权（.env / 环境变量）

| 环境变量 | 作用 | 说明 |
|---|---|---|
| `ADMIN_PASSWORD`（或 `RELAY_ADMIN_PASSWORD`） | 管理页登录密码 | 设置后打开管理页必须先登录（Cookie 保持 30 天，重启不失效；改密码即全员下线）。登录有防爆破限速：单 IP 10 分钟错 10 次锁定 |
| `API_KEYS` | 客户端调用密钥 | 逗号分隔可配多个，给不同客户端发不同的 key，停用某客户端只删对应的 key。调用 `/v1/*` 必须携带 `Authorization: Bearer <key>` 或 `x-api-key: <key>` |
| `RELAY_PORT` | 监听端口 | 默认 8787（Docker 里宿主机端口 = 容器端口，改这一处即可） |
| `RELAY_HOST` | 监听地址 | 本地默认 `127.0.0.1`；Docker 里 compose 固定为 `0.0.0.0` |
| `RELAY_PROXY` | 全局出站代理 | 见下方「出站代理」 |

- 管理页里设置的 `proxyKey` 会并入合法调用 key 列表（向后兼容）；`API_KEYS` 和 proxyKey 都没配时维持原行为放行所有调用（本地/自测用），**公网部署务必在 `.env` 配 `API_KEYS`**。
- 脚本调用管理接口：登录 Cookie，或 `x-admin-key`（管理密码或 proxyKey 均可）。
- 生产建议前面再套一层 nginx/caddy 做 HTTPS，否则密码与 key 走明文 HTTP。

## 接入方式

| 客户端 | 配置 |
|---|---|
| codex / zcode / 各类 OpenAI 客户端 | `base_url = http://localhost:8788/v1`，API key 填 `API_KEYS` 之一（没配则填 proxyKey，都没配则随意） |
| Claude Code | 环境变量 `ANTHROPIC_BASE_URL=http://localhost:8788`，`ANTHROPIC_AUTH_TOKEN` 同上 |
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
- **管理页密码**：设置环境变量 `RELAY_ADMIN_PASSWORD`（或 `ADMIN_PASSWORD`，Docker 在 `.env` 里配）后，打开管理页需先输入密码登录（Cookie 保持 30 天，重启不失效），页内可「退出登录」；密码错误有 800ms 延迟 + 单 IP 限速拖慢爆破。中转端点 `/v1/*` 不走密码门，由 `API_KEYS` / proxyKey 控制；脚本调用管理接口可用 `x-admin-key`（管理密码或 proxyKey 均可）。

## 安全

- 本地默认只监听 `127.0.0.1`，局域网访问不到；Docker 部署由端口映射控制暴露面。
- 调用鉴权：`.env` 的 `API_KEYS`（可多个）或管理页设置的 `proxyKey`，任一命中放行；都没配时放行所有调用（仅适合本机）。
- key 明文存在 `config.json`（本地目录或 Docker 卷 `/data`），管理页里只显示掩码。
- `.env`、`config.json`、`config-*.json` 均已被 `.gitignore` / `.dockerignore` 排除，不会入库或打进镜像。

## 自测

```
node tests/mock.js          # 起两个 mock 上游（9101 OpenAI 协议 / 9102 Anthropic 协议）
node server.js --port 8790  # 再起一个中转实例
# 然后在管理页添加指向 127.0.0.1:9101/9102 的平台即可验证轮换与转换

node tests/proxy.test.js    # 一键自测出站代理：脚本内自建 mock 上游 + HTTP 代理 + SOCKS5 代理
node tests/reasoning.test.js # 一键自测推理内容透传：reasoning_content/thinking 在流式与非流式、跨协议转换下均不丢失
node tests/frozen.test.js   # 一键自测账号冻结类错误：key 自动剔除并换下一个，不透传给客户端
node tests/admin.test.js    # 一键自测配置导出/导入与管理页密码保护
node tests/concurrency.test.js # 一键自测并发分摊：LRU 选 key、多请求自动分摊到不同 key
```

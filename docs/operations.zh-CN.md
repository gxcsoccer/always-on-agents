# 运维

[English](operations.md) | **简体中文**

## 部署

需要一个开通了 Workers Paid 套餐（用到 Durable Objects 和 Containers）并启用了 R2 的 Cloudflare 账号，以及部署所用机器上一个兼容 Docker 的运行时：`wrangler deploy` 会构建沙箱镜像。

```bash
pnpm install
pnpm exec wrangler login
pnpm exec wrangler r2 bucket create always-on-agent-checkpoints

pnpm exec wrangler secret put OPENAI_API_KEY
pnpm exec wrangler secret put ADMIN_KEY          # 一个足够长的随机字符串

pnpm run deploy
```

Worker 的地址是 `https://always-on-agent.<你的子域>.workers.dev`。如果还想用自己的域名，在 `wrangler.jsonc` 里加一条 route（文件里有一条注释掉的示例），或者部署时加上 `--domain agent.example.com`。

之后创建租户（见下文），再把外部系统接上来：见 [Connector](connectors.zh-CN.md)。

部署会重启 Durable Object。进行中的 run 会依据对话记录继续，沙箱任务保留自己的容器，飞书长连接在几秒内重连。

## 配置

普通变量写在 `wrangler.jsonc` 里；密钥用 `wrangler secret put` 设置（本地开发写在 `.dev.vars` 里，参考 `.dev.vars.example`）。

| 名称 | 类型 | 用途 |
|---|---|---|
| `OPENAI_BASE_URL` | 变量 | Brain 的模型请求发往哪里，也是沙箱代理唯一放行模型流量的地址。沙箱里的 agent 本身是用它内置的 OpenAI 配置启动的，并不知道这个地址，所以目前请保持为 OpenAI 的接口：改成别处后聊天仍然正常，但沙箱任务会失败 |
| `BRAIN_MODEL` | 变量 | Brain 使用的模型 |
| `WORKER_MODEL` | 变量 | 沙箱里的 agent 使用的模型，也是沙箱唯一能调用的模型 |
| `OPENAI_API_KEY` | 密钥，必填 | 上述服务的密钥。它不会进入容器，由出站代理加上 |
| `ADMIN_KEY` | 密钥，必填 | 保护管理接口 |
| `GITHUB_APP_ID`、`GITHUB_APP_PRIVATE_KEY` | 密钥 | agent 所使用的 GitHub App。配置后，令牌按安装和仓库签发 |
| `GITHUB_WEBHOOK_SECRET` | 密钥 | App 的 webhook secret |
| `GITHUB_BOT_HANDLE` | 密钥 | agent 在 GitHub 上的账号名（App 的 slug），人们用它来 @ agent |
| `GITHUB_BOT_EMAIL` | 密钥 | 沙箱里提交代码时使用的邮箱 |
| `GITHUB_TOKEN` | 密钥 | 一个用于所有仓库的令牌，只在没有配置 App 时使用。仅限本地开发 |
| `GATE_HOLD_PATTERN` | 密钥或变量 | 可选。一个正则，匹配到的沙箱内 shell 命令需要人批准。默认没有 |

沙箱里用哪个 coding agent、哪个版本，写死在 `Dockerfile` 里。

## 管理接口

每个请求都带 `authorization: Bearer $ADMIN_KEY`。管理密钥只有一个，下面的事它都能做，请按这个分量保管。

### 租户和登记

| 请求 | 请求体 | 作用 |
|---|---|---|
| `POST /v1/admin/tenants` | `{"id","name"}` | 创建租户并返回一个 API key，只显示一次。对同一个租户再次调用会再签发一个 key，之前的 key 仍然有效。服务端只保存 key 的哈希 |
| `POST /v1/admin/tenants/:id/github-installations` | `{"installation_id"}` | 声明某次 GitHub App 安装属于这个租户 |
| `POST /v1/admin/tenants/:id/github-repos` | `{"repo":"owner/name"}` | 为单仓库 webhook 登记一个仓库。返回 `webhook_secret`，只显示一次。对同一个仓库再次调用会立刻更换 secret，用旧 secret 配置的 webhook 在更新之前将不再被接受 |
| `POST /v1/admin/tenants/:id/identities` | `{"provider","external_id","user_id"}` | 声明某个外部账号（GitHub 用数字 id）是这个租户的用户 |
| `POST /v1/admin/tenants/:id/feishu-apps` | `{"app_id","app_secret","bot_open_id","transport", ...}` | 登记或更新一个飞书应用。`transport` 取 `long_connection` 或 `webhook`（后者还需要 `encrypt_key`） |
| `POST /v1/admin/tenants/:id/chat-repos` | `{"chat","repo"}` | 允许某个群里派出的任务使用某个仓库。`"repo": null` 表示解除 |

### 查看内部状态

| 请求 | 返回 |
|---|---|
| `GET /v1/admin/scopes/:scope` | 一个作用域的状态：收件箱计数、最近的事件、run、记忆文件、定时器、任务、发件箱、今日 token、健康数字和最近的审计记录。作用域名需要做 URL 编码 |
| `GET /v1/admin/scopes/:scope/memory?path=...` | 一个记忆文件的内容 |
| `GET /v1/admin/tasks/:id` | 一个沙箱任务的状态，密钥已隐藏 |
| `GET /v1/admin/tasks/:id/files/{events,hooks,stderr}` | 该任务某个日志的末尾部分 |
| `POST /v1/admin/tasks/:id/probe` | 在任务的容器里做一组检查（它能访问什么、持有什么） |
| `POST /v1/admin/tasks/:id/kill-container` | 销毁容器，用来演练恢复 |
| `GET /v1/admin/feishu-links/:app_id` | 一条飞书长连接的状态 |

### 其他接口

| 请求 | 用途 |
|---|---|
| `GET /healthz` | 存活检查 |
| `POST /v1/github/webhook` | 接收 GitHub 的投递 |
| `POST /v1/feishu/events/:app_id` | 接收飞书的投递（webhook 方式） |
| `/v1/console/...` | 控制台 connector，用租户的 API key 鉴权。见 [Connector](connectors.zh-CN.md) |

## 观测

Worker 输出结构化日志（每行一个 JSON 对象），`wrangler.jsonc` 里已开启 observability。没有内置告警。

`GET /v1/admin/scopes/:scope` 返回的 `health` 值得关注：

| 字段 | 含义 |
|---|---|
| `oldest_pending_age_ms` | 最早一条未处理事件已经等了多久。应当接近 0 |
| `dead_events` | 被放弃的事件数 |
| `undeliverable_messages` | 重试用尽仍投递不出去的消息数 |
| `lost_tasks` | 容器丢失且无法恢复的沙箱任务数 |
| `abandoned_runs` | 进入五次仍未完成的 run 数 |

## 各项上限

这些是代码里的常量，不是配置项。

| 项目 | 上限 |
|---|---|
| 每个作用域每天的 token | 2,000,000 |
| 每个租户每天的 token | 20,000,000 |
| 每次 run 的模型步数 | 16 |
| 一次 run 认领的事件数 | 40 |
| 同时运行的沙箱任务 | 每个作用域 3 个，每个租户 5 个 |
| 沙箱任务：启动 / 空闲 / 总时长 | 5 分钟 / 15 分钟 / 2 小时 |
| 沙箱任务：模型调用次数 | 400 |
| 沙箱任务：容器丢失后的恢复次数 | 2 |
| 一次推送等待批准 | 50 分钟 |
| 沙箱发出的模型请求 | 4 MB |
| 沙箱发出的推送 | 64 MB |

## 数据保留

| 数据 | 保留时间 |
|---|---|
| 已结束任务的容器、检查点和记录 | 24 小时 |
| 已处理事件的正文 | 30 天（去掉正文的记录本身保留 365 天，这样迟到的重复投递仍能被认出来） |
| 已投递的消息、已结束的定时器和任务 | 30 天 |
| 对话记录 | 对话在使用期间完整保留。一个对话沉寂满 30 天后，会被裁剪到大约最近 200 条（裁剪点落在一条用户发言上，所以实际留下的可能略少）。仍在使用的对话，其文本没有保留时长的上限 |
| 审计记录 | 365 天 |

## 关于成本

- Brain 只在处理事件时处于唤醒状态。收到过事件的作用域每天还会短暂唤醒一次以清理旧记录；除此之外，空闲的作用域只占存储。
- 沙箱任务在运行期间一直占用一个容器。
- 使用长连接的飞书应用，会让一个 Durable Object 一直保持唤醒。
- 模型用量受上面的每日额度限制。所有租户共用同一个模型密钥。

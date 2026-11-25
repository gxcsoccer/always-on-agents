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

**升级到“请求会等待”的版本。** 在这之前，一个人授权读取飞书文档之后，会被要求把请求再发一次；从这个版本起，请求会被保留下来并接着处理（见 [Connector](connectors.zh-CN.md)）。部署这个版本时正好授权到一半的人，手里是旧版本发的卡片。这张卡片仍然能用，令牌也会被保存，但部署之前提的那个请求从来没有被保留过，所以不会被接着处理。他授权后看到的页面对各种情况都说得通：还在等待的请求会被接着处理；如果几分钟内没有收到结果，请把请求再发一次。旧版本发出、到部署这个版本时还没送达的邀请，不会再有任何东西去发送它：它在自己的十分钟内作废，这个人需要再问一次。不需要人工处理。部署那一刻正在重试的消息会被当作“可能已经送达”：它们不会重新获得一小时的重发时间。

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
| `PUBLIC_ORIGIN` | 密钥或变量 | 这个部署对外的地址，比如 `https://agent.example.com`。读取飞书文档时需要：用户授权后，飞书把他送回这里 |
| `GRANTS_KEY` | 密钥 | 用来加密用户授权产生的令牌。32 个以上的随机字符。改掉它之后，已保存的授权全部无法读取，用户会被重新邀请授权 |
| `GATE_HOLD_PATTERN` | 密钥或变量 | 可选。一个正则，匹配到的沙箱内 shell 命令需要人批准。默认没有 |

`FOLLOW_UPS` 已经不再读取：就保存的答复追问的做法已经下线。以前把它设成了 secret 的部署，可以用 `wrangler secret delete FOLLOW_UPS` 删掉。

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
| `GET /v1/admin/scopes/:scope` | 一个作用域的状态：收件箱计数、最近的事件、run、记忆文件、定时器、任务、发件箱、今日 token、健康数字、最近的审计记录，以及 `waits`（见下文）。发件箱条目里，run 读过外部文本之后写的消息、以及等待过的请求的答复，都不显示正文。作用域名需要做 URL 编码 |
| `GET /v1/admin/scopes/:scope/memory?path=...` | 一个记忆文件的内容 |
| `GET /v1/admin/tasks/:id` | 一个沙箱任务的状态，密钥已隐藏 |
| `GET /v1/admin/tasks/:id/files/{events,hooks,stderr}` | 该任务某个日志的末尾部分 |
| `POST /v1/admin/tasks/:id/probe` | 在任务的容器里做一组检查（它能访问什么、持有什么） |
| `POST /v1/admin/tasks/:id/kill-container` | 销毁容器，用来演练恢复 |
| `GET /v1/admin/feishu-links/:app_id` | 一条飞书长连接的状态 |
| `POST /v1/admin/feishu-apps/:app_id/oauth` | 该应用的授权如何取得：`{"token_endpoint":"v2"}` 或 `"v3"`（默认）决定用飞书的哪个接口换令牌；`{"offline_access":true}` 表示请用户允许续期，让授权长期有效。可以只给其中一项。见 [Connector](connectors.zh-CN.md) |
| `GET`、`DELETE /v1/admin/feishu-grants/:app_id/:tenant_key/:open_id` | 某个人读取文档的授权是否还在；`DELETE` 收回它。不会返回令牌 |

### 其他接口

| 请求 | 用途 |
|---|---|
| `GET /healthz` | 存活检查 |
| `POST /v1/github/webhook` | 接收 GitHub 的投递 |
| `POST /v1/feishu/events/:app_id` | 接收飞书的投递（webhook 方式） |
| `GET /v1/feishu/oauth/callback` | 用户授权读取文档后，飞书把他的浏览器送回这里 |
| `/v1/console/...` | 控制台 connector，用租户的 API key 鉴权。见 [Connector](connectors.zh-CN.md) |

## 观测

Worker 输出结构化日志（每行一个 JSON 对象），`wrangler.jsonc` 里已开启 observability。没有内置告警。

`GET /v1/admin/scopes/:scope` 返回的 `health` 值得关注：

| 字段 | 含义 |
|---|---|
| `oldest_pending_age_ms` | 最早一条未处理事件已经等了多久。应当接近 0 |
| `dead_events` | 被放弃的事件数 |
| `undeliverable_messages` | 重试用尽仍投递不出去的消息数 |
| `unverified_messages` | 可能已送达但无法核实的消息数；这些消息不会再发 |
| `lost_tasks` | 容器丢失且无法恢复的沙箱任务数 |
| `abandoned_runs` | 进入五次仍未完成的 run 数 |

`undeliverable_messages` 只统计以 `dead` 结束的消息；以 `unverified` 结束的计入 `unverified_messages`。

### 这个作用域在等什么

`waits` 用同一种形式列出最近 20 个等待条件的请求（比如等某个人授权）和最近 20 个审批提问。每一条有 `kind`（`request` 或 `approval`）、`id`、`state`、`shown`（邀请或提问是否已送达）和 `since`（从什么时候开始）。它是只读的；审批仍然保存在原来的地方。

| `state` | 对请求来说 | 对审批来说 |
|---|---|---|
| `waiting` | 条件还没成立 | 还没有答复 |
| `continuing` | 已被接手，有一次 run 正在把调用再做一遍 | |
| `answer to be sent` | run 已结束，答复在发件箱里 | |
| `reconciling` | | 答复已发给 worker，尚未确认 |
| `done` | 已答复 | 已批准 |
| `refused` | | 已拒绝 |
| `failed` | 答复没能投递出去 | |
| `withdrawn` | 被这个人取消、超时，或者它等的东西被收回了 | 已撤回 |
| `cannot be verified` | 答复可能已经送达，但无法核实 | 无法查明答复是否生效 |

请求为什么结束，记在审计记录 `request.ended` 里。

### 消息的状态

`outbox` 里的每一条处于下面某个状态。

| 状态 | 含义 |
|---|---|
| `pending` | 待发送，或正在重试 |
| `draft` | 正在被接着处理的请求的答复，它所属的 run 还没结束。草稿不会被任何东西发送 |
| `sent` | 已交出，并且外部系统确认了 |
| `void` | 从未交出：它所属的请求被取消了或已经不成立；写它的那次 run 读到的内容已经不能再往外传（授权结束了）；或者它要展示的邀请已经不能用了。正文已清除 |
| `dead` | 已放弃，并且可以确定什么都没发出去：每次尝试都被外部系统拒绝。connector 没有声明去重时间窗时，任何失败的消息也以它结束 |
| `unverified` | 不（再）发送，但某次尝试可能已经送达，而且无法核实。重试次数用完而其中有一次尝试没有得到明确答复时，或者第一次尝试距今已超过外部系统丢弃重复消息的时间窗（飞书是一小时）时，消息会变成这个状态。正文已清除。它不会被再次发送 |
| `withdrawn`、`reconciling` | 只用于审批提问。见[审批](approvals.zh-CN.md) |

有两列把一条待发送的消息和它所属的 run 读过的东西联系起来，管理接口都不会返回它们。`guard` 记的是这条消息以什么为前提才能发出：connector，以及读取时所依据的条件和 generation。它不含任何文档正文。`source` 已经不再写入；它只用于就保存的答复追问，而这种做法已经下线。迁移 22 在升级时清空了所有行的 `source`，包括还在队列里的。消息一旦不再是 `pending` 或 `draft`，不管怎样收场，`guard` 都会被清空。

读过东西的 run 只在运行期间记下读了什么、依据什么读的：读取它的那个调用（里面有文档链接）、文档编号，以及 connector、条件和 generation。这是为了让每次调用模型之前、每次发送之前的核对能够进行。run 结束时这份记录会删除。不记消息编号，不记哈希，不记正文片段。

### 系统发出的固定消息

这里列的是和“会等待的请求”以及读取有关的那几条。它们由代码写出，不是模型写的，会带着正文出现在 `outbox` 里。这个人在该对话里最近一条消息含有中文字符时用中文发送，否则用英文（下表列的是英文措辞）。

| 什么时候发 | 正文开头 |
|---|---|
| 一次读过东西的 run 在调用模型之前被停下，因为读取所依据的条件已经不成立。它已经写好而没发出的内容记为 `void` | “I stopped before finishing: the authorisation for what I was reading has ended. Please ask again.” |
| 读取之后写的一条消息没有发出，因为读取所依据的条件已经不成立，或者时间已过；它记为 `void`。试了八次都问不到这个条件的所有者时也不发出，提示换成“没能确认授权是否仍然有效”那一句；这八次单独计数，不占用正常投递的重试次数。这个人自己取消了请求时、对邀请、以及消息以 `unverified` 结束时，不发这条提示 | “I did not send what I had written for you…” |
| 接着处理请求的那次 run 结束时没有写出答复 | “I could not finish what you asked for earlier. Please ask again.” |
| 一次取消可能指的请求不止一个。开头那句话是模型用这个人的语言写的，没有时用一句固定的话（语言按同样的办法选）；编号列表是这个人自己的原话 | “More than one of your requests could be meant. Which one?” |

前两条共用一个键 `withheld:<run 编号>`，所以对同一次 run，这个人最多只会收到其中一条——先发生的那一条，不管这次 run 有多少条消息被扣下。

### 日志行和审计记录

| 日志行 | 含义 |
|---|---|
| `received_shown` | 已经显示出“消息已收到”的标记（在飞书上是一个表情）；`ms` 是从消息存下来算起的时间。只有外部系统确认标记已经加上时才会写这一行。飞书消息看不到这一行时，检查应用的表情权限；消息已经被处理、或者已经过了 15 秒而跳过标记时，按设计也不会有这一行 |
| `request_answered` | 一个被接着处理的请求的答复已送达；`claim_to_receipt_ms` 是从请求被接手到渠道确认答复的时间 |
| `message_unverified` | 一条消息在再次尝试之前被记为 `unverified`（它所属的请求已经不成立，或者去重时间窗已过）；`outbox_id` 指明是哪一条 |
| `message_undeliverable` | 一条消息在重试用尽后被放弃，记为 `dead` 或 `unverified` |

| 审计动作 | 含义 |
|---|---|
| `request.waiting` | 一个请求被保留下来；`on` 说明它在等什么 |
| `request.resumed` | 一个请求被接手；`run` 是接着处理它的那次 run |
| `request.ended` | 一个请求结束；`as` 是 `done`、`failed`、`cancelled`、`expired`、`void` 或 `unverified`，`why` 说明是什么让它结束的 |

## 各项上限

前四项按租户可改，下表是没改过时的默认值；其余是代码里的常量。

```bash
# 查看某个租户现在的限额和默认值
curl -H "authorization: Bearer $ADMIN_KEY" https://<你的域名>/v1/admin/tenants/<租户>/limits
# 改其中几项：没写到的保持不变，写 null 的回到默认值
curl -X PUT -H "authorization: Bearer $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"scope_daily_tokens": 5000000, "scope_active_tasks": null}' \
  https://<你的域名>/v1/admin/tenants/<租户>/limits
```

四项的名字：`scope_daily_tokens`（每个作用域每天的 token）、`tenant_daily_tokens`（租户每天的 token）、`scope_active_tasks`（每个作用域同时进行的任务）、`tenant_sandboxes`（租户同时运行的沙箱）。都是不小于 0 的整数；`tenant_daily_tokens` 要么是 0，要么不小于 20000（每次调用模型前会先预留这么多，比它小就一次也调不了）。返回里的 `overrides` 是这个租户显式设过的项，`most` 是每项允许的最大值。租户不存在返回 404，写法不对返回 400。

设为 0 的含义：`scope_daily_tokens` 为 0 时，该作用域里 agent 自己不再调用模型；已经在跑的沙箱任务会做完，它们的用量在结束时计入。`tenant_daily_tokens` 为 0 时，整个租户的 agent 和沙箱都不能再开始新的模型调用。两个并发上限为 0 时只是不再接新任务，已有的照常收尾。

改动从该作用域下一次调用模型时起生效（在那之前已经发出的工具调用仍按旧值）；已经因为当天额度用完而暂停的作用域，要到次日（UTC）才会继续，调高额度不会把它提前叫醒。

| 项目 | 上限 |
|---|---|
| 每个作用域每天的 token | 2,000,000（可改） |
| 每个租户每天的 token | 20,000,000（可改） |
| 每次 run 的模型步数 | 16 |
| 一次 run 认领的事件数 | 40 |
| 同时运行的沙箱任务 | 每个作用域 3 个，每个租户 5 个（都可改） |
| 沙箱任务：启动 / 空闲 / 总时长 | 5 分钟 / 15 分钟 / 2 小时 |
| 沙箱任务：模型调用次数 | 400 |
| 沙箱任务：容器丢失后的恢复次数 | 2 |
| 一次推送等待批准 | 50 分钟 |
| 一个被接着处理的请求，从被接手到答复交给渠道 | 1 小时。过了这个时间，不再读取任何东西，没发出去的答复也不再发送 |
| 因为问不到条件的所有者而无法核对的消息 | 推后 8 次，每次大约一分钟，之后放弃：记为 `void`；如果某次尝试可能已经送达，则记为 `unverified`。这个人会收到提示 |
| 飞书上的一张授权邀请 | 10 分钟。请求等待的时间不会超过展示给它的那张邀请 |
| 每次 run 加载的 `index.md` | 前 4,000 个字符 |
| 每次 run 加载的 `instructions.md` | 前 8,000 个字符 |

超过上限的记忆文件仍然完整保存；run 会被告知后面的部分没有加载，并被要求把它缩短。
| 沙箱发出的模型请求 | 4 MB |
| 沙箱发出的推送 | 64 MB |

## 数据保留

| 数据 | 保留时间 |
|---|---|
| 已结束任务的容器、检查点和记录 | 24 小时 |
| 已处理事件的正文 | 30 天（去掉正文的记录本身保留 365 天，这样迟到的重复投递仍能被认出来） |
| 已投递的消息、已结束的定时器和任务 | 30 天 |
| 已结束的请求（一次等待的记录） | 30 天 |
| 对话记录 | 对话在使用期间完整保留。一个对话沉寂满 30 天后，会被裁剪到大约最近 200 条（裁剪点落在一条用户发言上，所以实际留下的可能略少）。仍在使用的对话，其文本没有保留时长的上限 |
| agent 在私聊里说过的话（`said`） | 随所在对话的对话记录一起删除：某次 run 的对话条目被裁掉时，这次 run 的 `said` 也一起删掉。和发件箱那一行无关，发件箱的行按自己的规则在 30 天后删除 |
| 审计记录 | 365 天 |

## 关于成本

- Brain 只在处理事件时处于唤醒状态。还存有事件记录的作用域每天会短暂唤醒一次以清理旧记录，直到清完为止；除此之外，空闲的作用域只占存储。
- 沙箱任务在运行期间一直占用一个容器。
- 使用长连接的飞书应用，会让一个 Durable Object 一直保持唤醒。
- 模型用量受上面的每日额度限制。所有租户共用同一个模型密钥。

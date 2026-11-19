# Connector

[English](connectors.md) | **简体中文**

一个 connector 把 agent 接到一个外部系统上。它做三件事：验证入站请求确实来自那个系统，并把它变成事件；说明是谁引起了这个事件、是不是在对 agent 说话；把 agent 的消息投递出去。

下面的例子里，`B` 是你的部署的地址，`ADMIN_KEY` 是管理密钥。管理接口见[运维](operations.zh-CN.md)。

## 控制台

一个纯 HTTP 的通道，背后没有任何聊天产品。它的存在是为了能把整套系统端到端地跑一遍，本仓库里的验证用的就是它。

```bash
# 和用户 alice 单聊。
curl -X POST $B/v1/console/users/alice/messages -H "authorization: Bearer $TENANT_KEY" \
  -H 'content-type: application/json' -d '{"text":"你好"}'

# 群聊。`user` 说明是谁在说话；“@agent”表示对 agent 说。
curl -X POST $B/v1/console/chats/team/messages -H "authorization: Bearer $TENANT_KEY" \
  -H 'content-type: application/json' -d '{"user":"bob","text":"@agent 总结一下这个话题"}'

# 读取 agent 说了什么。`after` 是已读到的最后一条消息的编号；`wait` 表示长轮询，最多 25 秒。
curl "$B/v1/console/users/alice/messages?after=0&wait=25" -H "authorization: Bearer $TENANT_KEY"
```

POST 时的可选字段：`id`（你自己给这条消息的编号，用于去重）、`thread`（群里的一个话题，它是一个独立的对话）、`mention: false`（一条没有对 agent 说的群消息，会被忽略）。

**信任模型。** 租户的 API key 是给租户自己的后端用的凭据，不是给终端用户的。持有它的人可以代表该租户的任何用户说话，也能读到他们的所有对话。绝不要把它交给浏览器或终端用户。

## GitHub

agent 关注仓库，并在 PR 的评论里说话。一个仓库是一个作用域（`租户:repo:owner/name`），其中每个 PR 是一个对话。

它会对这些作出反应：

- **对它说的评论**：`@你的机器人账号 ...`，或者以 `/agent` 开头的一行，并且评论者是 owner、member 或 collaborator。引用块和代码里的 @ 不算。
- **对未决审批问题的回复**：在同一个 PR 里，并且带着那个问题的确认码。
- **自动事件**：PR 打开或更新、检查失败。这些只是告知 agent，不算任何人的请求，也不能批准任何东西。

### 用 GitHub App（推荐）

1. 创建一个 GitHub App。
   - Webhook 地址：`$B/v1/github/webhook`，并设置 webhook secret。
   - 仓库权限：Contents（读写）、Pull requests（读写）、Issues（读写）、Checks（只读）、Metadata（只读）。
   - 订阅事件：Pull request、Issue comment、Check run。
2. 设置密钥（见[运维](operations.zh-CN.md)）：`GITHUB_APP_ID`、`GITHUB_APP_PRIVATE_KEY`、`GITHUB_WEBHOOK_SECRET`、`GITHUB_BOT_HANDLE`（App 的 slug）、`GITHUB_BOT_EMAIL`（`<机器人用户 id>+<slug>[bot]@users.noreply.github.com`，这样提交会记在机器人名下）。
3. 把 App 安装到它要工作的仓库上，然后把这次安装登记到某个租户：

   ```bash
   curl -X POST $B/v1/admin/tenants/acme/github-installations -H "authorization: Bearer $ADMIN_KEY" \
     -H 'content-type: application/json' -d '{"installation_id":"12345678"}'
   ```

   安装登记之前到达的 webhook 会被以 401 拒绝；可以在 App 的 Advanced 页面重新投递。

令牌按安装签发，并且收窄到任务所针对的那一个仓库。

### 用单个仓库的 webhook

用于开发，或者只有一个仓库、不想建 App 的情况：

```bash
# 返回要配置在该仓库 webhook 上的 secret，只显示这一次。
curl -X POST $B/v1/admin/tenants/acme/github-repos -H "authorization: Bearer $ADMIN_KEY" \
  -H 'content-type: application/json' -d '{"repo":"owner/name"}'
```

每个仓库有自己的 secret，所以知道其中一个，并不能伪造另一个仓库的事件。不用 App 时，要发评论和推送需要设置 `GITHUB_TOKEN`；这个令牌会用于所有仓库，所以只适合本地开发。

### 谁是谁

GitHub 账号只有在被关联之后才算租户的用户。关联用的是数字 id（登录名可以改名，然后被别人占用）：

```bash
curl -X POST $B/v1/admin/tenants/acme/identities -H "authorization: Bearer $ADMIN_KEY" \
  -H 'content-type: application/json' -d '{"provider":"github","external_id":"583231","user_id":"alice"}'
```

没有关联的账号仍然会被识别出来，但不算作用域的成员：它不能批准任何东西。

## 飞书

agent 在单聊和群聊里是一个机器人。单聊里每个用户一个作用域（`租户:user:<open_id>`），一个群是一个作用域（`租户:chat:<chat_id>`）。在群里它只听得到 @ 了它的消息。话题是一个独立的对话，普通的“回复”不是。

审批提问以带按钮的卡片发出。见[审批](approvals.zh-CN.md)。

### 登记应用

```bash
curl -X POST $B/v1/admin/tenants/acme/feishu-apps -H "authorization: Bearer $ADMIN_KEY" \
  -H 'content-type: application/json' -d '{
    "app_id": "cli_xxx",
    "app_secret": "...",
    "bot_open_id": "ou_xxx",
    "transport": "long_connection"
  }'
```

`bot_open_id` 是机器人自己的 id（从飞书的 `bot/v3/info` 接口取得）。没有它，agent 分不清 @ 的是自己还是别的机器人，于是不会在群里提供服务。

在飞书开发者后台，应用需要开启机器人能力、收发消息的权限，并订阅**接收消息**（`im.message.receive_v1`）和**卡片回传交互**（`card.action.trigger`）。

### 接入方式：长连接（推荐）

由 agent 主动向飞书建立 WebSocket，事件经它到达。在开发者后台把事件和回调的订阅方式都选成“使用长连接接收”，然后发布版本。

```bash
# 连上了吗？
curl $B/v1/admin/feishu-links/cli_xxx -H "authorization: Bearer $ADMIN_KEY"
```

需要知道的几点：

- **一个应用只能有一个客户端。** 飞书会把每个事件随机交给该应用已连接的客户端之一。如果还有别的程序在用同一个应用的长连接，agent 只能收到一部分事件。
- **每个应用有一个常驻的 Durable Object**，按存活时长计费（每月至多几美元）。
- **部署会让它重连一次。** 那一刻的事件由飞书重新投递；正好落在那一刻的卡片点击需要再点一次。

### 接入方式：webhook

由飞书调用 `$B/v1/feishu/events/<app_id>`。登记应用时使用 `"transport": "webhook"` 并提供 `encrypt_key`；只接受加密且带签名的投递。飞书的服务器访问不到 `*.workers.dev`，所以 Worker 需要一个自己的域名。

实际使用中，这条路对卡片回调并不可靠：飞书要求按钮点击在三秒内得到应答，而飞书到 Cloudflare 的这段路有时更慢，有时干脆不通。除非有特别的理由，请用长连接。

一个应用只走一种接入方式。切换时要用另一个取值重新登记应用，并在开发者后台改掉订阅方式。

### 让一个群能操作某个仓库

从聊天里派出的任务拿不到仓库凭据，因为聊天里可以指定任意仓库。运维方可以把一个群绑定到一个仓库：

```bash
curl -X POST $B/v1/admin/tenants/acme/chat-repos -H "authorization: Bearer $ADMIN_KEY" \
  -H 'content-type: application/json' -d '{"chat":"oc_xxx","repo":"owner/name"}'
```

之后在这个群里派出的任务就能克隆并推送到那个仓库（推送仍然需要批准）。传 `"repo": null` 可以解除绑定，立即生效，对正在运行的任务也一样。单聊不能绑定。

### 语言

卡片上的固定文字目前只有中文。

## 编写一个 connector

connector 是 `src/connectors/` 下的一个模块，包含：

- 一个入站处理函数：**先**验证请求的真实性，再相信其中的任何内容；然后构造一个 `InboundEvent`（见 `src/events.ts`），其中 `source_id` 要稳定以便去重，`principal` 说明是谁引起的、是不是在对 agent 说话；
- 一个投递函数：登记在 `src/connectors/index.ts` 里，发送一条消息，并且可以安全重试（使用消息的 `idem` 键）。

授权只看 principal，从不看消息文本。如果外部系统允许人们编辑或删除自己说过的话，就给事件带上 `subject`、`revision` 和 `holder`，使被改过的消息不能再决定任何事（参考 `src/connectors/github.ts`）。

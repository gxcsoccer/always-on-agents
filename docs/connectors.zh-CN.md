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
`user_id` 不能包含 `:`。

### review 一个 PR

在 PR 的评论里提出：`@机器人 review 一下`。agent 把这件事交给沙箱里的 worker，worker 读完改动后汇报，agent 再发出一份 review。

- review 的总评是正文，每条发现是挂在对应行上的评论。如果某条发现所在的行既不是这次 PR 改动的行、也不在 diff 显示的范围内，它会带着文件和行号留在正文里，因为 GitHub 只接受挂在 diff 行上的评论。
- 如果 PR 在被 review 之后又有了新提交，就不往行上挂任何评论：发现都列在正文里，并注明它们针对的是哪个提交。
- agent 只发评论，不批准，也不要求修改；这两件事留给人。
- worker 只读代码；它下载不了依赖，所以只能运行靠沙箱镜像和仓库本身就能跑的检查。review 里会说明核对了什么、没核对什么。
- 发 review 需要 App 有 **Pull requests：读写**权限。review 不是[审批](approvals.zh-CN.md)意义上的批准，也不会给 worker 任何推送凭据。

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

一个 connector 就是一个实现了 `Connector` 接口（`src/connectors/types.ts`）的对象，登记在 `src/agent.config.ts` 里。路由、管理请求、定时任务、消息投递、消息回读都通过这个对象找到它，而不是按名字。还有两处仍然点名具体系统：connector 的 Durable Object 类要从 `src/index.ts` 导出；任务目前只能指定 GitHub 仓库。仓库里的三个 connector 都是这样写的，可以直接照着写。

```ts
export const exampleConnector: Connector = {
  name: "example",
  // /v1/example/… 下的请求
  async http(request, env, path, ingress) { /* 验证，构造事件，交给 Brain */ },
  // 可选：/v1/admin/… 下用于配置它的运维请求
  async admin({ method, path, body }, env) { /* 不是自己的请求就返回 undefined */ },
  // 可选：每分钟调用一次
  async scheduled(env) {},
  // 可选：投递 agent 的消息
  channel: { deliver, amend, standing },
};
```

每一部分都是可选的，互不依赖。只上报事件的 connector（比如 CI 通知）只需要 `http`。

| 部分 | 必须做到 |
|---|---|
| `http` | **先**验证请求，再相信其中的内容。构造 `InboundEvent`（`src/events.ts`）：`source` 填 connector 的名字，`source_id` 要稳定（用于去重），`principal` 说明是谁引起的、是否在对 agent 说话 |
| `channel.deliver` | 发送一条消息，没送达就抛错。它会被重试，所以要用消息的 `idem` 避免重复发送 |
| `channel.amend` | 可选。把已送达的审批提问显示为已关闭 |
| `channel.standing` | 如果那个系统里的人可以编辑或删除自己说过的话，就必须实现。见下文 |

### 不管 connector 怎么说，都由核心决定的事

- **谁的话算数。** connector 只负责说明事件是谁引起的。这个人能不能批准动作、能不能被记为任务发起人、能不能改长期指令，由 Brain 决定，而且只对 `src/agent.config.ts` 里 `trusted` 列出的 connector 生效。其他 connector 的事件只提供信息，不能决定任何事。只有当一个 connector 能证明每个事件的来源和引起它的人时，才应该把它列进去。
- **不是租户用户的账号。** 如果 connector 在自己的系统里认出了一个账号，但它没有关联到租户的用户，就设置 `principal.unlinked`。这样的人不是任何作用域的成员。
- **会变的消息。** 消息可以被编辑或删除的 connector，要给事件带上 `subject`、`revision` 和 `holder`，并实现 `channel.standing`（向那个系统重新读一遍这条消息）。批准生效之前，Brain 会就批准可能依据的每条成员消息问它：这条消息现在说的是什么。如果 connector 没有 `standing`，或者不认得这条消息，就不会据此批准。agent 自己的提问如果发在别人能编辑的地方，也同样处理。

connector 是编译进 Worker 的第一方代码：每个 connector 都能拿到完整的环境，事件上的来源名字也是它自己写的。`trusted` 名单防的是“无意中依赖了某个 connector”，防不了一个谎报事件来源的 connector，所以审查 connector 要像审查任何持有部署密钥的代码一样。需要自己的 Durable Object 的 connector（比如飞书长连接）还要从 `src/index.ts` 导出这个类，并在 `wrangler.jsonc` 里加一条绑定。

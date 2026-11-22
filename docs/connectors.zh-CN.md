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
# agent 经由其他 connector 发出的消息（比如发到飞书单聊的）不会在这里返回。
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
- 只有确知针对的是 PR 当前提交的 review，才会作为 review 发出。如果 PR 之后又有了新提交，或者 review 没有说明针对哪个提交，它会作为一条普通评论发出并注明这一点，发现连同文件和行号列在评论里：针对某个提交的结论，不会被显示成针对另一个提交的结论。
- worker 发现的内容以“无作用”的形式发出：正文里的 @ 会显示成代码，不会通知任何人；suggestion 代码块变成普通代码块，不提供一键应用。其中的代码原样保留，链接仍然是链接。
- 一份 review 只发布一次。发之前，agent 会在这个 PR 的 review 和评论两处都查找之前的尝试，判断不了就不发。GitHub 要求等待时，至少等那么久。
- agent 只发评论，不批准，也不要求修改；这两件事留给人。
- worker 只读代码；它下载不了依赖，所以只能运行靠沙箱镜像和仓库本身就能跑的检查。review 里会说明核对了什么、没核对什么。
- 发 review 需要 App 有 **Pull requests：读写**权限。review 不是[审批](approvals.zh-CN.md)意义上的批准，也不会给 worker 任何推送凭据。

## 飞书

agent 在单聊和群聊里是一个机器人。单聊里每个用户一个作用域（`租户:user:<open_id>`），一个群是一个作用域（`租户:chat:<chat_id>`）。在群里它只听得到 @ 了它的消息。话题是一个独立的对话，普通的“回复”不是。

审批提问以带按钮的卡片发出。见[审批](approvals.zh-CN.md)。

一条对 agent 说的消息一存下来，机器人就在这条消息上加一个“Get”表情，让对方看到消息已经收到。这只是一个标记，不是一条消息：加不上也不影响其他任何事；如果它来得太晚、已经没有意义（消息已经被处理，或者已经过了 15 秒），就不加了。

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

表示“已收到”的表情需要应用权限 `im:message` 或 `im:message.reactions:write_only`。没有这项权限时只是不显示表情，其他一切照常。

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

### 读取某个人的文档

在单聊里，一个人可以把飞书文档的链接（`…/docx/…`，或者本身是文档的 `…/wiki/…` 页面）发给 agent 并就它提问。agent **以这个人的身份**、用这个人自己的权限去读，用的工具是 `feishu_read_document`。这个人打不开的，agent 也替他打不开；机器人自己能打开什么，与此无关。

- **这个人在飞书里授权一次。** 第一次时，机器人给他发一张卡片，上面是飞书授权页的链接（OAuth 授权码流程，并随请求带上 PKCE 校验参数；换令牌接口的说明见下文）。链接只能用一次，10 分钟内有效，而且只对他本人有效：飞书把浏览器送回来时，只有飞书确认这个令牌属于收到卡片的那个人、且在同一个组织内，令牌才会被保存。他不用把请求再发一遍：他提的请求已经被保留下来，会接着处理（见下一条）。
- **需要授权的请求会等着，授权之后接着处理。** 工具什么都不发、什么都不读，只回答“现在还不行”。Brain 把这个请求保留下来，把授权邀请送到这个人面前，然后结束这次运行。令牌保存下来之后，授权对象会通知这个人的 Brain，并且一直通知到对方确认听到为止。这个通知只是一个去问的理由：Brain 会问 connector，这个人的授权现在是否覆盖了这个请求需要的权限，以及从什么时候开始覆盖。如果覆盖了，而且是在邀请过期之前就覆盖了，就由一次单独的运行把那一次读取再做一遍（读的是 connector 当时认定的那篇文档，不是模型写的参数），并把一条答复发回请求发来的地方。请求等待期间，这个人写的任何一条消息都会让 Brain 以同样的方式去问一次；邀请到期时还会再问一次。邀请过期而没被用掉的请求会悄悄结束，不发消息；等待期间授权被收回的请求也会结束，不会转到以后的新授权上。如果接着处理的那次运行没能完成（失败了，或者当天额度用完了），会用一句话告诉这个人，代替答复。这样设计的理由见[设计文档](design/agent-core.zh-CN.md)和它的[约定](design/agent-core-step0.zh-CN.md)。
- **读到的内容每往前走一步，都会再问一次 connector。** 接着处理的请求从被接手算起有一小时，用来读取并把答复交给飞书。这一小时内，向飞书要文档之前、每次要把正文交给模型之前、以及把答复交给飞书之前，都会重新核对授权。如果授权已经不在，或者一小时已过，正文不会交给模型，已经写好的答复会被清空且不再发送，请求就此结束。另外，如果这个人写了消息而还没被处理，答复不会抢在它前面发出去：他可能正是要取消这个请求。
- **等待中的请求可以取消，也可以换成别的。** 这个人说不要了，agent 就取消它（`cancel_request`）；他想换成别的，新的那次读取会注明它替换的是哪个旧请求，旧请求在同一步里结束。在答复第一次交给飞书之前，这两件事都可以做。等待期间问了别的事，不算取消。如果他是回复了邀请卡片、回复了答复，或者回复了当初提出请求的那条消息，可能所指的请求就只限于那条消息所属的那些。可能所指的请求不止一个时，一个都不取消，并且会问这个人是哪一个：这是一条列出这些请求的固定消息，由系统自己发出，不是模型写的；这个问题送达之后他写的第一条消息可以从中选一个，只能选一次。
- **只读这个人亲自贴出链接、并且是他此刻所指的文档。** 请求里带了链接，就以这些链接为准，之前贴过什么都不算。请求里没有链接（先发链接、再说“总结一下”），就认为说的是他上一条带链接的消息里的那一个文档（十分钟内、最近五条消息内）；这样只生效一次；请求等他授权期间，会一直带着那条较早的消息。如果那条消息里有好几个链接，agent 会问是哪一个。agent 自己说的或读到的内容，不算这个人的消息。 链接必须以纯文本出现在他的消息里（`https://….feishu.cn/docx/…` 或 `…/wiki/…`，`larkoffice.com` 也可以）。消息到达时，connector 就从他打的原文里记下这些链接：每个链接作为整体（到下一个空格为止），按它自己的域名和路径判断，所以夹在别的链接里的飞书地址不算。链接前面紧挨着文字、或后面紧跟标点，都能认出来；但文字直接接在链接末尾时，分不清它是不是地址的一部分，就不算数；但分不清链接在哪里结束时（比如两个链接连在一起、中间没有空格），就不算数，需要分开贴。agent 读到的文字无法把它引到另一篇文档上；一个只是长得像文档编号的词、被 @ 的人的名字，也都不行。
- **授权邀请由 connector 生成，由 Brain 发送。** 它和对这个人说的其他话一样，经对话的发件箱发出。Brain 手里只有一个指向它的引用；固定内容的卡片和其中的链接是 connector 在发送的那一刻生成的，Brain 不保存，模型也看不到。一张邀请剩余时间超过三分钟时，再次需要邀请就还是指向它，所以两个请求可以共用一张卡片，对方只会看到一张；快过期的会换成新的。只有当还有请求在等这张卡片、且它还没过期时才会发送；已经不能用的邀请根本不会发出去。
- **运维打开之后，可以就一条答复继续追问。** 只有 Worker 变量 `FOLLOW_UPS` 设为 `on` 时才有这项功能（见[运维](operations.zh-CN.md)）；没有打开时，答复的任何内容都不保存，这一条后面的内容也都不适用。打开之后，一条已经送到这个人手里的答复（飞书给出了它成为的那条消息的编号），如果写它的那次运行只读了一篇文档、并且只说了一句话，会被单独保存 24 小时。这个人就它追问时（“把第二点展开说说”），agent 可以用 `reopen_answer` 把它取回来，但必须先以这个人的身份把文档重新读一遍：他已经读不了这篇文档的话，旧答复也不会回来；链接现在指向的是另一篇文档的话（知识库页面可能换成别的文档），也不会回来；文档的正文变了的话，agent 会被告知。同一时刻最多只提供一条答复：他回复的那一条，否则就是 agent 在这个单聊里对他说的最后一句话那一条。他的话到底算不算追问，由模型判断，不由代码判断（这是一个记录在案的决定，见[约定 5.3](design/agent-core-step0.zh-CN.md)）。如果授权已经结束，追问会像其他请求一样等待。
- **令牌只能用来读文档**，不管这个人以前还给过这个应用什么权限：换取令牌时只要邀请里请他允许的那几项，范围更大的令牌不会被保存。贴的是文档链接就只要文档权限；贴的是知识库链接才会一并要知识库权限。如果他没有给，之前已有的授权保持原样。
- **读取途中授权被收回或被替换，这次读取就此作废。** 旧令牌取回的内容不会交出去；这次读取既不会删掉新的授权，也不会再发起一次邀请。
- **令牌加密保存**，每个人、每个应用各有一个独立的对象，密钥由 `GRANTS_KEY` 这个密钥派生。令牌不会给模型看，不会写进日志，任何接口也不会返回它。
- **这个人无权打开某篇文档，不影响他的授权。** 飞书不再认可的令牌会被丢弃，并重新邀请他授权。
- [工具](#工具)一节的规则全部适用：只在单聊里提供；读过文档的那次运行只能回复这个人。

开通步骤：

1. 在开发者后台，为应用开通**用户身份**权限 `docx:document:readonly` 和 `wiki:node:read`；在安全设置里登记重定向 URL `https://<你的域名>/v1/feishu/oauth/callback`；发布一个版本。要授权的人必须在应用的可用范围内。
2. 给 Worker 设置两个密钥：`PUBLIC_ORIGIN`（`https://<你的域名>`）和 `GRANTS_KEY`（32 个以上的随机字符，比如 `openssl rand -base64 48` 的输出）。

```bash
# 这个人的授权还在吗？DELETE 会收回它，包括还在进行中的授权。
curl $B/v1/admin/feishu-grants/cli_xxx/<tenant_key>/<open_id> -H "authorization: Bearer $ADMIN_KEY"
```

**换令牌的接口。** 授权码默认在飞书当前的接口（`accounts.feishu.cn/oauth/v3/token`）换取令牌，这个接口会校验 PKCE 校验码。在一个真实应用上，这个接口拒绝了格式正确的校验码（错误码 20049，日志里是 `feishu_authorisation_refused`，带 `code` 和 `endpoint`）。飞书的授权页文档说，使用 PKCE 时暂时搭配较早的接口，所以运维可以把某一个应用切到较早的接口：

```bash
curl -X POST $B/v1/admin/feishu-apps/cli_xxx/oauth -H "authorization: Bearer $ADMIN_KEY" \
  -H 'content-type: application/json' -d '{"token_endpoint":"v2"}'   # 传 "v3" 切回
```

要清楚这样做放弃了什么：飞书的说明里写着，较早的接口在没有为授权码记下校验参数时也不会拒绝校验码，所以在那里换取成功并不能说明 PKCE 被校验过。仍然有效的保护是：换取时的应用密钥、绑定到被邀请人的一次性 state、身份核对和权限范围的精确核对。这个开关默认关闭，按应用单独设置。

**授权能维持多久。** 默认就是飞书签发的令牌的有效期，大约两小时，过期后会重新邀请授权。要让它长期有效：先在飞书里为应用开通 `offline_access` 权限（用户身份）并发布版本，确认安全设置里的“刷新 user_access_token”是开启的，然后在这里打开：

```bash
curl -X POST $B/v1/admin/feishu-apps/cli_xxx/oauth -H "authorization: Bearer $ADMIN_KEY" \
  -H 'content-type: application/json' -d '{"offline_access":true}'
```

之后邀请时会一并请对方允许这一项（之前授权过的人会被再邀请一次），飞书会多签发一个用来续期的令牌。这个令牌只能用一次，每次续期都会换新，所以续期只在一个地方、一次一个地进行，并且只要这个人给过的那些权限。如果续期被拒绝，或者结果无法确定（没有回应、回应无法解析、中途被打断、新令牌的权限比原来大），这次授权就此结束，并重新邀请对方；不会拿一个可能已经用掉的令牌再试。上限由飞书决定：续期令牌有自己的有效期（飞书示例里大约一周，每次续期顺延），满 365 天必须重新授权。务必在权限发布之后再打开这个设置，否则飞书的授权页会报错。

授权卡片会在对方同意之前写明：这次授权会自动续期，以及怎样解除。把设置再关掉（`{"offline_access":false}`）会让这个应用停止长期授权：新的邀请不再要这一项，已经发出但还没完成的长期授权邀请不再生效，也不再做任何续期；已经给出的授权可以用到当前令牌到期（约两小时），那时续期令牌会被丢弃，并重新邀请对方。要立刻结束某一个人的授权，用上面的 `DELETE /v1/admin/feishu-grants/…`。这两种做法都不会通知飞书撤销它已签发的令牌；对方可以在飞书自己的授权管理里撤销。

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
  channel: { deliver, amend, standing, received, dedupeMs },
  // 可选：agent 可以替某一个人在那个系统里做的事
  tools: [{ name: "example_read", description, parameters, run }],
  // 只要有工具可能回答“现在还不行”，就必须实现
  async holds(env, scope, condition, generation) {},
};
```

每一部分都是可选的，互不依赖。只上报事件的 connector（比如 CI 通知）只需要 `http`。

| 部分 | 必须做到 |
|---|---|
| `http` | **先**验证请求，再相信其中的内容。构造 `InboundEvent`（`src/events.ts`）：`source` 填 connector 的名字，`source_id` 要稳定（用于去重），`principal` 说明是谁引起的、是否在对 agent 说话 |
| `channel.deliver` | 发送一条消息，没送达就抛错。它会被重试，所以要用消息的 `idem` 避免重复发送。那个系统能说出消息编号时，返回一个指明这条消息的 `Receipt`；符合下面几种情况时，抛出对应的错误 |
| `channel.amend` | 可选。把已送达的审批提问显示为已关闭 |
| `channel.standing` | 如果那个系统里的人可以编辑或删除自己说过的话，就必须实现。见下文 |
| `channel.received` | 可选。在这个人自己写的那条消息上表示“已收到”（比如加一个表情）。每条对 agent 说的消息存下来之后调用一次。它绝不能往对话里加消息。在真正发出之前的最后一步调用 `event.wanted()`，它说“不”就什么都不发：这个标记来得太晚，已经没有意义。只有外部系统确认标记已经加上时才返回 `true`；没有可标记的东西、或者被跳过时返回 `false`。没有任何事等它完成，它抛错也不影响其他任何事 |
| `channel.dedupeMs` | 可选。外部系统在多长时间内会丢弃 `idem` 相同的重复消息（飞书是一小时）。见下文 |
| `holds` | 只要这个 connector 有工具可能回答 `Waiting`，就必须实现。见[需要等待的工具](#需要等待的工具) |

**一次投递怎样收场。** Brain 区分四种结果，由 `deliver` 抛出什么来决定：

- 正常返回：消息记为 `sent`。带着 `Receipt` 时，Brain 还知道它成了哪一条消息；只有这样，答复才能被追问，对它的回复才能被认出来。
- 抛出 `DeliveryVoid`：已经没有东西可发了（消息要展示的东西不能用了）。什么都没发出去，也不再重试；消息记为 `void`（如果之前某次尝试可能已经送达，则记为 `unverified`）。
- 抛出 `DeliveryRejected`：外部系统答复了，而且拒绝了，所以可以确定什么都没发出去。`DeliveryDeferred`（系统要求等一等）同样确定。消息会被重试；如果每次重试都是这样结束，记为 `dead`。
- 抛出其他任何错误：这次尝试可能已经送达。消息会用同一个 `idem` 重试，只要外部系统还会丢弃重复消息，这样做就是安全的。一旦第一次尝试距今超过 `dedupeMs`，或者重试次数用完，这条消息就不再发送，记为 `unverified`：它可能已经到了对方手里，再发一条就分不清哪条是哪条了。没有 `dedupeMs` 的 connector 沿用原来的做法：重试，最后记为 `dead`。审批提问有它自己的一套处理（见[审批](approvals.zh-CN.md)）。

### 工具

connector 可以给 agent 提供工具：agent 可以替某一个人在外部系统里做的事，比如以这个人的身份读一篇文档。一个工具是 `{ name, description, effect: "read", parameters, run(context, args) }`，名字是 `<connector 名>_…`。目前只有只读的工具。`context.person` 是这次调用替谁做；工具必须以这个人的身份行事，不能是别人。`context.said` 是这个人触发这次运行的那些消息，每条带着文字和 connector 附上的 `data`，工具可以据此只做他本人要求的事；`context.recent` 是他在这之前不久写的几条消息，形式相同。工具自己不发送任何东西。工具因为这个人还没授权而暂时无法执行时，回答一个 `Waiting`；要给这个人看的东西和对他说的其他话一样，经 Brain 发出。见[需要等待的工具](#需要等待的工具)。

connector 的工具什么时候存在、替谁存在，由核心决定：

- **只在“这次调用代表谁”毫无疑问的地方提供。** 必须是这个人自己的作用域里、他经由这个 connector 的私有对话，而且触发这次运行的全部是他在那里写给 agent 的普通消息。为此，connector 要给这类消息带上 `data.origin`（你核实过的来源，比如哪个应用、哪个组织，每个值都不能为空）、`data.direct: true`，并使用 `src/events.ts` 里 `privateSessionKey(name, origin)` 给出的会话键。这一批里只要有按钮点击、对提问的回复、从别处路由来的消息、定时器、worker 的回报、别人的消息，或经由其他 connector 来的消息，工具就不存在。在群和仓库里永远不存在。
- **私有对话是独立的。** 同一个用户 id 还可能以别的方式被触达，比如租户后台通过控制台。那些是另外的对话，有各自的历史；私有对话里说过的话不会展示给它们。
- **参数选不了人。** `context.person` 来自已存储的事件，每次调用时重新推导。
- **工具返回的是外部文本，由它衍生的内容也是。** 一次运行从第一次使用 connector 的工具起，只能做两件事：回复这个人，以及再读一次。其他工具一律拒绝，依据是一张“允许做什么”的清单，而不是“禁止做什么”的清单。运行结束时，它产生的一切都会从对话记录里移除，原文和模型自己的话都一样，换成一条固定的说明。它写的消息在送达或被放弃之后，各种形式的内容都会清空，错误信息的文字也不保留。后面的运行需要时，从这个人自己指向的东西重新读。部署设置了 `FOLLOW_UPS=on` 时，有一样东西会在对话记录之外单独保存：带着回执送达的答复，而且写它的那次运行只读了一样东西、只说了一句话，保存 24 小时。它只能通过 `reopen_answer` 取回，而且要先以这个人的身份把来源重新读一遍，并确认读到的还是原来那样东西。运行还在进行中（因预算暂停，或在重试）时，它的记录会保留。
- **不跨私有对话路由。** 平时，在别处写的、带着某个未决问题确认码的回复会被归到那个问题上。但不会归进私有对话，也不会从私有对话里归出去。
- **每次调用都写审计**（`tool.used`，记录是谁、哪个工具，不记参数）。
- 调用可能在中断后重复执行，所以工具必须可以安全地执行两次。

### 需要等待的工具

一个工具如果要等某件不归 agent 做的事发生之后才能执行（比如这个人去授权），就返回 `{ waiting: { … } }`，而不是结果。它什么都不读，什么都不发。Brain 把请求保留下来，把入口送到这个人面前，结束这次运行，之后在一次单独的运行里接着处理：同一个工具被再调用一次，这个人不用再问就得到一条答复。飞书的文档工具就是例子（`src/connectors/feishu-docs.ts`）；这样设计的理由见[设计文档](design/agent-core.zh-CN.md)和[约定](design/agent-core-step0.zh-CN.md)。

`Waiting` 的每个字段都是 connector 自己的。Brain 把它们存下来、原样交回；它不解读这些字符串，也不把其中任何一个给模型看——模型只被告知这个请求在等待，以及它的编号。

| 字段 | 是什么 | 谁来读 |
|---|---|---|
| `on` | 用一个词说明在等什么，比如 `"authorisation"` | 写进审计记录 `request.waiting` |
| `subject` | 这是谁的条件 | Brain 拿它和通知（下面的 `conditionReported`）里的 subject 比对，找出该去问的请求 |
| `condition` | 对这个请求来说，究竟要什么成立 | 原样交回给 connector 的 `holds` |
| `generation` | 这次等待所属的、connector 自己记录的状态版本 | 交回给 `holds`（connector 已经越过它时，`holds` 回答 “gone”）；也作为 `context.resuming.generation` 交给工具 |
| `until` | 一个毫秒时间。条件必须在它之前成立 | Brain 拿它和 `holds` 返回的 `since` 比较，过了它就结束等待 |
| `interaction` | 一个引用，指向要给这个人看、让他能促成条件的东西 | 作为 `message.interaction` 交给这个 connector 自己的 `channel.deliver` |
| `request` | 之后要再做一次的调用，用工具自己的规范形式写：只包含能确定“要的是什么”的内容 | 代替模型写的参数被保存下来；接着处理时作为参数传给工具的 `run` |

要提供这样的工具，connector 必须做到：

- **返回完整的 `Waiting`。** `on`、`subject`、`condition`、`interaction` 是非空字符串，`generation` 和 `until` 是数字，`request` 是一个工具能当作参数接受的对象。不符合的一律当作普通结果处理。
- **实现 `holds(env, scope, condition, generation)`。** 它回答条件现在是否成立，依据是 connector 自己保存的东西，每次重新核对，绝不依据调用方的说法：`{ state: "holds", since }`（`since` 是按 connector 自己的记录、条件开始成立的时间）、`{ state: "not_yet" }`，或者 `{ state: "gone" }`（条件已经不可能按当初要求的那样成立了）。查不出来时抛错；Brain 会在一分钟后再问，等待还在就一直问下去。Brain 在决定是否接手一个请求时调用它，每次要把读到的内容交给模型之前再调用一次，把答复交给渠道之前又调用一次，所以它必须开销很小，而且授权一被收回就要立刻反映出来。
- **在 `channel.deliver` 里、在发送的那一刻生成要给这个人看的东西。** 带着 `interaction` 的消息就是邀请。这个引用代表的东西（比如一个用来授权的链接）只存在于 connector 内部和实际发出的消息里。如果它已经不能用了，抛出 `DeliveryVoid`。不认识这个引用的渠道会发送消息的 `text`，那是 Brain 给的一句固定的话。两个请求返回相同的 `interaction` 时，共用一条消息。
- **某个 subject 有变化时通知 Brain。** 调用这个人的作用域对应的 Brain 的 `conditionReported(connector, subject, event)`，一直调用到它回答 `{ ok: true }` 为止（飞书的授权对象在保存令牌的同一次写入里记下这笔“欠着的通知”，并由 alarm 重试）。这个通知不带任何权威，也不点名任何请求：它只会让 Brain 对这个作用域里等着这个 subject 的每个请求调用一次 `holds`。没有通知时，这个人下次在这个对话里写消息时、以及 `until` 到了的时候，请求仍然会被查看。
- **遵守 `context.resuming`。** 这次调用是在接着处理一个等待过的请求时，它会被设置为 `{ generation, notAfter }`。如果 connector 已经越过了那个 generation，或者时间已经过了 `notAfter`，工具什么都不做并说明原因；它不能在更新的 generation 下把请求从头再来。在同一个 generation 内，它可以再次回答 `Waiting`（需要的比给的多）；请求于是再次等待，这期间什么都不发。
- **凡是只能发生一次的事，用 `context.callId` 做键。** 重复执行时它不变，请求被接着处理时它也不变。
- **调用 `context.relied(index)`**：当工具依据的是 `context.recent` 里的某一条消息，而不是刚说的那句话时（先发链接，再说“总结一下”）。Brain 会把这一条较早的消息（且只有这一条）记为请求所依据的内容；请求被接着处理时，`context.said` 和 `context.recent` 就是原来那几条消息。
- **调用 `context.identified(request, identity)`**：工具读到东西之后、返回之前调用。`request` 是能把同一样东西再读一遍的调用，用工具的规范形式写；`identity` 是外部系统解析出来的、实际读到的那样东西的名字（飞书是文档自己的编号，因为知识库链接可能改为指向另一篇文档）。不调用的话，由这次读取产生的答复就不能被追问。调用了的话，只有同一个调用仍然解析到同一个 identity 时，答复才会被取回。
- **给回复带上 `data.replies_to`。** 一个人的消息是对另一条消息的回复时，事件的 `data.replies_to` 是 `deliver` 为那条消息返回的 `Receipt` 里的 `subject`（飞书是 `feishu:message:<id>`）。Brain 靠它判断一条回复说的是哪个请求、哪条答复。

不管 connector 怎么说，Brain 围绕这样的工具还会做这些事：

- 展示给模型的工具参数会多出一个 `replaces`：这次调用要取代的那个等待中请求的编号。工具永远看不到它。
- 接着处理请求的那次运行只能做两件事：用保存下来的 `request` 做那一次调用，以及 `send_message`。它唯一的一条答复在运行结束之前只是草稿，发往这个人的消息当初发来的地方，只发一次。
- 接着处理的请求从被接手算起有一小时。过了这个时间，不再读取任何东西，没发出去的答复也不再发送。
- 取消请求、替换请求、取回答复，都只能发生在完全以这个人在自己私有对话里的消息为依据的运行里：和工具本身的条件相同。

### 不管 connector 怎么说，都由核心决定的事

- **谁的话算数。** connector 只负责说明事件是谁引起的。这个人能不能批准动作、能不能被记为任务发起人、能不能改长期指令，由 Brain 决定，而且只对 `src/agent.config.ts` 里 `trusted` 列出的 connector 生效。其他 connector 的事件只提供信息，不能决定任何事。只有当一个 connector 能证明每个事件的来源和引起它的人时，才应该把它列进去。
- **不是租户用户的账号。** 如果 connector 在自己的系统里认出了一个账号，但它没有关联到租户的用户，就设置 `principal.unlinked`。这样的人不是任何作用域的成员。
- **会变的消息。** 消息可以被编辑或删除的 connector，要给事件带上 `subject`、`revision` 和 `holder`，并实现 `channel.standing`（向那个系统重新读一遍这条消息）。批准生效之前，Brain 会就批准可能依据的每条成员消息问它：这条消息现在说的是什么。如果 connector 没有 `standing`，或者不认得这条消息，就不会据此批准。agent 自己的提问如果发在别人能编辑的地方，也同样处理。

connector 是编译进 Worker 的第一方代码：每个 connector 都能拿到完整的环境，事件上的来源名字也是它自己写的。`trusted` 名单防的是“无意中依赖了某个 connector”，防不了一个谎报事件来源的 connector，所以审查 connector 要像审查任何持有部署密钥的代码一样。需要自己的 Durable Object 的 connector（比如飞书长连接）还要从 `src/index.ts` 导出这个类，并在 `wrangler.jsonc` 里加一条绑定。

# Connectors

**English** | [简体中文](connectors.zh-CN.md)

A connector joins the agent to one outside system. It does three things: verifies that an inbound request really came from that system and turns it into an event, says who caused the event and whether they were addressing the agent, and delivers the agent's messages.

All examples assume `B` is the base URL of your deployment and `ADMIN_KEY` is the admin key. The admin API is described in [Operations](operations.md).

## Console

A plain HTTP channel with no chat product behind it. It exists so that everything can be exercised end to end, and it is what the checks in this repository use.

```bash
# A direct chat with user "alice".
curl -X POST $B/v1/console/users/alice/messages -H "authorization: Bearer $TENANT_KEY" \
  -H 'content-type: application/json' -d '{"text":"hello"}'

# A group chat. `user` says who is speaking; "@agent" addresses the agent.
curl -X POST $B/v1/console/chats/team/messages -H "authorization: Bearer $TENANT_KEY" \
  -H 'content-type: application/json' -d '{"user":"bob","text":"@agent summarise this thread"}'

# Read what the agent said to the console. `after` is the last message id seen; `wait` long-polls up to 25 seconds.
# Messages the agent sent through another connector (to a Feishu chat, say) are not returned here.
curl "$B/v1/console/users/alice/messages?after=0&wait=25" -H "authorization: Bearer $TENANT_KEY"
```

Optional fields on a POST: `id` (your own id for the message, used for de-duplication), `thread` (a thread within a chat, which is a conversation of its own), `mention: false` (a group message that does not address the agent; it is ignored).

**Trust model.** The tenant API key is a credential for the tenant's own backend, not for end users. Whoever holds it can speak as any of the tenant's users and read any of their conversations. Never give it to a browser or an end user.

## GitHub

The agent watches repositories and talks in pull request comments. A repository is one scope (`tenant:repo:owner/name`); each pull request is a conversation within it.

What it reacts to:

- **A comment that addresses it**: `@your-bot-handle ...` or a line starting with `/agent`, from an owner, member or collaborator. A mention inside a quotation or code does not count.
- **A reply to an open approval question**, in the same pull request, quoting the question's code.
- **Automatic events**: a pull request opened or updated, a failed check run. These inform the agent; they are nobody's request and cannot approve anything.

### As a GitHub App (recommended)

1. Create a GitHub App.
   - Webhook URL: `$B/v1/github/webhook`, with a webhook secret.
   - Repository permissions: Contents (read and write), Pull requests (read and write), Issues (read and write), Checks (read), Metadata (read).
   - Subscribe to: Pull request, Issue comment, Check run.
2. Set the secrets (see [Operations](operations.md)): `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_BOT_HANDLE` (the App's slug), `GITHUB_BOT_EMAIL` (`<bot user id>+<slug>[bot]@users.noreply.github.com`, so commits are credited to the bot).
3. Install the App on the repositories it should work in, then link the installation to a tenant:

   ```bash
   curl -X POST $B/v1/admin/tenants/acme/github-installations -H "authorization: Bearer $ADMIN_KEY" \
     -H 'content-type: application/json' -d '{"installation_id":"12345678"}'
   ```

   Deliveries that arrive before the installation is linked are refused with 401; redeliver them from the App's Advanced page.

Tokens are issued per installation and narrowed to the one repository a task works on.

### With a webhook on one repository

For development, or for a single repository without an App:

```bash
# Returns the secret to configure on that repository's webhook. Shown once.
curl -X POST $B/v1/admin/tenants/acme/github-repos -H "authorization: Bearer $ADMIN_KEY" \
  -H 'content-type: application/json' -d '{"repo":"owner/name"}'
```

Each repository gets its own secret, so knowing one does not let anyone forge events for another. To post comments and push without an App, set `GITHUB_TOKEN`; that token is used for every repository, which makes it suitable for local development only.

### Who is who

A GitHub account acts as a tenant user only once it is linked, by its numeric id (a login can be renamed and claimed by someone else):

```bash
curl -X POST $B/v1/admin/tenants/acme/identities -H "authorization: Bearer $ADMIN_KEY" \
  -H 'content-type: application/json' -d '{"provider":"github","external_id":"583231","user_id":"alice"}'
```

An unlinked account is still identified, but is not a member of the scope: it cannot approve anything. A `user_id` cannot contain `:`.

### Reviewing a pull request

Ask in a comment on the pull request: `@your-bot-handle review this`. The agent gives the work to a sandboxed worker, which reads the change and reports back; the agent then posts one review.

- The review's summary is its body, and each finding is a comment on the line it is about. A finding on a line the pull request neither changes nor shows is kept in the body with its file and line, because GitHub accepts comments only on lines of the diff.
- A review is posted as a review only when it is known to be of the pull request's current commit. If the pull request has moved on, or the review does not say which commit it is of, it is posted as an ordinary comment that says so, with its findings listed with file and line: a verdict on one commit is never shown as a verdict on another.
- What the worker found is posted inert: a mention in its prose is shown as code and notifies nobody, and a suggestion block becomes an ordinary code block that offers no change to apply. Code in it is left exactly as written. Links in it are still links.
- A review is published once. Before posting, the agent looks for an earlier attempt both among the pull request's reviews and among its comments, and posts nothing if it cannot tell. If GitHub asks it to wait, it waits at least that long.
- The agent only comments. It neither approves nor requests changes; that is left to people.
- The worker reads; it cannot download packages, so it runs only what works with the sandbox image and the repository. The review says what was and was not checked.
- Posting needs the App's **Pull requests: read and write** permission. A review is not an approval of anything in the sense of [Approvals](approvals.md), and gives the worker no credential to push.

## Feishu / Lark

The agent is a bot in direct chats and group chats. A direct chat is one scope per user (`tenant:user:<open_id>`); a group is one scope (`tenant:chat:<chat_id>`). In a group it hears only messages that mention it. A topic thread is a conversation of its own; an ordinary reply is not.

Approval questions are sent as a card with buttons. See [Approvals](approvals.md).

### Register the app

```bash
curl -X POST $B/v1/admin/tenants/acme/feishu-apps -H "authorization: Bearer $ADMIN_KEY" \
  -H 'content-type: application/json' -d '{
    "app_id": "cli_xxx",
    "app_secret": "...",
    "bot_open_id": "ou_xxx",
    "transport": "long_connection"
  }'
```

`bot_open_id` is the bot's own id (from Feishu's `bot/v3/info` API). Without it the agent cannot tell a mention of itself from a mention of another bot, and does not serve groups.

In the Feishu developer console the app needs the bot capability, permission to receive and send messages, and subscriptions to **Receive message** (`im.message.receive_v1`) and the **card callback** (`card.action.trigger`).

### Transport: long connection (recommended)

The agent opens a WebSocket to Feishu and events arrive over it. In the developer console choose "receive through a long connection" for both events and callbacks, then publish a version.

```bash
# Is it connected?
curl $B/v1/admin/feishu-links/cli_xxx -H "authorization: Bearer $ADMIN_KEY"
```

Things to know:

- **One client per app.** Feishu gives each event to one of the app's connected clients at random. If anything else holds a long connection for the same app, the agent receives only some of the events.
- **It keeps one Durable Object awake per app**, which is billed for its duration (a few dollars a month at most).
- **A deploy reconnects it.** Events in that moment are redelivered by Feishu; a card press that lands in it has to be pressed again.

### Transport: webhook

Feishu calls `$B/v1/feishu/events/<app_id>`. Register the app with `"transport": "webhook"` and an `encrypt_key`; only encrypted and signed deliveries are accepted. Feishu's servers cannot reach `*.workers.dev`, so the Worker needs a domain of its own.

In practice this route is not reliable for card callbacks: Feishu expects a button press to be answered within three seconds, and the path from Feishu to Cloudflare sometimes takes longer or fails. Use the long connection unless you have a reason not to.

An app is served through one transport only. Switching it re-registers the app with the other value and changes the subscription mode in the developer console.

### Letting a group work on a repository

Tasks started from a chat get no repository credential, because a chat can name any repository. An operator can link one group to one repository:

```bash
curl -X POST $B/v1/admin/tenants/acme/chat-repos -H "authorization: Bearer $ADMIN_KEY" \
  -H 'content-type: application/json' -d '{"chat":"oc_xxx","repo":"owner/name"}'
```

Tasks started in that group can then clone and push to that repository (pushes still need approval). Pass `"repo": null` to remove the link; it takes effect at once, for running tasks too. Direct chats cannot be linked.

### Reading a person's documents

In a direct chat, a person can give the agent a link to a Feishu document (`…/docx/…`, or a `…/wiki/…` page that is a document) and ask about it. The agent reads it **as that person**, with their own access, through the tool `feishu_read_document`. What the person cannot open, the agent cannot open for them; what the bot could open plays no part.

- **The person authorises once, in Feishu.** The first time, the bot sends them a card with a link to Feishu's consent page (OAuth with PKCE). The link works once, for ten minutes, and only for them: when Feishu sends their browser back, the token is kept only if Feishu says it belongs to the very person the card was sent to, in the same organisation. They then ask again.
- **Only a document the person linked in the request itself is read.** The link must be in their message as plain text (`https://….feishu.cn/docx/…` or `…/wiki/…`; `larkoffice.com` too). The connector records the links when the message arrives, from what the person typed: each is taken whole and judged by its own host and path, so a Feishu address carried inside some other link does not count. Text the agent has read cannot send it to another document, and neither can a word that merely looks like a document's id, or the name of someone mentioned.
- **The invitation is the connector's own to send.** It is a fixed card, to that one person. It is sent once however often it is asked for, retried for a few minutes if Feishu does not take it, and replaced by a new one once it is nearly spent. Its link is never given to the model.
- **The token is for reading documents and nothing else**, whatever else the person has allowed the app before: only what the invitation asked for is requested when the token is issued, and a token that reaches further is not kept. A document link asks for documents; a wiki link asks for wiki pages as well, and only then. If that is not given, what the person had allowed before stays as it was.
- **An authorisation taken away or replaced during a read stops that read.** What the earlier token fetched is not handed on, and that read neither removes the newer authorisation nor asks for another.
- **The token is stored sealed**, in an object of its own per person and app, with a key derived from the `GRANTS_KEY` secret. It is never shown to the model, logged, or returned by any endpoint.
- **A document the person may not open leaves the authorisation as it is.** A token Feishu no longer honours is forgotten and the person is invited again.
- Everything in [Tools](#tools) applies: direct chats only, and a run that has read a document can only reply to that person.

To set it up:

1. In the developer console, under the app's permissions, enable the **user-identity** scopes `docx:document:readonly` and `wiki:node:read`; under security settings, register the redirect URL `https://<your domain>/v1/feishu/oauth/callback`; publish a version. People who will authorise must be in the app's availability range.
2. Set two secrets on the Worker: `PUBLIC_ORIGIN` (`https://<your domain>`) and `GRANTS_KEY` (32 or more random characters, for instance from `openssl rand -base64 48`).

```bash
# Does this person's authorisation stand? DELETE takes it away, including one still being given.
curl $B/v1/admin/feishu-grants/cli_xxx/<tenant_key>/<open_id> -H "authorization: Bearer $ADMIN_KEY"
```

For now an authorisation lasts as long as the token Feishu issues, about two hours; after that the person is invited again.

### Language

The card's fixed text is currently Chinese only.

## Writing a connector

A connector is one object that implements `Connector` (`src/connectors/types.ts`), listed in `src/agent.config.ts`. Routes, admin requests, scheduled work, delivery and the re-reading of messages all reach it through that object, not by its name. Two things still name a system elsewhere: a connector's Durable Object class is exported from `src/index.ts`, and a task can only be given a GitHub repository to work on. The three connectors in this repository are written this way and are the examples to copy.

```ts
export const exampleConnector: Connector = {
  name: "example",
  // Requests under /v1/example/…
  async http(request, env, path, ingress) { /* verify, build events, hand them to the Brain */ },
  // Optional: operator requests under /v1/admin/… that set it up
  async admin({ method, path, body }, env) { /* return undefined for requests that are not yours */ },
  // Optional: called every minute
  async scheduled(env) {},
  // Optional: delivering the agent's messages
  channel: { deliver, amend, standing },
  // Optional: things the agent can do in that system for one person
  tools: [{ name: "example_read", description, parameters, run }],
};
```

Each part is optional and independent. A connector that only reports events (a CI notifier, say) has `http` and nothing else.

| Part | What it must do |
|---|---|
| `http` | Authenticate the request **before** believing anything in it. Build an `InboundEvent` (`src/events.ts`) with `source` set to the connector's name, a stable `source_id` for de-duplication, and a `principal` that says who caused it and whether they were addressing the agent. |
| `channel.deliver` | Send one message. Throw if it was not delivered. It will be retried, so use the message's `idem` key to avoid sending twice. |
| `channel.amend` | Optional. Show a delivered approval question as closed. |
| `channel.standing` | Required if people can edit or delete what they said in that system. See below. |

### Tools

A connector can give the agent tools: things it can do in the outside system on one person's behalf, such as reading a document as that person. A tool is `{ name, description, effect: "read", parameters, run(context, args) }`, named `<connector name>_…`. Only tools that read exist so far. `context.person` is who the call is for; the tool must act as that person and nobody else. `context.said` is that person's messages that started the run, each with its text and the `data` the connector attached, so a tool can hold a call to what they themselves asked for. A tool that cannot act because the person has not authorised it may have its connector send that person, and only them, the connector's own fixed invitation; nothing else is sent on a tool's account.

The core decides when a connector's tools exist at all, and for whom:

- **Only where it is beyond doubt whose authority a call carries.** Tools are offered in a person's own scope, in their private conversation through this connector, in a run started by nothing but ordinary messages that person wrote to the agent there. To make that possible a connector gives such messages `data.origin` (what it verified about where they came from, such as the app and the organisation; every value non-empty), `data.direct: true`, and the session key `privateSessionKey(name, origin)` from `src/events.ts`. A button press, a reply to a question, something routed from elsewhere, a timer, a worker's report, another person's message, or a message through another connector: any of these in the batch and the tools are not there. In a group or a repository they never are.
- **The private conversation is its own.** The same user id can be reached in other ways, for instance by a tenant's backend through the console. Those are other conversations with their own history; nothing said in the private one is shown to them.
- **Arguments cannot choose the person.** `context.person` comes from the stored events, worked out again at each call.
- **What a tool returns is outside text, and so is what is made of it.** From its first use of a connector's tool, a run can do two things only: reply to the person, and read again. Every other tool is refused, by a list of what is allowed rather than of what is forbidden. When the run ends, everything it produced is removed from the conversation's record, the original text and the model's own words alike, and replaced by one fixed note. The messages it wrote are emptied, in every form, once they have been delivered or given up, and the text of its errors is not kept. A later run reads again from what the person themselves pointed to. While a run is still under way (paused for a budget, or retrying), its record is kept.
- **Nothing is routed across a private conversation.** A reply elsewhere that names an open question's code is normally taken to that question. Not into or out of a private conversation.
- **Every call is audited** (`tool.used`, with the person and the tool, not the arguments).
- A call may be repeated after an interruption, so a tool must be safe to run twice.

### What the core decides, whatever a connector says

- **Whose word counts.** A connector says who caused an event. Whether that person can approve an action, be credited with a request, or change standing instructions is decided by the Brain, and only for connectors listed under `trusted` in `src/agent.config.ts`. Events from any other connector inform the agent and decide nothing. List a connector there only if it proves where each event came from and who caused it.
- **Accounts that are not tenant users.** If the connector identifies an account in its own system that is not linked to a user of the tenant, it sets `principal.unlinked`. Such a person is not a member of any scope.
- **Messages that can change.** A connector whose messages can be edited or deleted gives its events a `subject`, a `revision` and a `holder`, and implements `channel.standing`, which reads the message again from the system. Before an approval counts, the Brain asks it what each such message says now, for the messages from members that the approval could rest on. If the connector has no `standing`, or does not recognise the message, nothing is approved on it. The same goes for the agent's own question when it was posted somewhere others can edit it.

Connectors are first-party code compiled into the Worker: each one is handed the whole environment and writes its own name on its events. The `trusted` list guards against a connector being relied on by oversight, not against one that misstates where its events came from, so review a connector as you would any code that holds the deployment's secrets. A connector that needs a Durable Object of its own (as Feishu's long connection does) also needs the class exported from `src/index.ts` and a binding in `wrangler.jsonc`.

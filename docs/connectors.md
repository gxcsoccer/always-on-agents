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

# Read what the agent said. `after` is the last message id seen; `wait` long-polls up to 25 seconds.
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

### Language

The card's fixed text is currently Chinese only.

## Writing a connector

A connector is one object that implements `Connector` (`src/connectors/types.ts`), listed in `src/agent.config.ts`. Nothing else in the code names a connector: routes, admin requests, scheduled work and delivery all reach it through that object. The three connectors in this repository are written this way and are the examples to copy.

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
};
```

Each part is optional and independent. A connector that only reports events (a CI notifier, say) has `http` and nothing else.

| Part | What it must do |
|---|---|
| `http` | Authenticate the request **before** believing anything in it. Build an `InboundEvent` (`src/events.ts`) with `source` set to the connector's name, a stable `source_id` for de-duplication, and a `principal` that says who caused it and whether they were addressing the agent. |
| `channel.deliver` | Send one message. Throw if it was not delivered. It will be retried, so use the message's `idem` key to avoid sending twice. |
| `channel.amend` | Optional. Show a delivered approval question as closed. |
| `channel.standing` | Required if people can edit or delete what they said in that system. See below. |

### What the core decides, whatever a connector says

- **Whose word counts.** A connector says who caused an event. Whether that person can approve an action, be credited with a request, or change standing instructions is decided by the Brain, and only for connectors listed under `trusted` in `src/agent.config.ts`. Events from any other connector inform the agent and decide nothing. List a connector there only if it proves where each event came from and who caused it.
- **Accounts that are not tenant users.** If the connector identifies an account in its own system that is not linked to a user of the tenant, it sets `principal.unlinked`. Such a person is not a member of any scope.
- **Messages that can change.** A connector whose messages can be edited or deleted gives its events a `subject`, a `revision` and a `holder`, and implements `channel.standing`, which reads the message again from the system. Before an approval counts, the Brain asks it what the message says now. A message that names a subject from a connector without `standing` cannot approve anything.

Connectors are first-party code compiled into the Worker: each one is handed the whole environment and writes its own name on its events. The `trusted` list guards against a connector being relied on by oversight, not against one that misstates where its events came from, so review a connector as you would any code that holds the deployment's secrets. A connector that needs a Durable Object of its own (as Feishu's long connection does) also needs the class exported from `src/index.ts` and a binding in `wrangler.jsonc`.

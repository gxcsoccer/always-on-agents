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

As soon as a message addressed to the agent is stored, the bot puts a "Get" reaction on it, so the person can see it arrived. It is a sign and not a message: if it fails, nothing else changes, and it is left out when it would come too late to mean anything (the message has already been dealt with, or 15 seconds have passed). It means "being handled": once the message has been dealt with (answered, or nothing to say, or handed on to an authorisation card), the reaction is taken off again. If Feishu is busy it is tried again a few times; reactions put on before this was in place stay.

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

The reaction that shows a message has arrived needs the app permission `im:message` or `im:message.reactions:write_only`. Without it the reaction is missing and everything else works.

In a group, only messages that mention the bot are sent to the agent. So a group message written as a reply may point at a message the agent never received. The message itself is stored and acknowledged first, as always. When the Brain is about to take it up and has no record of the message replied to, it asks the connector once, and the connector asks Feishu (at most 3 seconds, keeping at most 1,000 characters). The text is handed to the model only when the **same person** wrote that message (same group, same person, same organisation). What another member, a bot or someone from outside wrote is not handed on; the model is told only that the person replied to a message that is not shown to it. The same is said when the message cannot be fetched (no permission, recalled, timed out), and everything else works. This needs two app-identity permissions: a base permission to read messages (`im:message` or `im:message:readonly`) plus "read all messages in group chats" (`im:message.group_msg`); the bot also has to be in the group. Nothing is fetched in a direct chat: every message there has already been sent to the agent.

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

- **The person authorises once, in Feishu.** The first time, the bot sends them a card with a link to Feishu's consent page (OAuth authorisation code, with a PKCE challenge sent along; see the note on the token endpoint below). The link works once, for ten minutes, and only for them: when Feishu sends their browser back, the token is kept only if Feishu says it belongs to the very person the card was sent to, in the same organisation. They do not have to ask again: the request they made is kept and carried on (next point).
- **A request that needs authorising waits, and is carried on once the person has authorised.** The tool sends nothing and reads nothing; it answers "not yet". The Brain keeps the request, puts the invitation in front of the person, and ends that run. When the token has been kept, the grant tells the person's Brain, and keeps telling it until it has been heard. That is only a reason to ask: the Brain asks the connector whether this person's authorisation now covers what this request needs, and since when. If it does, and did before the invitation ran out, a run of its own makes that one read again (for the document as the connector identified it, not as the model wrote it) and sends one answer, to where the request came from. Anything the person writes while a request waits makes the Brain ask in the same way, and it asks once more when the invitation's time is up. A request whose invitation ran out unused ends without a message; one whose authorisation was taken away while it waited ends too, and is not carried over to a later authorisation. If the run that carries a request on cannot finish (it failed, or the day's budget is spent), the person is told so in place of the answer. The reasoning is in the [design](design/agent-core.md) and its [contract](design/agent-core-step0.md).
- **Before anything read goes further, the connector is asked again.** From the moment a run has read a document, the run and everything it writes stand under the authorisation the read was made under. This holds for an ordinary first read as much as for a request that was carried on. The authorisation is checked afresh just before Feishu is asked for the document, before every call to the model after the read, and before every attempt to hand a message the run wrote to Feishu. If it no longer stands before a model call, the model is not given the text, the run stops, and what it had written and not yet sent is emptied; the person gets a fixed notice that the agent stopped and that they can ask again. If it no longer stands when a message is about to be sent, the message is emptied and not sent, and the person gets a fixed notice that it was not sent. No notice is sent when the person called the request off themselves, or when an earlier attempt at the same message may already have arrived (it is then recorded as `unverified`). A carried-on request has, in addition, one hour from being taken up to read and to hand its answer over, and its answer is never sent ahead of a message the person has written that has not been handled yet: they may be calling the request off. What this check proves is limited: it asks the connector's own record whether the person's authorisation still stands, in the same generation and with the permissions the read needed. It is not a check that the person can still open that particular document; that is only tested by reading the document again. If the record cannot be asked when a message is about to be sent, the message is put off, about a minute at a time and at most eight times; then it is given up like one whose authorisation has ended, with the same notice, so that it does not hold the messages behind it for good.
- **A waiting request can be called off or replaced.** If the person says they no longer want it, the agent cancels it (`cancel_request`); if they ask for something else instead, the new read names the old request as replaced, and the old one ends in the same step. Both are possible until the answer is first handed to Feishu. Asking about something else in the meantime calls nothing off. When the person's message is a reply, what it replies to decides which request can be meant: a reply to a message of theirs that the request rests on (the one that links the document, and, when the link came in an earlier message, the single message that then asked for it), to the request's answer, or to its invitation card is about that request, and a reply to anything else is about none. When more than one request could be meant, none is cancelled and the person is asked which, in a message sent by the system itself: its opening sentence is written by the model so that it is in the person's language (a fixed sentence, in Chinese or English, is used if there is none), and the list that follows labels each request with the person's own words from the messages it is tied to. The first message the person writes after that question has reached them can pick one, once; a reply to the question itself counts as that answer. A reply to the question that is not its one valid answer (the question has been answered already, or this is not the first message since it arrived) decides nothing.
- **Only a document the person linked themselves is read.** It can be one linked in the request, or in one of their own messages here over the last day (at most their last fifty). Which of those is meant is the model's to say, and a document can be read again as often as they ask. A follow-up is first answered from what the agent already said (kept in the conversation's history); the document is read again only when more is needed. A request without a link written as a reply to a message of the person's own with a link is about that message's document, however long ago it was written; if that message has no link, the agent asks for it. A reply to one of the agent's own answers can only read what that answer was written from. The request keeps the messages it rests on while it waits for the person to authorise, and the link recorded for a read is the one in the message that named the document. For a document with little text (under 500 characters) the tool also looks up what it is made of: where it holds things that are not text (a whiteboard, a sheet, images), the agent is told which kinds and how many, so that "the body is a whiteboard" is not reported as "perhaps no permission". What the agent said or read is never among the person's messages. The link must be in their message as plain text (`https://….feishu.cn/docx/…` or `…/wiki/…`; `larkoffice.com` too). The connector records the links when the message arrives, from what the person typed: each is taken whole, up to the next space, and judged by its own host and path, so a Feishu address carried inside some other link does not count. A link followed directly by sentence punctuation is still found, and so is one with words right before it; words written straight onto its end could be part of its address, so then it is not counted; where it cannot be told where a link ends (two links run together without a space, say), it is not counted and has to be pasted apart. Text the agent has read cannot send it to another document, and neither can a word that merely looks like a document's id, or the name of someone mentioned.
- **The invitation is made by the connector and sent by the Brain.** It goes out through the conversation's outbox like everything else said to the person. The Brain holds only a reference to it; the fixed card and its link are made by the connector at the moment of sending, and are never kept by the Brain or shown to the model. An invitation that still has more than three minutes left is named again when it is asked for again, so two requests can share one card and the person sees it once; one that is nearly spent is replaced by a new one. A card is sent only while some request still waits on it and its time is not up; one that can no longer be used is not sent at all.
- **A follow-up reads history.** The agent's own replies, as delivered, stay in the conversation's history, so a later question about an answer is answered from what was said; a source is read again (under the rules above) only when more is needed. The earlier way, which kept answers apart and reopened them with a tool, is retired. See [follow-up history](design/follow-up-history.zh-CN.md) (in Chinese). This is built; it is not deployed yet.
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

**The token endpoint.** The authorisation code is exchanged at Feishu's current endpoint (`accounts.feishu.cn/oauth/v3/token`), which checks the PKCE verifier. Against one real app that endpoint refused a correctly formed verifier (error 20049, logged as `feishu_authorisation_refused` with `code` and `endpoint`). Feishu's authorisation page says to pair PKCE with its older endpoint for now, so an operator can switch one app to it:

```bash
curl -X POST $B/v1/admin/feishu-apps/cli_xxx/oauth -H "authorization: Bearer $ADMIN_KEY" \
  -H 'content-type: application/json' -d '{"token_endpoint":"v2"}'   # "v3" to switch back
```

Know what that gives up: Feishu's notes say the older endpoint does not refuse a verifier when it holds no challenge for the code, so a successful exchange there does not show that PKCE was checked. What still stands is the app's secret at the exchange, the single-use state bound to the invited person, the identity check and the exact-scope check. It is off unless turned on, per app.

**How long an authorisation lasts.** By default as long as the token Feishu issues, about two hours; after that the person is invited again. To make it last, enable the `offline_access` permission for the app in Feishu (user identity), publish that version, check that "refresh user_access_token" is on under security settings, and then turn it on here:

```bash
curl -X POST $B/v1/admin/feishu-apps/cli_xxx/oauth -H "authorization: Bearer $ADMIN_KEY" \
  -H 'content-type: application/json' -d '{"offline_access":true}'
```

People are then asked for that leave as well (those who authorised before are asked once more), and Feishu issues a second token for renewing the first. It can be used once and is replaced each time, so renewal happens in one place, one at a time, for exactly the permissions the person gave. If a renewal is refused, or its outcome cannot be known for certain (no answer, an unreadable answer, an attempt cut off halfway, a token that reaches further than before), the grant ends and the person is invited again; nothing is retried with a token that may be spent. Feishu sets the limits: the renewing token has its own lifetime (about a week in Feishu's examples, extended by each renewal), and after 365 days the person must authorise afresh. Turn the setting on only after the permission is published: until then Feishu's consent page fails.

The invitation card says, before the person agrees, that this authorisation renews itself and how to end it. Turning the setting off again (`{"offline_access":false}`) stops it for that app: new invitations no longer ask for it, an invitation for it that is still out is not honoured, and nothing is renewed any more; an authorisation already given keeps working until its current token runs out (about two hours), at which point the token for renewing is discarded and the person is invited afresh. To end one person's authorisation at once, use `DELETE /v1/admin/feishu-grants/…` above. Neither tells Feishu to revoke what it issued; the person can do that in Feishu's own authorisation settings.

**Reading in a group.** Off by default: a group has no tool for reading documents, as before. Turned on per app:

```sh
curl -X POST https://<your-domain>/v1/admin/feishu-apps/<app_id>/oauth \
  -H "authorization: Bearer $ADMIN_KEY" \
  -H 'content-type: application/json' -d '{"group_documents":true}'
```

With it on, when someone in a group mentions the bot with a document link (or replies to their own earlier message that had the link, mentioning the bot), the bot reads it with **that person's own authorisation** and answers under their message. What to know:

- Only in a group that is **the organisation's own**. Before every read Feishu is asked: the chat is not external, it belongs to the asker's organisation, and the bot is in it. All three have to be said outright. In an external chat the system answers with one fixed line asking them to message the bot directly; where it cannot be told, another fixed line. In both cases nothing is read, no card is sent, and the model does nothing further. The app needs permission to read chat information (`im:chat:readonly` or the like).
- Where the asker has not authorised yet, the card goes into the group but **only they see it** (Feishu's card visible to one member). A topic chat has no such card, so there it goes to them directly and the group is told so. Once they authorise through that card, the answer appears under their message by itself. The card is for that one question: authorising some other way does not carry the group's request on, and asking again simply reads.
- Feishu drops no repeat of such a card, so it is sent once: if the outcome is not known it is not sent again, and the group is told it may not have arrived and to ask again.
- Each person can have only links they posted themselves read, with their own authorisation. Others can ask about what was already answered in the group; to have the document read again they post the link themselves.
- Between reading and sending, if the setting is turned off (or off and on again), the chat becomes external, or the bot is removed, what was written is not sent.
- Known limits: someone who asked, was then removed from the group and still authorised within the ten minutes has the answer posted to a group they are no longer in. An answer already posted can still be quoted by the bot after the chat later becomes external; that is left for later.

To see what Feishu says about one chat (to check the permissions, say): `GET /v1/admin/feishu-apps/<app_id>/chats/<chat_id>` returns only whether it is external, whose it is, its mode, whether the bot is in it, and Feishu's status codes.

### How messages look

What the agent writes itself goes out as a Feishu post with one Markdown element, so bold, lists, links, code and tables render. Mention markup in it (`<at …>`), in code too, is shown as text and notifies nobody (it gains one invisible character). The system's own fixed words go out as plain text, and questions and invitations as cards. A post that would exceed Feishu's 30 KB is sent as plain text instead. The form is decided from the message alone, so a retry sends exactly the same thing.

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
  channel: { deliver, amend, standing, received, dedupeMs },
  // Optional: things the agent can do in that system for one person
  tools: [{ name: "example_read", description, parameters, run }],
  // Required if one of those tools can answer "not yet"
  async holds(env, scope, condition, generation) {},
};
```

Each part is optional and independent. A connector that only reports events (a CI notifier, say) has `http` and nothing else.

| Part | What it must do |
|---|---|
| `http` | Authenticate the request **before** believing anything in it. Build an `InboundEvent` (`src/events.ts`) with `source` set to the connector's name, a stable `source_id` for de-duplication, and a `principal` that says who caused it and whether they were addressing the agent. |
| `channel.deliver` | Send one message. Throw if it was not delivered. It will be retried, so use the message's `idem` key to avoid sending twice. Return a `Receipt` that names the message it became where the system can say; throw the specific errors below where they apply. |
| `channel.amend` | Optional. Show a delivered approval question as closed. |
| `channel.standing` | Required if people can edit or delete what they said in that system. See below. |
| `channel.received` | Optional. Show the person, on the message they wrote, that it has arrived (a reaction, say). Called once per message a person addressed to the agent, as soon as it is stored. It must never add a message to the conversation. Call `event.wanted()` last of all, just before posting, and post nothing if it says no: the sign would come too late to mean anything. Resolve to an opaque mark (the reaction's id, say) only if the outside system confirmed the sign, `undefined` if there was nothing to mark or it was skipped. Nothing waits for it, and if it throws nothing else changes. |
| `channel.unreceived` | Optional. Take a mark `received` put on off again, once the message has been dealt with. Resolve to `"removed"` (also if it was already gone), `"retry"` when the outside system could not say, or `"permanent"` when it will not come off. The Brain keeps the mark until then and asks again later on `"retry"`. |
| `channel.dedupeMs` | Optional. For how long the outside system drops a repeat of the same `idem` (one hour for Feishu). See below. |
| `holds` | Required if a tool of this connector can answer with a `Waiting`. See [A tool that has to wait](#a-tool-that-has-to-wait). |

**How a delivery ended.** The Brain tells four outcomes apart, and what `deliver` throws decides between them:

- It returns: the message is `sent`. With a `Receipt`, the Brain also knows which message it became; only then can a reply to it be recognised.
- It throws `DeliveryVoid`: there is no longer anything to send (what the message was to show can no longer be used). Nothing was posted and it is not tried again; the message is recorded as `void` (or as `unverified`, if an earlier attempt may have arrived).
- It throws `DeliveryRejected`: the outside system answered and refused, so it is certain that nothing was posted. `DeliveryDeferred` (the system said to wait) is equally certain. The message is retried, and if every retry ends this way it is recorded as `dead`.
- It throws anything else: this attempt may have arrived. The message is retried with the same `idem`, which is safe for as long as the system drops repeats. Once the first attempt is older than `dedupeMs`, or the retries are used up, the message is not sent again and is recorded as `unverified`: it may have reached the person, and a second copy could not be told from the first. A connector without `dedupeMs` gets the earlier behaviour: retried, then `dead`. Approval questions keep their own reckoning (see [Approvals](approvals.md)).

### Tools

A connector can give the agent tools: things it can do in the outside system on one person's behalf, such as reading a document as that person. A tool is `{ name, description, effect: "read", parameters, run(context, args) }`, named `<connector name>_…`. Only tools that read exist so far. `context.person` is who the call is for; the tool must act as that person and nobody else. `context.said` is that person's messages that started the run, each with its text and the `data` the connector attached, so a tool can hold a call to what they themselves asked for; `context.recent` is the same for what they wrote there shortly before. A tool sends nothing itself. One that cannot act yet because the person has not authorised it answers with a `Waiting`, and what the person is shown goes out through the Brain like everything else said to them; see [A tool that has to wait](#a-tool-that-has-to-wait).

The core decides when a connector's tools exist at all, and for whom:

- **Only where it is beyond doubt whose authority a call carries.** Tools are offered in a person's own scope, in their private conversation through this connector, in a run started by nothing but ordinary messages that person wrote to the agent there. To make that possible a connector gives such messages `data.origin` (what it verified about where they came from, such as the app and the organisation; every value non-empty), `data.direct: true`, and the session key `privateSessionKey(name, origin)` from `src/events.ts`. A button press, a reply to a question, something routed from elsewhere, a timer, a worker's report, another person's message, or a message through another connector: any of these in the batch and the tools are not there. In a group or a repository they never are.
- **The private conversation is its own.** The same user id can be reached in other ways, for instance by a tenant's backend through the console. Those are other conversations with their own history; nothing said in the private one is shown to them.
- **Arguments cannot choose the person.** `context.person` comes from the stored events, worked out again at each call.
- **What a tool returns is outside text, and so is what is made of it.** From its first use of a connector's tool, a run can do two things only: reply to the person, and read again. Every other tool is refused, by a list of what is allowed rather than of what is forbidden. When the run ends, everything it produced is removed from the conversation's record, the original text and the model's own words alike, and replaced by one fixed note. The messages it wrote are emptied, in every form, once they have been delivered or given up, and the text of its errors is not kept. A later run reads again from what the person themselves pointed to. Nothing of it is kept apart anywhere else. While a run is still under way (paused for a budget, or retrying), its record is kept.
- **Nothing is routed across a private conversation.** A reply elsewhere that names an open question's code is normally taken to that question. Not into or out of a private conversation.
- **Every call is audited** (`tool.used`, with the person and the tool, not the arguments).
- A call may be repeated after an interruption, so a tool must be safe to run twice.

### Where several people talk, and a tool that settles the matter itself

A tool exists only in one person's private conversation with the agent unless it declares `shared: true`. Then it is also there in a conversation several people share (a group, say), acting for **the one who asked**. That takes the connector marking the message `data.shared: true` (as `data.direct` marks a private one), and every message that started the run being an ordinary message one person wrote to the agent. Such a tool answers for whether reading something there, and having it said in front of the others, is right.

A tool can return `{ settled: { say?: "<name of a fixed line>" } }`: the matter ends here, nothing was read and nothing waits. The Brain closes the run (no tool can be used in it any more, and the model is not asked again) and, where `say` is given, the system says that one line. `say` can only name one of the system's own fixed lines; the tool writes no words of its own there. One that is not whole, or names a line there is not, is a failure of the tool.

### A tool that has to wait

A tool that cannot act until something happens that is not the agent's to do (the person authorising, say) returns `{ waiting: { … } }` instead of a result. It reads nothing and sends nothing. The Brain keeps the request, shows the person the way in, ends the run, and later carries the request on in a run of its own: the same tool is called again and the person gets one answer without asking twice. The Feishu document tool is the example (`src/connectors/feishu-docs.ts`); the reasoning is in the [design](design/agent-core.md) and the [contract](design/agent-core-step0.md).

Every field of a `Waiting` is the connector's own. The Brain stores them and hands them back; it does not interpret the strings, and none of them is shown to the model, which is told only that the request waits and under which id.

| Field | What it is | Who reads it |
|---|---|---|
| `on` | A word for what is waited on, such as `"authorisation"`. | Written to the audit entry `request.waiting`. |
| `subject` | Whose condition it is. | The Brain compares it with the subject of a report (`conditionReported`, below) to find the requests to ask about. |
| `condition` | What exactly has to hold for this request. | Handed back to the connector's `holds`. |
| `generation` | The state of the connector's own record that the wait belongs to. | Handed back to `holds`, which answers "gone" once the connector has moved past it; and to the tool, as `context.resuming.generation`. |
| `until` | A time in milliseconds. The condition has to have come to hold before it. | The Brain compares it with the `since` that `holds` returns, and ends the wait when it has passed. |
| `interaction` | A reference to what the person is to be shown so that they can bring the condition about. | Handed to the connector's own `channel.deliver` as `message.interaction`. |
| `privately` (optional, `true` or `"here"`) | `"here"`: for this person alone, and where they asked if possible (the connector's `channel.aside` gives an address in that conversation only they see; without one it is treated as `true`). Where such an address drops no repeat (`dedupeMs` returns 0 for it), an attempt of unknown outcome is the last. `true`: the invitation is for this person alone: it is not put where the request was made (a conversation several people share is not the place for it) but before them directly. | The tool only says so and names no address. Where "directly" is, the connector's `channel.direct` works out from the request's verified origin and the person's identity; if it cannot, the wait is not kept. The conversation the request was made in gets one fixed line once the outcome is known: sent to them directly, could not be sent, or no telling whether it arrived. An invitation that is refused is given up at once, and one that gets no answer after three tries, so it never holds back what else is waiting to be said in that conversation. |
| `request` | The call to make again, in the tool's own canonical form: only what identifies the thing asked for. | Stored in place of the arguments the model wrote, and passed to the tool's `run` as its arguments when the request is carried on. |

What a connector must do to offer such a tool:

- **Return a complete `Waiting`.** `on`, `subject`, `condition` and `interaction` are non-empty strings, `generation` and `until` are numbers, `request` is an object the tool accepts as its arguments. Anything else is treated as an ordinary result.
- **Implement `holds(env, scope, condition, generation)`.** It says whether the condition holds now, checked afresh against what the connector itself keeps and never against what a caller says: `{ state: "holds", since }` with the time it began to hold by the connector's own record, `{ state: "not_yet" }`, or `{ state: "gone" }` when it can no longer come to hold as it was asked for. It throws if that cannot be found out; the Brain then asks again a minute later, for as long as the wait lasts. The Brain calls it to decide whether to take a request up, and then, for any run that has read under a condition, before every model call and before every attempt to hand over a message that run wrote, so it must be cheap and must reflect an authorisation taken away at once. It speaks only for the condition as the connector records it. Whether one particular thing can still be reached is not its question; that is found out only by reading the thing again.
- **Make what the person is shown in `channel.deliver`, at the moment of sending.** A message with `interaction` set is the invitation. Whatever the reference stands for (a link that authorises, say) exists only inside the connector and in the message as sent. If it can no longer be used, throw `DeliveryVoid`. A channel that does not know the reference sends the message's `text`, a fixed sentence from the Brain. Two requests that return the same `interaction` share one message.
- **Tell the Brain when something changed for a subject.** Call `conditionReported(connector, subject, event)` on the Brain of the person's scope, and keep calling until it answers `{ ok: true }` (the Feishu grant owes this from the same write that keeps the token, and retries from an alarm). The report carries no authority and names no request: it only makes the Brain call `holds` for each request of that scope waiting on that subject. Without a report, a request is still looked at when the person next writes in that conversation and when `until` passes.
- **Honour `context.resuming`.** It is set when the call carries on a request that waited: `{ generation, notAfter }`. If the connector has moved past that generation, or the time is past `notAfter`, the tool does nothing and says so; it must not start the request over under a newer generation. Within the same generation it may answer with a `Waiting` again (more is needed than was given); the request then waits again and nothing is sent meanwhile.
- **Use `context.callId` as the key for anything that must happen once.** It is the same on a repeat and the same when the request is carried on.
- **Call `context.relied("said" | "recent", index)`** for each of the person's messages the action actually rests on: the one in `context.said` that names the thing, or the one in `context.recent` when the tool acts on that rather than on what was just said ("summarise it" after a link). The Brain keeps a `recent` message named this way, and no other earlier one, as part of what the request rests on; when the request is carried on, `context.said` and `context.recent` are exactly those messages again. A reply to one of the named messages is taken to be about this request, and a reply to any other message of the person's is not. A tool that names none has requests that no reply to a message of the person's can single out.
- **Call `context.identified(request, identity, under)`** when the tool has read something, before it returns. `request` is the call that would read the same thing again, in the tool's canonical form, and `identity` names the very thing that was read as the outside system resolved it (for Feishu, the document's own id, since a wiki link can come to point at another document). `under` is `{ condition, generation }` in the same terms as a `Waiting`'s: what `holds` can be asked about later. With `under`, the run and every message it writes from then on stand under that condition: the Brain asks `holds` before every model call in the run and before every attempt to hand over a message the run wrote, and what was read goes no further once the answer is not "holds". `under` is required. Without `identified` at all, nothing ties the run to what the read was made under, and these checks are not made for it.
- **Give replies a `data.replies_to`.** When a person's message is a reply to another message, the event's `data.replies_to` is the `subject` that `deliver` returned in that message's `Receipt` (for Feishu, `feishu:message:<id>`). The Brain uses it to tell which request or which answer a reply is about.

What the Brain does around such a tool, whatever the connector says:

- The tool's parameters are shown to the model with one more, `replaces`: the id of a waiting request that this call is to take the place of. The tool never sees it.
- The run that carries a request on can do two things: the one call, with the stored `request`, and `send_message`. Its one answer is held as a draft until the run ends, goes to where the person's message came from, and is sent once.
- A carried-on request has one hour from being taken up. Past it nothing more is read and an unsent answer is not sent.
- When a message written after a read is not sent because its condition no longer holds or its time is up, the Brain tells the person so in fixed words, unless they called the request off themselves. The connector sends nothing for this.
- A run that reads notes what it read and what it read under, for the length of the run only: the call, the identity, and the connector, condition and generation. The messages it writes carry only the connector, condition and generation, until they leave the queue.
- `cancel_request` takes `ask`: one sentence in the person's language that opens the system's "which one?" message.
- Calling a request off and replacing it are possible only in a run that rests on nothing but the person's own messages in their private conversation: the same test as for the tools themselves.

### What the core decides, whatever a connector says

- **Whose word counts.** A connector says who caused an event. Whether that person can approve an action, be credited with a request, or change standing instructions is decided by the Brain, and only for connectors listed under `trusted` in `src/agent.config.ts`. Events from any other connector inform the agent and decide nothing. List a connector there only if it proves where each event came from and who caused it.
- **Accounts that are not tenant users.** If the connector identifies an account in its own system that is not linked to a user of the tenant, it sets `principal.unlinked`. Such a person is not a member of any scope.
- **Messages that can change.** A connector whose messages can be edited or deleted gives its events a `subject`, a `revision` and a `holder`, and implements `channel.standing`, which reads the message again from the system. Before an approval counts, the Brain asks it what each such message says now, for the messages from members that the approval could rest on. If the connector has no `standing`, or does not recognise the message, nothing is approved on it. The same goes for the agent's own question when it was posted somewhere others can edit it.

Connectors are first-party code compiled into the Worker: each one is handed the whole environment and writes its own name on its events. The `trusted` list guards against a connector being relied on by oversight, not against one that misstates where its events came from, so review a connector as you would any code that holds the deployment's secrets. A connector that needs a Durable Object of its own (as Feishu's long connection does) also needs the class exported from `src/index.ts` and a binding in `wrangler.jsonc`.

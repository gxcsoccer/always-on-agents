# Operations

**English** | [简体中文](operations.zh-CN.md)

## Deploying

You need a Cloudflare account on the Workers Paid plan (Durable Objects and Containers) with R2 enabled, and a Docker-compatible runtime on the machine you deploy from: `wrangler deploy` builds the sandbox image.

```bash
pnpm install
pnpm exec wrangler login
pnpm exec wrangler r2 bucket create always-on-agent-checkpoints

pnpm exec wrangler secret put OPENAI_API_KEY
pnpm exec wrangler secret put ADMIN_KEY          # a long random string

pnpm run deploy
```

The Worker is served at `https://always-on-agent.<your-subdomain>.workers.dev`. To serve it from your own domain as well, add a route to `wrangler.jsonc` (an example is there, commented out) or deploy with `--domain agent.example.com`.

Then create a tenant (see below) and connect something to it: [Connectors](connectors.md).

A deploy restarts the Durable Objects. Runs in progress resume from their transcripts, sandbox tasks keep their containers, and Feishu long connections reconnect within a few seconds.

**Moving to the version in which requests wait.** Before it, a person who authorised reading their Feishu documents was told to send their request again; from it on, the request is kept and carried on (see [Connectors](connectors.md)). Someone who is in the middle of authorising when this version is deployed holds a card from the old one. That card still works and the token is stored, but the request made before the deploy was never kept, so it is not carried on. The page they land on says so for every case: a request that is waiting is carried on, and if nothing arrives within a few minutes they should ask again. An invitation from the old version that had not been delivered when this version is deployed is not sent by anything any more: it lapses within its ten minutes, and the person has to ask again. Nothing needs doing by hand. Messages that were already being retried at that moment are treated as possibly delivered: they are not given a fresh hour in which to be repeated.

## Configuration

Plain variables are in `wrangler.jsonc`; secrets are set with `wrangler secret put` (or in `.dev.vars` for local development; see `.dev.vars.example`).

| Name | Kind | Purpose |
|---|---|---|
| `OPENAI_BASE_URL` | variable | Where the Brain's model calls go, and the only origin the sandbox proxy lets model traffic reach. The sandboxed agent itself is started with its built-in OpenAI provider and is not told this address, so for now leave it at OpenAI's API: pointing it elsewhere keeps chat working and breaks sandbox tasks. |
| `BRAIN_MODEL` | variable | The model the Brain uses. |
| `WORKER_MODEL` | variable | The model the sandboxed agent uses. It is the only model the sandbox may call. |
| `OPENAI_API_KEY` | secret, required | The key for that service. It never enters a container; the outbound proxy adds it. |
| `ADMIN_KEY` | secret, required | Guards the admin API. |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | secret | The GitHub App the agent acts as. With these, tokens are issued per installation and repository. |
| `GITHUB_WEBHOOK_SECRET` | secret | The App's webhook secret. |
| `GITHUB_BOT_HANDLE` | secret | The agent's account name on GitHub (an App's slug). How people address it. |
| `GITHUB_BOT_EMAIL` | secret | The address sandbox commits are made under. |
| `GITHUB_TOKEN` | secret | One token for every repository, used only when no App is configured. Local development only. |
| `PUBLIC_ORIGIN` | secret or variable | Where the deployment is reached from outside, such as `https://agent.example.com`. Needed for reading people's Feishu documents: it is where Feishu sends them back after they authorise. |
| `GRANTS_KEY` | secret | Seals the tokens people's authorisations produce. 32 or more random characters. Changing it makes every stored authorisation unreadable, and people are invited to authorise again. |
| `GATE_HOLD_PATTERN` | secret or variable | Optional regular expression for shell commands inside the sandbox that a person must approve. Default: none. |

`FOLLOW_UPS` is no longer read: following up on a kept answer has been retired. A deployment that set it as a secret can delete it with `wrangler secret delete FOLLOW_UPS`.

The sandboxed coding agent and its version are fixed in the `Dockerfile`.

## The admin API

Every request carries `authorization: Bearer $ADMIN_KEY`. There is one admin key and it can do everything below; treat it accordingly.

### Tenants and registrations

| Request | Body | Effect |
|---|---|---|
| `POST /v1/admin/tenants` | `{"id","name"}` | Creates a tenant and returns an API key for it, once. Calling it again for the same tenant issues a further key; earlier keys stay valid. Only a hash of each key is stored. |
| `POST /v1/admin/tenants/:id/github-installations` | `{"installation_id"}` | Says a GitHub App installation belongs to this tenant. |
| `POST /v1/admin/tenants/:id/github-repos` | `{"repo":"owner/name"}` | Registers one repository for a per-repository webhook. Returns `webhook_secret`, once. Calling it again for the same repository replaces the secret at once, so the webhook configured with the old one stops being accepted until it is updated. |
| `POST /v1/admin/tenants/:id/identities` | `{"provider","external_id","user_id"}` | Says an outside account (for GitHub, its numeric id) is this tenant's user. |
| `POST /v1/admin/tenants/:id/feishu-apps` | `{"app_id","app_secret","bot_open_id","transport", ...}` | Registers or updates a Feishu app. `transport` is `long_connection` or `webhook` (which also needs `encrypt_key`). |
| `POST /v1/admin/tenants/:id/chat-repos` | `{"chat","repo"}` | Lets tasks from one group chat use one repository. `"repo": null` removes it. |

### Looking inside

| Request | Returns |
|---|---|
| `GET /v1/admin/scopes/:scope` | A scope's state: inbox counts, recent events, runs, memory files, timers, tasks, outbox, today's tokens, health figures, the latest audit entries, and `waits` (below). The outbox entries show no text for a message written after a run read outside text, or for the answer to a request that waited. URL-encode the scope name. |
| `GET /v1/admin/scopes/:scope/memory?path=...` | One memory file. |
| `GET /v1/admin/tasks/:id` | A sandbox task's state. Secrets are hidden. |
| `GET /v1/admin/tasks/:id/files/{events,hooks,stderr}` | The tail of one of the task's logs. |
| `POST /v1/admin/tasks/:id/probe` | Runs checks inside the task's container (what it can reach, what it holds). |
| `POST /v1/admin/tasks/:id/kill-container` | Destroys the container, to exercise recovery. |
| `GET /v1/admin/feishu-links/:app_id` | The state of a Feishu long connection. |
| `POST /v1/admin/feishu-apps/:app_id/oauth` | How that app's authorisations are obtained: `{"token_endpoint":"v2"}` or `"v3"` (the default) for which of Feishu's token endpoints is used; `{"offline_access":true}` to ask people for leave to renew, so an authorisation lasts. Either or both. See [Connectors](connectors.md). |
| `GET`, `DELETE /v1/admin/feishu-grants/:app_id/:tenant_key/:open_id` | Whether one person's authorisation to read their documents stands; `DELETE` takes it away. Never returns a token. |

### Other endpoints

| Request | Purpose |
|---|---|
| `GET /healthz` | Liveness. |
| `POST /v1/github/webhook` | GitHub deliveries. |
| `POST /v1/feishu/events/:app_id` | Feishu deliveries (webhook transport). |
| `GET /v1/feishu/oauth/callback` | Where Feishu sends a person's browser after they authorise reading their documents. |
| `/v1/console/...` | The console connector; authenticated with a tenant API key. See [Connectors](connectors.md). |

## Watching it

The Worker writes structured logs (one JSON object per line); observability is enabled in `wrangler.jsonc`. There is no alerting built in.

`GET /v1/admin/scopes/:scope` includes a `health` object worth watching:

| Field | Means |
|---|---|
| `oldest_pending_age_ms` | How long the oldest unhandled event has waited. Should stay near zero. |
| `dead_events` | Events given up on. |
| `undeliverable_messages` | Messages that could not be delivered after all retries. |
| `unverified_messages` | Messages that may have been delivered and could not be checked; they are not sent again. |
| `lost_tasks` | Sandbox tasks whose container was lost and could not be restored. |
| `abandoned_runs` | Runs entered five times without finishing. |

`undeliverable_messages` counts messages that ended as `dead` only; ones that ended as `unverified` are counted in `unverified_messages`.

### What the scope is waiting on

`waits` lists, in one shape, the latest 20 requests that waited for a condition (a person authorising, say) and the latest 20 approval questions. Each entry has `kind` (`request` or `approval`), `id`, `state`, `shown` (whether the invitation or the question was delivered) and `since` (when it began). It is read-only; approvals are kept where they always were.

| `state` | For a request | For an approval |
|---|---|---|
| `waiting` | The condition does not hold yet. | No answer yet. |
| `continuing` | Taken up; a run is making the call again. | |
| `answer to be sent` | The run ended; its answer is in the outbox. | |
| `reconciling` | | An answer was sent to the worker and is not yet confirmed. |
| `done` | Answered. | Approved. |
| `refused` | | Refused. |
| `failed` | Its answer could not be delivered. | |
| `withdrawn` | Called off by the person, ran out of time, or what it waited for was taken away. | Withdrawn. |
| `cannot be verified` | Its answer may have been delivered; that could not be checked. | Whether the answer took effect cannot be found out. |

Why a request ended is in the audit entry `request.ended`.

### Message statuses

An entry in `outbox` has one of these statuses.

| Status | Means |
|---|---|
| `pending` | To be sent, or being retried. |
| `draft` | The answer of a request being carried on, while its run is still under way. Nothing sends a draft. |
| `sent` | Handed over, and the outside system confirmed it. |
| `void` | Never handed over: the request it belonged to was called off or no longer stood, what the run that wrote it had read may no longer be passed on (the authorisation ended), or the invitation it was to show could no longer be used. Its text is removed. |
| `dead` | Given up, and it is certain nothing was posted: every attempt was refused by the outside system. Also the ending for any failed message on a connector that states no window for repeats. |
| `unverified` | Not sent (again), though an attempt may have arrived and that cannot be checked. This is what a message becomes when its retries are used up after an attempt with no clear answer, or when its first attempt is older than the window in which the system drops repeats (one hour for Feishu). Its text is removed. It is never sent again. |
| `withdrawn`, `reconciling` | Approval questions only. See [Approvals](approvals.md). |

Two columns tie a pending message to what its run read, and neither is returned by the admin API. `guard` holds what the message may go out under: the connector, and the condition and generation the read was made under. It holds no document text. `source` is no longer written; it was used only for follow-ups on kept answers, which have been retired. Migration 22 cleared `source` on every row when it ran, queued ones included. `guard` is cleared as soon as the message is no longer `pending` or `draft`, however it ended.

A run that reads notes, for the length of the run only, what it read and what it read under: the call that reads it (which holds the document's link), the document's id, and the connector, condition and generation. This is so that the checks before each model call and each send can be made. The note is removed when the run ends. No message ids, hashes or passages of text are noted.

### Fixed messages from the system

These are the ones that go with requests that wait and with reads. They are written by code, not by the model, appear in `outbox` with their text, and are sent in Chinese if the person's latest message in that conversation has Chinese characters in it, in English otherwise (the English wording is shown here).

| Sent when | Text begins |
|---|---|
| A run that had read something was stopped before a model call because what it read under no longer holds. What it had written and not sent is `void`. | "I stopped before finishing: the authorisation for what I was reading has ended. Please ask again." |
| A message written after a read was not sent because what it was read under no longer holds, or its time was up; it is `void`. It is also not sent when the owner of that condition could not be asked after eight tries, and the notice then says that the authorisation could not be confirmed rather than that it ended; those eight are counted apart from delivery attempts. Not sent when the person called the request off, for an invitation, or when the message ended as `unverified`. | "I did not send what I had written for you…" |
| A carried-on request's run ended without writing an answer. | "I could not finish what you asked for earlier. Please ask again." |
| More than one request could be meant by a cancellation. The opening sentence is the model's, in the person's language, with a fixed sentence (chosen the same way) as the fallback; the numbered list is the person's own words. | "More than one of your requests could be meant. Which one?" |

The first two share one key, `withheld:<run id>`, so a person gets at most one of them for a run, whichever comes first and however many of the run's messages were withheld.

### Log lines and audit entries

| Log line | Means |
|---|---|
| `received_shown` | The sign that a person's message arrived (on Feishu, a reaction) was shown; `ms` is the time from the message being stored. It is written only when the outside system confirmed the sign. If the line is missing for Feishu messages, check the app's reaction permission; it is also missing, by design, when the sign was skipped because the message had already been dealt with or 15 seconds had passed. |
| `request_answered` | The answer of a carried-on request was delivered; `claim_to_receipt_ms` is the time from the request being taken up to the channel confirming the answer. |
| `message_unverified` | A message was given the status `unverified` before another attempt was made (its request no longer stood, or the window for repeats had passed); `outbox_id` names it. |
| `message_undeliverable` | A message was given up after its retries, as `dead` or as `unverified`. |

| Audit action | Means |
|---|---|
| `request.waiting` | A request was kept; `on` says what it waits for. |
| `request.resumed` | A request was taken up; `run` is the run carrying it on. |
| `request.ended` | A request ended; `as` is `done`, `failed`, `cancelled`, `expired`, `void` or `unverified`, and `why` says what ended it. |

## Limits

Those marked "can be set" can be set for each tenant; the table gives what holds where they were not. The rest are constants in the code.

```bash
# A tenant's limits as they stand, and the defaults
curl -H "authorization: Bearer $ADMIN_KEY" https://<your domain>/v1/admin/tenants/<tenant>/limits
# Set some of them: those not named stay as they are, and null puts one back to the default
curl -X PUT -H "authorization: Bearer $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"scope_daily_tokens": 5000000, "scope_active_tasks": null}' \
  https://<your domain>/v1/admin/tenants/<tenant>/limits
```

Their names: `scope_daily_tokens`, `tenant_daily_tokens`, `scope_active_tasks`, `tenant_sandboxes`, and `run_steps` (how many times one run of the agent may ask the model, 1–100), `task_minutes` (how long one sandbox task may run, 5–480), `task_model_calls` (how many times one sandbox task may ask the model, 1–5000). The first four are whole numbers, 0 or more; the last three have their own ranges and cannot be 0 (to have no tasks run, set how many may be under way to 0). `task_minutes` and `task_model_calls` are fixed for a task as it is handed over: one already running goes by what held when it began; `tenant_daily_tokens` is either 0 or at least 20000 (that much is set aside before every call to the model, so a smaller day could never begin one). The answer's `overrides` are the figures set for this tenant, and `least` and `most` the smallest and largest each may be. A tenant that does not exist answers 404; a change that is not well formed, 400.

What 0 means: with `scope_daily_tokens` at 0 the agent itself makes no more calls to the model in that scope; sandbox tasks already under way finish, and what they spent is counted when they end. With `tenant_daily_tokens` at 0 neither the agent nor any sandbox of the tenant may begin another call. The two limits on work at once, at 0, only keep new work from being taken; what is under way is finished.

A change takes effect in a scope from its next call to the model (a tool call already made goes by the figures as they were). A scope already paused because its day was spent goes on the next day (UTC): raising a limit does not wake it earlier.

| What | Limit |
|---|---|
| Tokens per scope per day | 2,000,000 (can be set) |
| Tokens per tenant per day | 20,000,000 (can be set) |
| Model steps per run | 16 (can be set) |
| Events claimed into one run | 40 |
| Sandbox tasks at once | 3 per scope, 5 per tenant (both can be set) |
| Sandbox task: startup / idle / lifetime | 5 min / 15 min / 2 h (the lifetime can be set) |
| Sandbox task: model calls | 400 (can be set) |
| Sandbox task: recoveries after losing the container | 2 |
| A push held for approval | 50 min |
| A carried-on request, from being taken up to its answer being handed to the channel | 1 hour. Past it nothing more is read and an unsent answer is not sent. |
| A message whose condition cannot be checked because its owner cannot be asked | Put off 8 times, about a minute apart, then given up: `void`, or `unverified` if an attempt may have arrived. The person gets the notice. |
| An invitation to authorise on Feishu | 10 min. A request waits no longer than the invitation it was shown with. |
| `index.md` loaded into a run | The first 4,000 characters |
| `instructions.md` loaded into a run | The first 8,000 characters |

A memory file longer than its limit is stored whole; the run is told that the rest was left out and to shorten it.
| Model request from the sandbox | 4 MB |
| Push from the sandbox | 64 MB |

## Retention

| Data | Kept for |
|---|---|
| A finished task's container, checkpoints and records | 24 hours |
| The text of handled events | 30 days (the record itself, without its text, for 365 days so that a late redelivery is still recognised) |
| Delivered messages and finished timers and tasks | 30 days |
| An ended request (the record of a wait) | 30 days |
| A conversation's transcript | Kept in full while the conversation is in use. Once a conversation has been quiet for 30 days it is cut back to roughly its latest 200 items (the cut lands on a user turn, so slightly fewer may remain). There is no upper limit on how long an active conversation's text is kept. |
| What the agent said in a private conversation (`said`) | Removed with its conversation's transcript: when a run's items are cut, that run's `said` rows go too. Not tied to the outbox row, which goes after 30 days on its own. |
| Audit entries | 365 days |

## Cost notes

- A Brain is awake only while it handles events. A scope that still holds events also wakes briefly once a day to remove old records, until none are left; otherwise an idle scope costs storage only.
- A sandbox task holds a container for as long as it runs.
- A Feishu app on the long connection keeps one Durable Object awake all the time.
- Model usage is bounded by the daily budgets above. All tenants share the one model key.

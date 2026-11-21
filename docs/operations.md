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
| `GET /v1/admin/scopes/:scope` | A scope's state: inbox counts, recent events, runs, memory files, timers, tasks, outbox, today's tokens, health figures and the latest audit entries. URL-encode the scope name. |
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
| `lost_tasks` | Sandbox tasks whose container was lost and could not be restored. |
| `abandoned_runs` | Runs entered five times without finishing. |

## Limits

These are constants in the code, not configuration.

| What | Limit |
|---|---|
| Tokens per scope per day | 2,000,000 |
| Tokens per tenant per day | 20,000,000 |
| Model steps per run | 16 |
| Events claimed into one run | 40 |
| Sandbox tasks at once | 3 per scope, 5 per tenant |
| Sandbox task: startup / idle / lifetime | 5 min / 15 min / 2 h |
| Sandbox task: model calls | 400 |
| Sandbox task: recoveries after losing the container | 2 |
| A push held for approval | 50 min |
| Model request from the sandbox | 4 MB |
| Push from the sandbox | 64 MB |

## Retention

| Data | Kept for |
|---|---|
| A finished task's container, checkpoints and records | 24 hours |
| The text of handled events | 30 days (the record itself, without its text, for 365 days so that a late redelivery is still recognised) |
| Delivered messages and finished timers and tasks | 30 days |
| A conversation's transcript | Kept in full while the conversation is in use. Once a conversation has been quiet for 30 days it is cut back to roughly its latest 200 items (the cut lands on a user turn, so slightly fewer may remain). There is no upper limit on how long an active conversation's text is kept. |
| Audit entries | 365 days |

## Cost notes

- A Brain is awake only while it handles events. A scope that still holds events also wakes briefly once a day to remove old records, until none are left; otherwise an idle scope costs storage only.
- A sandbox task holds a container for as long as it runs.
- A Feishu app on the long connection keeps one Durable Object awake all the time.
- Model usage is bounded by the daily budgets above. All tenants share the one model key.

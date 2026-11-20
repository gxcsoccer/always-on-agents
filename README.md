# always-on-agents

**English** | [简体中文](README.zh-CN.md)

An always-on agent built on Cloudflare. It sleeps until something happens, wakes up, acts without anyone watching, and remembers what it did. It serves many tenants, works in direct chats, group chats and code repositories, and hands anything slow to a coding agent running in a sandbox.

The design follows Anthropic's article [Building always-on agents](https://claude.com/resources/articles/building-always-on-agents) and its five primitives: an event inbox, timers, memory, permissions and an outbox.

```
Feishu / GitHub / console / timers / worker reports
        │
   Ingress Worker          verify, find the tenant, pick the scope, return at once
        │ ingest()
┌───────▼────────────────────────────────────────────┐
│ Brain  (one Durable Object per scope)               │
│ SQLite: inbox · sessions · items · memory · timers  │
│         · tasks · outbox · runs · audit             │
│ alarm(): fire timers → deliver outbox → run         │
└───┬────────────────────────────────────┬───────────┘
    │ dispatch / answer / cancel         │ deliver
┌───▼──────────────────────────┐   ┌─────▼──────────────┐
│ TaskSandbox (one per task)    │   │ Connectors          │
│ a container running a coding  │   │ console · GitHub ·  │
│ agent; one guarded way out    │   │ Feishu              │
└───────────────────────────────┘   └────────────────────┘
```

## What it does

- **One brain per scope.** A user, a group chat or a repository each gets its own Durable Object with its own inbox, memory and outbox. Nothing is shared between scopes.
- **Events in, messages out.** Every trigger is written to the inbox first and handled in a short run. A run that is interrupted by a crash or a deploy picks up where it stopped.
- **Timers and memory.** The agent can remind, follow up and keep notes across conversations.
- **Sandboxed workers.** Long work goes to a coding agent in a container that has no credentials and one way out: a proxy that allows the model API and git, and nothing else.
- **Approvals decided by code.** What leaves the sandbox (a `git push`) is held until a person approves the exact refs and commits. The model only passes the answer on; the rules are enforced outside it.
- **Connectors.** A plain HTTP console, GitHub (webhooks or a GitHub App), and Feishu/Lark (long connection or webhooks, with approval cards).

## Documentation

| | |
|---|---|
| [Architecture](docs/architecture.md) | How the pieces fit and why |
| [Approvals](docs/approvals.md) | Who may approve what, and how that is enforced |
| [Connectors](docs/connectors.md) | Console, GitHub and Feishu: setup and behaviour |
| [Operations](docs/operations.md) | Deploying, configuration, the admin API, limits |
| [Status](docs/status.md) | What has been verified, and known limitations |

## Quick start

You need Node 22.12 or later, pnpm, and a Docker-compatible runtime (the sandbox image is built locally). On Apple silicon with Colima, enable Rosetta:

```bash
colima start --cpu 4 --memory 6 --vm-type vz --vz-rosetta
export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock
```

```bash
pnpm install
pnpm test                        # needs neither Docker nor keys
cp .dev.vars.example .dev.vars   # set OPENAI_API_KEY and ADMIN_KEY
pnpm dev --port 8797
```

In a second terminal, create a tenant and talk to the agent:

```bash
B=http://localhost:8797
ADMIN_KEY=...     # the value you put in .dev.vars

# Prints the tenant's API key ("api_key"). It is shown once.
curl -X POST $B/v1/admin/tenants -H "authorization: Bearer $ADMIN_KEY" \
  -H 'content-type: application/json' -d '{"id":"acme","name":"Acme"}'
TENANT_KEY=...    # the api_key from that response

curl -X POST $B/v1/console/users/alice/messages -H "authorization: Bearer $TENANT_KEY" \
  -H 'content-type: application/json' -d '{"text":"Remind me to drink water in 30 seconds"}'

# Long-poll for replies, including the reminder the agent sends on its own.
curl "$B/v1/console/users/alice/messages?after=0&wait=25" -H "authorization: Bearer $TENANT_KEY"

# Look inside that scope.
curl $B/v1/admin/scopes/acme:user:alice -H "authorization: Bearer $ADMIN_KEY"
```

To deploy, and to connect GitHub or Feishu, see [Operations](docs/operations.md) and [Connectors](docs/connectors.md).

## Repository layout

```
src/
  index.ts              ingress Worker: authentication and routing, no state
  events.ts             scopes, events and principals
  agent.config.ts       which connectors this deployment runs, and which are trusted
  registry.ts           tenants, keys, app registrations (one Durable Object)
  brain/                the Brain: one Durable Object per scope
    agent.ts              inbox, timers, the run loop, tasks, outbox
    schema.ts             tables and migrations
    tools.ts              what the model may call
    prompt.ts             the system prompt
  model/openai.ts       model client
  connectors/           one per outside system: verify, identify, deliver
    types.ts              what a connector is
    console.ts            HTTP channel for development and checks
    github.ts             GitHub webhooks and comments
    github-app.ts         tokens per installation and repository
    feishu.ts             Feishu events, cards and messages
    feishu-link.ts        Feishu long connection (one Durable Object per app)
    feishu-frame.ts       the long connection's frame format
  workers/sandbox/      the sandbox worker: one Durable Object and one container per task
    task.ts               container lifecycle, reports, approvals, checkpoints
    outbound.ts           the container's only way out
container/              scripts built into the sandbox image
test/                   tests, run inside the Workers runtime
docs/                   documentation
```

## Status

The agent runs on Cloudflare and has been exercised end to end against real GitHub and Feishu apps. It is young software: read [Status](docs/status.md) before relying on it, in particular the list of known limitations.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

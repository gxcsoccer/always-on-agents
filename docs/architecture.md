# Architecture

**English** | [简体中文](architecture.zh-CN.md)

## In one paragraph

Every scope (a user, a group chat, a repository) is one Durable Object called the Brain. Everything that happens is first written to its inbox and then handled in a short run. Anything slow is handed off, and the outcome comes back as another event in the inbox.

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
│ container + outbound proxy    │   │ console · GitHub ·  │
└───┬───────────────────────────┘   │ Feishu              │
    └─ taskEvent(): progress /      └────────────────────┘
       needs_input / result / failed / lost
```

## The five primitives

| Primitive | Where it lives | What matters about it |
|---|---|---|
| Event inbox | the Brain's `inbox` table | Deduplicated on `(source, source_id)`. A successful insert is the acknowledgement. Every activation checks that an alarm is set. |
| Timers | the `timers` table, on the object's single alarm | A due timer only inserts an event; it never runs the agent directly. Missed periods are not replayed. |
| Memory | the `memory` table, Markdown by path | `instructions.md` and `index.md` are loaded into every run. Memory never crosses scopes. |
| Permissions | see [Approvals](approvals.md) | Decided by code, not by the prompt. |
| Outbox | the `outbox` table | Delivered strictly in order, retried with back-off, one idempotency key per message. |

## Scopes and tenants

A scope is named `tenant:kind:id`, where kind is `user`, `chat` or `repo`. That name is the Durable Object's name, so each scope's data is physically separate.

- The ingress Worker works out the tenant from an API key, a GitHub installation or a Feishu app registration. A caller cannot name its own tenant.
- A task id can only be looked up in the database of the Brain that created it. Holding another scope's task id gets you nothing.
- Each scope and each tenant has a daily token budget. When it runs out, the scope pauses until the next day and loses no events.

Tenants, API keys and app registrations live in a single Durable Object, the Registry.

## A run

Runs happen only inside `alarm()`. An alarm never re-enters, so a scope has at most one run at a time.

1. **Claim.** Take the oldest pending event and, with it, the other pending events of the same conversation (bounded in number and size). Create the run and write the events into the transcript as one user message. All of this is one synchronous transaction.
2. **Loop.** If the transcript has tool calls without outputs, execute them and record the outputs. Otherwise call the model and append what it returns. State is on disk after every step.
3. **Finish.** Mark the events done and clear the active run.

**Crashes and deploys.** The transcript is the progress. Re-entering the same run re-executes any tool call that has no output, so every tool's side effect is keyed by the tool call id. A run that is entered five times without finishing is abandoned, and abandoning it does not depend on being able to tell anyone.

**Why not Cloudflare Workflows.** A Brain run is short; the slow work is dispatched. A Workflow would add a second copy of durable state that has to agree with the one in the Durable Object, and the guarantee of one run at a time would break exactly where the two meet.

## The sandbox worker

Each task gets one `TaskSandbox` Durable Object and one container. The container runs a coding agent ([pi](https://pi.dev)) in headless mode.

**No network and no credentials.** Every request the container makes goes through `Outbound` (`src/workers/sandbox/outbound.ts`):

- *Model API.* Only the configured model and the one endpoint are allowed. Request size and the number of calls per task are bounded. Only function tools that run inside the sandbox may be declared, the conversation items must be of kinds a local agent produces, and nothing may point the provider at a remote address to fetch. The Worker adds the key.
- *GitHub.* Only git's smart-HTTP endpoints. Reads pass through.
- *Everything else* gets a 403 and is recorded on the task.

**Pushes.** A task can push only to the repository it was started on. The proxy parses the push request into the refs that would move and the full commit ids; that list is what a person approves. Each held request has its own id and its answer can be collected once, by that request. The hold is limited on the Worker's side: when time runs out, or the holder goes quiet for a minute, the question is withdrawn and the Brain is told. See [Approvals](approvals.md).

**Credentials.** A GitHub token is lent only to a task started from that repository's own scope, or from a group chat that an operator has linked to that repository. With a GitHub App the token is issued per installation and for that one repository, and the result is checked. The credential for a push is fetched at the moment the push is sent, not before the wait for approval.

**Reports.** Progress, requests for approval, results, failures and loss are numbered and delivered to the Brain at least once; the Brain deduplicates by number. Process exit is reported by a wrapper script, not by the model.

**Losing the container.** The task directory is copied to R2 after progress reports and on alarms (at most every 30 seconds). If the container disappears, a new one is started, the copy is restored and the agent continues its session. Work done since the last checkpoint may be redone.

**Deploys.** When the Durable Object restarts it re-attaches the container's outbound route; without that the container could neither reach the model nor report.

**Limits.** Five minutes to start, fifteen idle, two hours in total, two recoveries, 400 model calls. At most three tasks per scope and five per tenant at once. A day after a task ends, its container, checkpoints and records are deleted.

What a worker says about itself is not trusted: it is a process in a container talking. Results reach the Brain marked as unverified.

## Connectors

A connector owns three things for one outside system: verifying an inbound request and turning it into an event, saying who caused it and whether they were addressing the agent, and delivering messages. The Brain never talks to an outside system directly. See [Connectors](connectors.md).

## Where to read the code

| To understand | Read |
|---|---|
| Events, scopes, principals | `src/events.ts` |
| The inbox, runs, tasks, the outbox | `src/brain/agent.ts` |
| What the model can do | `src/brain/tools.ts`, `src/brain/prompt.ts` |
| The approval rules | `#answerTask` and `readDecision` in `src/brain/agent.ts` |
| The sandbox's boundary | `src/workers/sandbox/outbound.ts` |
| A task's life | `src/workers/sandbox/task.ts` |
| How an outside system is connected | `src/connectors/` |

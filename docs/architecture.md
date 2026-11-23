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
│         · continuations · said                      │
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
| Memory | the `memory` table, Markdown by path | `instructions.md` and `index.md` are loaded into every run, the first 8,000 and 4,000 characters of each and no more. Memory never crosses scopes. |
| Permissions | see [Approvals](approvals.md) | Decided by code, not by the prompt. |
| Outbox | the `outbox` table | Delivered in order among the messages still to be delivered, retried with back-off, one idempotency key per message. A message that has left the queue (sent, given up, or not to be sent) does not hold the rest. |

Three things are built on these. The reasoning for each is in the [design](design/agent-core.md) and its [contract](design/agent-core-step0.md); what a connector has to do is in [Connectors](connectors.md).

**Requests that wait and are carried on.** A connector's tool can answer "not yet": something has to happen first that is not the agent's to do, such as a person authorising. The Brain keeps the request in the `continuations` table, with the call to make again as the tool itself put it and the person's own messages it rests on, and the run ends as usual. A report that the condition may hold, from the connector or from anything else, is only an event in the inbox and a reason to ask: the connector that owns the condition is asked afresh whether it holds and since when. If it held before the deadline, a run of its own makes that one call again and writes one answer. It has one hour. The same guard applies to any run that reads under a condition, carried on or not: before every model call after the read, and before every attempt to hand over a message the run wrote, the connector is asked whether the condition still holds. If it does not, what was read goes no further, and the person is told in fixed words that something written for them was not sent. A request can be called off or replaced by the person until its answer is first handed over; when more than one could be meant, the Brain itself asks which. A reply is about a request only if it replies to a message the tool said the request rests on, to the request's answer, or to its invitation. Approval questions are a different kind of wait and are kept as they were; an admin's view of a scope lists both in one shape.

**One way out to people.** Everything a person is shown goes through the outbox, including the invitation to do what a request waits for. The Brain holds a reference to the invitation and never its content: the connector makes the card and its link at the moment of sending. A message tied to a request goes out only while that request still stands, and never ahead of something the person has written that has not been handled. How a delivery ended is recorded as one of four things: sent, never handed over (`void`), refused by the outside system (`dead`), or possibly arrived and not checkable (`unverified`), in which case it is not sent again. Separately from messages, a connector can show on a person's own message that it has arrived.

**What a run read stays in that run.** From its first use of a connector's tool, a run can only reply to the person and read again. When the run ends, what it read, its tool calls and its reasoning are removed from the conversation's record and replaced by a fixed note. The note names what the turn read (by the tool's own call, such as the document's link) and nothing the model wrote. What the agent said to the person is kept apart from this. Each of its own messages delivered in a person's private conversation is kept in the `said` table, as it was delivered. When the transcript is put together, the words of a scrubbed turn follow its note, and a reply to one of them is shown after the words it replies to. The note tells the model to answer a follow-up from what it said, and to read the source again only if it needs more. Only a run that itself reads outside text is restricted; later runs that see this history are not. An earlier way to follow up, by keeping an answer apart for a day and reopening it with a tool, has been retired. This is step 2 of [follow-up history](design/follow-up-history.zh-CN.md) (in Chinese). It is merged and not deployed. Step 3 (links from the person's own messages of the last day; a reply to an answer reads only what that answer was written from) is built on a branch, not deployed.

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
| The inbox and the wake cycle | `src/brain/agent.ts` |
| A run: claiming events, calling the model, ending, retrying | `src/brain/runner.ts` |
| The Brain's other parts, each in a file of its own on the same database | `src/brain/store.ts` (the database), `outbox.ts`, `tasks.ts`, `timers.ts`, `revisions.ts` |
| Requests that wait | `src/brain/requests.ts` (a part of the Brain in a file of its own: same database, same transactions); `Waiting` and `holds` in `src/connectors/types.ts` |
| What the model can do | `src/brain/tools.ts` (what it is told), `src/brain/run-tools.ts` (what each tool does in a run), `src/brain/prompt.ts` |
| The approval rules | the judgement and the readers of a message (`decidingReply`, `readDecision`) in `src/brain/approval.ts`; what is looked up and done around it in `Tasks.answer` (`src/brain/tasks.ts`); replies that can change in `src/brain/revisions.ts` |
| The sandbox's boundary | `src/workers/sandbox/outbound.ts` |
| A task's life | `src/workers/sandbox/task.ts` |
| How an outside system is connected | `src/connectors/` |

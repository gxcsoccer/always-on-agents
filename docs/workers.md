# Workers

A worker is somewhere the agent can hand a piece of work to, that takes a while and gives a result back: the sandbox that runs a coding agent, for one. Workers are listed in `src/agent.config.ts`, beside the connectors. The Brain has none of its own.

```ts
const config = {
  connectors: [...],
  workers: [sandboxWorker],
  trusted: [...],
};
```

A worker is an object of the type in `src/workers/types.ts`:

| | |
|---|---|
| `name` | Short and lowercase. What a piece of work is recorded under. |
| `description` | For the model: what the worker is good at, and what it cannot do. |
| `acts_as` | `"agent"`, or `"person"` for one that does things in a person's own name. |
| `options` | Its own parameters, as JSON schema properties (the sandbox's `repository`). |
| `start(env, work)` | For a worker the Brain starts (one that acts as the agent). Starts a piece of work. `work.id` is the Brain's and is kept before the worker is asked: the same id again is the same piece of work. Resolve to `{ state: "started" }` or `{ state: "refused", error }`; throw when it is not known whether the work was taken. |
| `tool` | For a worker carried by a connector's tool (one that acts as a person): the tool's name. See below. |
| `cancel(env, id)` | Optional. Stops a piece of work, and says whether the work itself stopped (`"stopped"`) or only the waiting for it here (`"no_longer_waited_for"`). |

Taking a worker out of the list stops new work going to it, and nothing is written for work it is refused. Work it was given before (written down, even if not yet confirmed as started) is carried through: it can still be started under the same id, report, be answered and be stopped.

## The index of work

Every piece of work handed to a worker has one row in the Brain's `work` table, whichever worker it went to: under the id it has where it is carried out (a task's id; for a connector's tool marked `hands_to: "<worker>"`, the id of the request it keeps, or of the call where it never had to wait). A row is open until it ends, and ends once: `done`, `failed`, `cancelled`, `expired`, `void`, or `unknown` where it cannot be told whether the worker took it. That is the work's own outcome, as whoever carried it out says (such a tool says so with `context.work(...)`), not whether the person was told. It holds no result, and is kept as long as tasks and requests are. Nothing reads it yet: carrying work out and delivering its result are where they were.

## What the model sees

One set of tools, whichever worker the work goes to, made from the workers a run has. No worker's name or parameter is written in the Brain.

- `hand_over(worker, title, brief, continue_from, …)`: `worker` is one of the run's workers by name, each listed in the tool's description with what it is for. Each worker's own `options` are parameters of this tool, null for any other worker. `continue_from` is the id of an earlier piece of work this goes on with.
- `work_status(work_id)` and `cancel_work(work_id)`.

The run's instructions list the work handed over, each with its id and worker: what is under way and, for work done in the person's name, what was done in the last day (it can be gone on with) or could not be confirmed as taken. A piece of work done in a person's name is listed there and not among the requests that wait; it is shown to that person's own runs only, and no longer once the authorisation it was done under has been taken away or the set-up changed (whoever keeps the authorisation is asked). `work_status` tells how it stands (waiting for the person to authorise, waiting for the result, or how it ended) and nothing of what it brought back. `cancel_work` says whether the work itself was stopped or only the waiting for it here.

A run has a worker the Brain starts wherever it is listed, and a worker carried by a tool wherever the run has that tool (so the connector's `offers` decides for whom).

## Which worker for what

Each worker says what it is in its own `description`. How to choose between the workers of a deployment is said once, in words, in `src/workers.md`: it is put before the model as it is written, under "Where to hand work", wherever a run has a worker to hand work to. It is advice for the model's judgement and is not parsed or matched. It is the deployment's to write (change it and deploy); nobody in a conversation can change it.

## A worker carried by a connector's tool

A worker that does things in a person's name needs what a connector's tool already has: the person's authorisation, a request that waits and is carried on, a result that is checked against that authorisation before it goes anywhere. So such a worker names the tool that carries it (`tool`), and the tool names the worker (`hands_to`). The tool is no longer offered to the model under its own name; `hand_over` to the worker calls it with `{ brief, continue_from }`, and everything in [connectors.md](connectors.md) about tools holds for it.

The tool decides, from what the person themselves wrote, whether the work may be handed over at all and which earlier piece `continue_from` may name; the model's word alone is not enough. It says how the piece of work stands with `context.work(...)`.

The design, its steps and what is still to come (a sandbox that can go on with an earlier piece of work; nothing of any one worker left in the Brain) are in [design/workers.zh-CN.md](design/workers.zh-CN.md).

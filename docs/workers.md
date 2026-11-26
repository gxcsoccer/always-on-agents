# Workers

A worker is somewhere the agent can hand a piece of work to, that takes a while and gives a result back: the sandbox that runs a coding agent, for one. Workers are listed in `src/agent.config.ts`, beside the connectors. The Brain has none of its own.

```ts
const config = {
  connectors: [...],
  workers: [sandboxWorker],
  retired: [],
  first_worker: "sandbox",
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
| `accepts(options, scope)` | Optional. Looks at what it is asked to do before anything is written or started: its own options as the model gave them, and where it is asked from. Throws, in words for the model, for what it will not take. |
| `cancel(env, id)` | Optional. Stops a piece of work, and says whether the work itself stopped (`"stopped"`) or only the waiting for it here (`"no_longer_waited_for"`). The Brain takes only `"stopped"` as stopped. |
| `standing(env, id)` | Optional. Whether the worker ever took this piece of work: `"there"`, or `"none"`, and then it must never take it (a start under that id that arrives later is turned away). Asked when a start was not answered. |
| `answer(env, id, decision, reason, question, standing)` | Optional, for a worker that asks people to approve things: passes on a person's decision on one question. |
| `decisionOn(env, id, question)` | Optional. How one such question ended, by the worker's own record: asked when it is not known whether an answer arrived. |

A piece of work handed over carries, beside its id, brief and options: `accept_by` (the latest moment the worker may first take it) and `bounds` (how long it may run and how often it may ask the model, as the tenant's limits say). A worker that has such bounds of its own goes by these.

The Brain knows no worker by name. Which workers are offered, what options each has, whether those will do, how one is started, stopped, asked about and answered are all the worker's own, through this contract. What the Brain reads of a result or of a question a worker puts to people is in `src/workers/result.ts` and `src/workers/questions.ts`, which belong to no one worker.

Taking a worker out of `workers` stops new work going to it, and nothing is written for work it is refused. To have work it was given before (written down, even if not yet confirmed as started) carried through, move it to `retired` rather than deleting it: it can then still be started under the same id, report, be answered and be stopped. Take it out of `retired` once none of its work is left (nothing of its under way, and no approval question of its still to be looked up). Work whose worker is gone altogether still takes that worker's reports; it can no longer be asked about, answered or stopped from here, which is said as that and does not hold anything else up.

`first_worker` names the worker that the one tool for handing work over was for before there were several. A call of that tool made back then can still be made again after an interruption; it goes to that worker while it is offered, and is refused otherwise.

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

## Where several people talk

A worker that acts as a person can be used in a conversation several people share, if its tool says so (`shared: true`) and is offered for the message (the connector's `offers`). It then acts as the one person who asked, by the same test that decides whose tools a run carries anywhere.

- The way in (an authorisation card) goes to that person directly, never into the conversation. There is one for each piece of work, told apart by the call that asked for it, however alike the words. It says which piece it is for in the person's own words, that what comes of it will be said before everyone there, and that authorising also carries on whatever else of theirs waits for it. If it cannot be sent to them directly it is not sent at all. Once they are authorised through one, the others can no longer be gone through.
- The request waits in that conversation's own Brain. Whoever keeps the person's authorisation tells every conversation that has something of theirs under way when the authorisation changes or is taken away, each until it has heard.
- What the worker brings back is said in that conversation, before everyone.
- The piece of work is that person's there: only their own runs see it listed (and only on evidence that the conversation was told of it: the word that they were sent a way in, that it is under way, or its answer, was sent there and arrived), can ask how it stands, stop it or go on with it; and not from another conversation, their private one included.
- A run in which something was done in a person's name leaves nothing of itself in the conversation's record when it ends: it is cleared as a run that read outside text is, the system's word to a run that carried a request on included. What actually reached the conversation is put back from the record of what was sent, so the next person's run is given that and nothing else of it. That put-back is for every later run in that conversation, whoever it acts for or nobody (a timer, a worker's report): what was said there reached everyone there. A run that was given such work to read (its instructions listed it) writes nothing to the conversation's shared memory; a person whose work there is not listed is held to nothing by it.

This is separate from a connector's own tools being used there: for Feishu, reading a person's documents in a chat is still behind its own switch.

## A worker carried by a connector's tool

A worker that does things in a person's name needs what a connector's tool already has: the person's authorisation, a request that waits and is carried on, a result that is checked against that authorisation before it goes anywhere. So such a worker names the tool that carries it (`tool`), and the tool names the worker (`hands_to`). The tool is no longer offered to the model under its own name; `hand_over` to the worker calls it with `{ brief, continue_from }`, and everything in [connectors.md](connectors.md) about tools holds for it.

Whether to hand a piece of work over, to which worker, and which earlier piece it goes on with are the agent's to judge, by the deployment's guidance: neither the Brain nor the tool decides that. What code checks is not who the work goes to but whose it is: an earlier piece named in `continue_from` has to be the same person's own, handed to the same worker in the same conversation, and still standing under the authorisation it was done under (the Brain, from its index of work), and it has to be something that can in fact be gone on with where it is kept (the tool). If it is not, nothing is sent: it is not turned into something new, nor into another piece. The piece chosen stays with the call when it is made again or carried on. The tool says how the piece of work stands with `context.work(...)`.

A worker the Brain starts can say that it goes on from earlier work of its own (`goes_on`). The Brain then lets `continue_from` name a piece of that worker's work, and checks what is the same for every worker: it is in this conversation, it was asked for by the same one person, and it ended well. Such work is listed for that person, for about a day, as done and able to be gone on from. The new piece is a piece of its own (its own id, place, bounds and approvals); the worker is handed `work.continue_from` and refuses if what the earlier piece left can no longer be had.

`continue_from` may also name a piece of work that has not ended yet. The new piece is then written as `queued`: it has no place with the tenant and nothing is started. The Brain itself starts it (in `Tasks.settle`, not the model in a later step), from what the earlier piece left, once that has lastingly ended well; ended any other way, the waiting piece is not started and its person is told. It is one line: a piece of work has one waiting behind it, and the next goes behind that one. A waiting piece does not count towards the tasks at once (`scope_active_tasks`); at most five wait in a conversation. Its time to be taken by the worker, and its watchdog, run from when it was let through to be started. See [design/steer-and-follow-up.zh-CN.md](design/steer-and-follow-up.zh-CN.md).

The sandbox does this by keeping a copy of the workspace as it was when the agent finished well (for a day, with the task's other records) and starting the next task's container from that copy: the files, and the agent's own record of what it did, are there again; nothing approved then is approved now; it works where the earlier one worked, and another repository is other work. The earlier task is never started again or changed.

The design and its steps are in [design/workers.zh-CN.md](design/workers.zh-CN.md).

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
| `start(env, work)` | Starts a piece of work. `work.id` is the Brain's and is kept before the worker is asked: the same id again is the same piece of work. Resolve to `{ state: "started" }` or `{ state: "refused", error }`; throw when it is not known whether the work was taken. |
| `cancel(env, id)` | Optional. Stops a piece of work, and says whether the work itself stopped (`"stopped"`) or only the waiting for it here (`"no_longer_waited_for"`). |

Taking a worker out of the list stops new work going to it. Work it was given before can still report, be answered and be stopped.

This is the part of the design that is built so far. What is to come, and in which steps, is in [design/workers.zh-CN.md](design/workers.zh-CN.md): work done in a person's name, one record of work, and one set of tools for the model whichever worker it hands to.

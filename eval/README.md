# Checking the agent's judgement against the real model

`eval/cases.ts` holds conversations as the Brain would put them to the model, each with a rule for what the model's first step should be: hand the work to which worker, go on with which earlier piece, answer itself, ask. It uses the real instructions (`src/brain/prompt.ts`), the real tools and the deployment's guidance (`src/workers.md`), so a change to any of these can be tried before it is deployed.

It is not part of the tests: it calls the model, costs tokens, and the model's answers vary from run to run.

```bash
# The key is read from the environment. With a git-ignored .env in the repository root:
set -a && . ./.env && set +a
pnpm run eval          # every case, twice each
pnpm run eval 4        # every case, four times each
ONLY=G1 pnpm run eval  # one case, by the id its name begins with
```

`OPENAI_BASE_URL` and `BRAIN_MODEL` say where the model is and which one, as they do for the deployment; without them it asks `https://api.openai.com/v1` for `gpt-6-sol` (the model named in `wrangler.jsonc` when this was written: if that changes, change it here too, or set `BRAIN_MODEL`).

A number that is not one, or an `ONLY` that matches no case, is an error: nothing is run and nothing is called a pass. The last line says how many cases and runs there were.

It bundles with the bundler the test runner brings (`vitest` → `vite` → `esbuild`). Should a later version of those no longer bring it, add `esbuild` as a development dependency. And the cases are not type-checked by `pnpm check`: a change to what they import from `src/` shows only when this is next run.

Reading the result: each case prints one line per run, `ok` with what the model did or `FAIL` with why, and the last line says how many cases and runs there were and how many were not as wanted. It exits with 1 if any was not. A case that fails once in several runs is a judgement that is not settled, not necessarily a mistake in the change; read what the model did.

What a case's rule does and does not show is in the rule itself: most look only at the first hand-over (which worker, which earlier piece, what the brief leaves out), some at whether a message was sent and with which words. A rule that passes when nothing is handed over does not show that the right thing was said.

Everything in the conversations is made up.

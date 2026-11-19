# Contributing

**English** | [简体中文](CONTRIBUTING.zh-CN.md)

Thank you for considering a contribution. This project is small and its most important property is that the rules about who may approve what cannot be talked around. Changes are welcome; changes that touch those rules get the closest reading.

## Getting set up

```bash
pnpm install
pnpm check        # typecheck, then the whole suite
```

The suite runs inside the Workers runtime with the model and the sandbox container replaced by stand-ins, so it needs no Docker, keys or network. To run the agent locally you also need a Docker-compatible runtime and a model API key; see the [README](README.md).

## Before you open a pull request

- `pnpm check` passes, and exits with status 0. A run in which every test passes can still fail (an unhandled error does that); look at the exit status, not only the count.
- New behaviour has a test. For anything that decides whether an action is allowed, test the refusals as well as the approvals.
- The documentation says what the code now does. English and Chinese versions are kept side by side (`*.md` and `*.zh-CN.md`); please update both, or say in the pull request which one you could not.

## How the code is written

- **Comments say why, not what.** Most functions here carry a sentence about the decision behind them. Keep that up, especially where the reason is a failure someone once observed.
- **Authorization is decided by code, on the principal of an event, never on message text and never by the model.** If a change makes a decision depend on what a message says, it should read that from the person's own message (see `readDecision`), and fail closed when unsure.
- **Nothing is trusted because of where it claims to come from.** A connector verifies a request before believing any field in it. What a sandboxed worker says about itself is information, not fact.
- **Every side effect of a tool is idempotent**, keyed by the tool call id, because a run can be re-entered after a crash.
- **Logs and status carry fixed words and numbers**, not text that came from outside.
- No new runtime dependencies without a reason given in the pull request.

## Things that only show against real services

Tests replace the network. Some faults have appeared only on a deployment, for example an option the Workers `fetch` does not accept, or a WebSocket frame arriving in a different form. If your change touches a connector, the outbound proxy or the sandbox, say in the pull request whether you were able to try it against the real thing.

## Reporting bugs and proposing changes

Open an issue. For a bug, the most useful report says what you did, what you expected and what happened, with the scope's state from `GET /v1/admin/scopes/:scope` if you have it (check it for anything private first).

Security problems should not go in a public issue; see [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).

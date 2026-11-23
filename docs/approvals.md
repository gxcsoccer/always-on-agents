# Approvals

**English** | [简体中文](approvals.zh-CN.md)

Some things an agent does should not happen until a person says so. This document describes what is held for approval, who may approve it, and where each rule is enforced. The short version: **the model carries the answer; code decides whether it counts.**

## What is held

Only what leaves the sandbox. Today that is `git push`.

- A push is held by the outbound proxy, which sees the real request. It is judged by what the request would do (which refs move to which commits), not by what the command looked like, so rewording a command changes nothing.
- Commands that stay inside the sandbox are not held by default: nothing they do outlives the sandbox. A deployment that wants a person asked about some local commands anyway can set `GATE_HOLD_PATTERN` (a regular expression over shell commands). That check matches command text and only guards against accidents.

## How a question is asked and answered

1. The worker is stopped and reports a question. The question's id is made on the Worker's side; nothing the container supplies is used as an id.
2. **The Brain itself** puts the question to the conversation the task belongs to. It shows exactly what would happen, literally (no Markdown rendering), with a four-character code that belongs to this one question. A code is never given to two questions in the same scope.
3. Someone answers. The model calls `answer_task` with what it thinks they decided.
4. Code reads the person's own message and checks every rule below. Only then is the decision passed to the worker.

In Feishu the question is a card with buttons. Pressing a button is the same as that person saying "approve CODE" or "deny CODE"; who pressed it comes from Feishu, not from the card.

## The rules

### What counts as an approval

| Rule | Enforced in |
|---|---|
| An approval is a message sent **after the question was actually delivered**, and it is the whole message: `approve CODE` (or `同意` / `批准` with the code). Anything more is not an approval, so "do not approve CODE" is not one. | `Tasks.answer`, `readDecision` |
| The decision is read from the message itself, never from the model's account of it. | `readDecision` |
| A message tied to one question (a press on its card, or a Feishu reply to the question's own message outside a topic) need not repeat the code: a bare yes word is enough. The same words anywhere else answer nothing. | `readTiedDecision`, `ingest` |
| If the action is too long to show in full, it can be refused but not approved. | `Tasks.event`, `Tasks.answer` |
| One message approves one question. A question gets one decision; a retry re-sends that decision and cannot make a new one. | `Tasks.answer` |

### Refusing

| Rule | Enforced in |
|---|---|
| A refusal also has to be said: `deny CODE`, or any refusing word next to the code. An unrelated message is not a refusal. | `readDecision` |
| A refusal from **any** member wins over an approval, whichever came first, including one still waiting in the inbox. | `Tasks.answer` |
| A refusal that arrives after the worker already acted on an approval is reported as too late, and the approval stays attributed to whoever gave it. | `Tasks.answer`, `TaskSandbox.answer` |

### Who may approve

| Rule | Enforced in |
|---|---|
| The message must come from a member of the scope who was addressing the agent, through a connector the deployment trusts to say who is speaking (`trusted` in `src/agent.config.ts`). What any other connector reports decides nothing. | `#isDecider` |
| In a group chat or a repository, only the person who requested the task may approve it. | `Tasks.answer` |
| If several people asked in the same batch, the task has no requester, and nobody can approve. | `Tasks.dispatch` |
| In a group chat or a repository, a task not started by a person (one dispatched after a CI failure, say) cannot be approved, only refused. In a direct chat, where there is one member, that member may approve a task the agent started on its own (after a timer, say). | `Tasks.answer` |
| If the question could not be delivered to anyone, it cannot be approved. | `Tasks.event`, `Tasks.answer` |
| In a repository, a GitHub account that is not linked to a tenant user is not a member. Only comments from an owner, member or collaborator are requests to the agent at all. | `#isDecider`, `connectors/github.ts` |
| In a Feishu group, only messages that mention this bot count, and the sender must belong to the organisation the app is installed in. | `connectors/feishu.ts` |
| Automatic events (a pull request opening, CI failing) are nobody's request and nobody's consent. | connectors set `explicit: false` |

### Changing one's mind

| Rule | Enforced in |
|---|---|
| The approval must be that person's last word. If they said anything after it, they have to confirm again. "Last" goes by when a thing was said where the source tells us, so a "wait" that arrives before the older approval still counts as after it. This holds across runs. | `Tasks.answer`, `saidAt` |
| Two things said by the approver in the same instant (as far as the source can tell) need a fresh confirmation. | `Tasks.answer` |

### Where an answer may be given

| Rule | Enforced in |
|---|---|
| An answer belongs to the conversation the question was asked in. On GitHub that is the same pull request. | `Tasks.answer`, `Tasks.quotesOpenQuestion` |
| Within one Feishu chat, a reply that names an open question's code is taken to that question wherever it was typed; what the same person says next in the place they typed it still counts as their later word. | `ingest` (`route_by_code`), `Revisions.saidSinceWhereTyped` |

### Sources that can change after the fact

GitHub comments can be edited and deleted.

| Rule | Enforced in |
|---|---|
| An approval counts only while the comment it was read from still says the same thing. Each comment's standing is its timestamp plus a fingerprint of its text; an edit or deletion voids the earlier text in whatever order the notifications arrive. | `Revisions.revise`, `Revisions.standing` |
| Before an approval is acted on, the comment is read again from GitHub, because the notification of a change may still be on its way. If GitHub cannot be asked, nothing is approved. The same holds for any connector whose messages can change: if it cannot be asked what a member's message says now, or does not recognise the message, nothing is approved on that message. | `Revisions.refreshStanding`, the connector's `standing` |
| The question the agent posted is checked too: a maintainer can edit other people's comments. A question that was ever edited, even if put back, cannot be approved, only refused. To go ahead, refuse it (or cancel the task) and make the request again, which produces a new question. | `Tasks.answer` |
| A mention inside a quotation or code does not address the agent. | `ownWords` in `connectors/github.ts` |

### Approving for the rest of a task

An approver can approve a push **and later pushes of the same branches in the same task**.

| Rule | Enforced in |
|---|---|
| It has to be said by the approver, in their own message (`approve all CODE`) or with the card's button. The model cannot add it. | `wantsStanding`, `Tasks.answer` |
| It is offered, recorded and used only for pushes that update or create branches. A push that includes a tag or a deletion is approved once, whatever was pressed. | `standingEligible` |
| It covers the same repository and the same branches, in that task only. It does cover a later push that rewrites the branch's history; the card says so before it is given. | `TaskSandbox.authorize` |

### How a question ends

| Rule | Enforced in |
|---|---|
| A question ends once: approved, refused, withdrawn, or outcome unknown. That ending is recorded with the question and does not change. | `Tasks.#closeQuestion` |
| A question that stops being waited on (a newer one took its place, or the task ended or was cancelled) is withdrawn if no answer was ever sent for it. If one was sent and never confirmed, the worker is asked what it recorded, and the question ends as that. | `Tasks.#setAside`, `Tasks.settle`, `TaskSandbox.decisionOn` |
| If that can no longer be found out (the task's records are gone, or the worker stays unreachable), the question ends as **outcome unknown** and `task.answer_unverified` is written to the audit table. It is never shown as withdrawn on a guess. | `Tasks.settle` |
| Whether an approval covers the rest of the task is what the worker recorded with the decision, not what the latest message asked for. | `TaskSandbox.answer`, `Tasks.answer` |

Showing the ending where the question was put (rewriting a Feishu card) is best effort: it can fail or be repeated, and nothing depends on it. The record is the ending.

### Other protections

| Rule | Enforced in |
|---|---|
| `instructions.md` (the agent's standing instructions) can be changed only in a run started entirely by members' messages, and not by a message admitted only as a reply to a question. | `#instructionEditors` |
| The agent's own GitHub comments carry a marker and are never read back as anyone's words. | `connectors/github.ts` |
| A held push's answer is for that one request and can be used once. The credential for the push is fetched when it is sent, so access withdrawn during the wait stops it. | `outbound.ts`, `TaskSandbox.authorize` |

Text from the system and from workers is information, not instruction. The prompt tells the model so, but none of the rules above depend on the model listening.

## Audit

Every dispatch, approval, refusal, cancellation and change to standing instructions is written to the scope's `audit` table. An approval's record holds the question as it was put and the message that answered it.

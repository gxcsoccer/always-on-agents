# Status

**English** | [简体中文](status.zh-CN.md)

This is young software. It runs on Cloudflare and has been exercised against real services, and it has a list of things it does not do well. Both are below, so you can judge whether it fits your use.

## What has been verified

### Automated tests

`pnpm test` runs the suite inside the Workers runtime, with the model and the sandbox container replaced by stand-ins. It needs no Docker, keys or network. It covers:

- the inbox (de-duplication, batching), conversation isolation, idempotent tools, abandoned runs, the transcript window, budget pauses, timers and memory rules;
- every approval rule in [Approvals](approvals.md), task reports, audit and housekeeping, including migrations of an existing store;
- every allow and deny rule of the outbound proxy, and parsing of push requests (including the real format from a shallow clone);
- GitHub signature checks and normalisation, the GitHub App token flow, and Feishu decryption, signatures, cards and normalisation;
- the webhook handlers end to end with real encryption and signatures;
- the Feishu long connection against a stand-in that lives in its own Durable Object: connect, ping, an event and its acknowledgement, a card press and its answer, a message in several frames, refusals and back-off;
- the task object's own bookkeeping for held questions and standing approvals;
- reading a Feishu document as a person, against a stand-in for Feishu: the invitation, the consent coming back, another account or organisation completing it, a link used twice, declined, forged or too old, an authorisation taken away while one is on its way back, a document the person may not open, a token Feishu stopped honouring, a document that tells the agent to read another, an authorisation taken away or replaced while a read is under way, an invitation Feishu did not take at first, and a person who had allowed the app more, or less, than reading needs.

### On Cloudflare, by hand

- Conversation and memory, proactive reminders from timers, isolation between tenants and between chats.
- Dispatching sandbox tasks, a 13-minute task, a redeploy while a task runs, automatic recovery after the container is destroyed, upgrading a scope that holds older data.
- **GitHub**, with a private repository and a real GitHub App installed on it: a comment dispatches a task, the task clones with a token issued for that installation and repository, the push is held, an approval comment releases it, the branch moves to the approved commit, and the result is posted as the App's bot. Also: an approval comment deleted straight away does not approve; an edited question cannot be approved; one task making two pushes asks once after "approve all".
- **Feishu**, with a real custom app: direct chat, group chat with a mention, approval cards with buttons, and a push approved from a group linked to a repository. This was done over both transports; over the long connection the message, the card and the button press all arrived on the connection.
- **After the connector interface change**: an existing chat scope opened after migrations 12 and 13 with its history intact, a sandbox task ran in the rebuilt image, a push from a Feishu group was approved on its card and the card showed Approved, and a mention on GitHub was answered. Not exercised by hand: a question set aside while its answer was unconfirmed, and the "outcome unknown" ending; those are covered by automated tests only.

### Built, on a branch, not yet deployed

Requests that wait and are carried on, the checks before anything read goes further, the four delivery outcomes, the sign that a message arrived, follow-ups to a delivered answer (off unless an operator sets `FOLLOW_UPS=on`), and the limits on what memory is loaded are written and are on the branch `step1-wait-resume`, awaiting review. They are described in [Connectors](connectors.md), [Operations](operations.md) and [Architecture](architecture.md) as the code on that branch behaves. What can and cannot be said for them:

- **None of it has been run against real Feishu, and none of it has been deployed.** That includes the reaction on a person's message (and whether the app permission named in the setup steps is the right one), an invitation card sent through the Brain's outbox, a request carried on after a real consent, and migrations 19 to 21 on a scope that holds real data.
- **The tests were rewritten for it while this was being written**, and nothing is claimed here about their result. They run against a stand-in for Feishu and a scripted model, with follow-ups switched on, and are meant to cover: one answer after the person authorises and says nothing more, with no link in anything the Brain holds; a replayed call getting the same "waiting" answer; a report that is repeated, late, or owed after a failure; asking again when the person writes about anything; something else asked and answered while a request waits; a request called off before or after authorising, or while its answer is waiting behind the person's own message; two requests sharing one card, the question that asks which is meant, and the one message that may answer it; a request replaced by another in one step; an authorisation taken away while a request waits, as it is taken up, before the text reaches the model, and before the answer is sent; a wait that runs out, and an authorisation that comes too late, judged by when each permission was given; a tool that says "wait" a second time; an interrupted run neither sending its answer early nor losing it; the day's budget running out in the middle; and an answer not kept past its hour.
- **Follow-ups, where they are turned on, rest partly on the model.** Code bounds which answer can be meant and reads the source again as the person before anything comes back. Whether a sentence is a follow-up at all is the model's judgement, a decision recorded in the [contract](design/agent-core-step0.md) (5.3). The cases that should not lead to a re-read (asking about something else, "don't read it again") have not been measured on a real model.
- **A wait that runs out ends without a word.** A person who authorises after the invitation's ten minutes gets no answer and no message from the agent; the page they land on tells them to ask again if nothing arrives.

### Not covered by automated tests

The sandbox with a real container (it cannot run inside the test runtime, so it is verified by hand on a deployment), the alarm's self-healing, and task clean-up.

## Known limitations

Roughly in order of importance.

1. **Feishu over the webhook transport loses card presses now and then.** Feishu's servers do not reach Cloudflare reliably: a press was seen to time out, and another never arrived. Use the long connection. The long connection has its own costs: one Durable Object awake per app, a reconnect on every deploy, and it must be the app's only long-connection client.
2. **A closed approval card can keep its buttons.** If a question's delivery receipt was lost, the agent sends it again under the same id to find it and close it. Feishu documents de-duplication, not the return of the original message id; without it the card stays as it was. Pressing it approves nothing.
3. **Whether a GitHub comment addresses the agent is decided by a simplified reading of Markdown**, not a full parser. Taking prose for code only means the mention has to be made again; the known cases of the opposite are closed, but the list is not proven complete.
4. **Fixed text is not localised.** The Feishu card is Chinese only; the question as posted on GitHub and the console is English only.
5. **Token usage inside the sandbox is reported by the container.** The number of model calls is counted and capped by the proxy, but token counts come from the tail of the agent's log, so they are under-counted for very long logs and for tasks that are lost or cancelled. Because that usage is booked when a task ends, a tenant can overshoot its daily budget somewhat.
6. **Pushes are not checked for push options or capabilities, and branches are not restricted.** The approver sees the refs and commits, and the decision is theirs. "Approve for this task" covers later pushes that rewrite an approved branch.
7. **Commands inside the sandbox are not reviewed** unless `GATE_HOLD_PATTERN` is set, and that check is a regular expression over command text.
8. **Observability is logs and per-scope health figures.** There is no alerting.
9. **Long conversations are truncated**, not summarised, and memory is not tidied offline.
10. **The admin API has one key**, with no roles and no per-tenant administration.
11. **Feishu app secrets and per-repository webhook secrets are stored as they are in the Registry Durable Object**, relying on the platform's encryption at rest. (Tenant API keys are not: only their hashes are kept.)
12. **All tenants share one model key, and the sandboxed agent only talks to OpenAI's API.** `OPENAI_BASE_URL` redirects the Brain but not the agent in the sandbox.
13. **The sandbox task's state is read and written as a whole.** The known overwrites are handled; it has not been systematically changed to per-field updates.
14. **The sandbox cannot download packages from registries** such as npm or PyPI. Tests can use tools and dependencies already in the image or supplied with the project. A test that still needs a registry download cannot run as configured.
15. **Reading Feishu documents is only partly exercised against Feishu itself.** Seen working there: the invitation card, consent, and the browser coming back. The token exchange at Feishu's current endpoint was refused for a correctly formed PKCE verifier (20049); the per-app switch to the older endpoint exists for that, and whether Feishu checks the verifier there is not established. Reading a document through the per-app switch has been seen to work there once. Renewing an authorisation (`offline_access`) has only been run against a stand-in. Only documents (docx) and wiki pages that are documents can be read, as plain text, up to 40,000 characters. Carrying a request on after the person authorises, and everything else listed under "Built, on a branch, not yet deployed", has not been exercised there at all.
16. **Other worker types are not implemented.** Notes on one that was researched are in [docs/research](research/).

## Reporting problems

Open an issue for bugs and gaps. For anything that affects security, see [SECURITY.md](../SECURITY.md).

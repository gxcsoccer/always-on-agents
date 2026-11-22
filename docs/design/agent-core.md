# Design: finishing the job, following the conversation, responding

**English** | [简体中文](agent-core.zh-CN.md)

Status: fourth version (the lean version), finalised on 2026-11-22. Apart from the prompt (PR #13, already live), no code has been changed to follow this document yet. The next step is step 0 in section 10.

This document answers one question: how to make the agent behave more like an assistant in conversation, without writing special cases for any one connector or any one tool. It describes five general mechanisms, what they change in the existing code, and the steps to build them in, with how each step is verified.

How to read it: sections 1 and 2, plus the "in one sentence" line and the example at the start of each mechanism, are enough to understand what is to be done. The rest is detail for implementation and review.

## 1. Why

On 2026-11-21 the "read a document" feature was used in real Feishu for the first time. The record showed four problems:

| What happened | Direct cause |
|---|---|
| After pressing authorise, the user had to say something more before it did the work | The authorisation callback only saves the token. The original run has already ended, and nobody carries on |
| The same document is summarised from scratch every time, with no memory of what was just said. From this we infer that a follow-up such as "expand on the second point" cannot be picked up (inferred from the code, not actually tried in chat; it is a case to be verified at acceptance) | In a run that read outside content, everything in the record except the user's own words is replaced with one fixed sentence when the run ends |
| After sending a message, the user waits 5 to 14 seconds with nothing to see; three messages appear at once during authorisation | Nothing says "received"; the connector sends the card itself, and the model then says it again in its own words |
| It talks like a ticketing system: it tells the user to "send the link and the summary request together again" (the problem of the link and the request arriving in two messages has since been fixed once, in PR #8) | The prompt was written for "a background agent woken by events"; the tool's limits are relayed to the user as they are |

Each problem can be fixed on its own terms, but every such fix would have to be written again for the next connector (mail, calendar). So only general mechanisms are built here. "Reading a Feishu document" is their first user. The existing "push approval" and "worker task" are the second.

## 2. Principles

1. **The mechanism is general; each party proves its own part.** There is only one lifecycle (wait, resume, cancel, expire). "Whether the condition holds" is proved by the party entitled to prove it, and none stands in for another. A clock can only prove that the time has come, a worker can only report on the task it was given, and only a person can approve a push.
2. **The model decides how to do it; the runtime decides whether it may be done.** Whether to ask a follow-up question, which capability to use, whether something is worth remembering: these are left to the model. What can be read, where it can be written, who it is sent to and how long it is kept are enforced by code.
3. **Permission follows "what is to be done this time", not "what has appeared in the history".** When the user says "don't read B, just summarise A", both A and B were pasted by the user's own hand.
4. **Provenance is propagated by the runtime; the model cannot clear itself.** Rewriting, summarising and compacting do not make outside content more trustworthy. Nor can the model launder a plan it produced earlier while restricted by "choosing its context".
5. **Approval does not change data policy.** An approval can only release one specific action that has been seen clearly and frozen. It cannot release a data flow that policy forbids in the first place.
6. **One voice towards people.** Every message sent to a person goes through the same way out. A status notice may be lost; a result may not.
7. **Lean.** The acceptance criteria are not lowered, and the implementation is kept as small as possible: no tables, no components and no model calls are added for needs that have not appeared yet. Section 13 lists what is deliberately not done.
8. **Every step keeps production usable**, is verified with at least two kinds of real task, and weakens none of the guarantees of the existing approvals.

## 3. The structure today

One scope (one person, one group or one repository) is one Brain object. Inside it are:

- `inbox`: every event that comes in.
- `runs`: a run, that is, one round of "the model thinks, calls tools, thinks again".
- `items`: the conversation record, which is also the model's input.
- `outbox`: messages to be sent. What it holds is the intent to send, and it handles retries and de-duplication. Whether the person ends up seeing a message only once depends on whether each channel can give a receipt, and whether it can de-duplicate or reconcile.
- Three kinds of "wait a moment", each with its own implementation:
  - waiting for a worker: `tasks` and `task_events`; a worker's report becomes an event;
  - waiting for a person to approve: the question on the task, the `unsettled` table, the approval card; the rules are in [Approvals](../approvals.md);
  - waiting for a time: `timers`; when the time comes it becomes an event.

"Waiting for the user to authorise" is a fourth kind, and it is not implemented today.

Note that a piece of work is not always started by a person. A timer can start a task, whose push is later approved by the person themselves in a direct chat. In a group with no single requester it cannot be approved. A task that started automatically carries nobody's tool permissions. The new design must keep these distinctions.

## 4. Mechanism one: a request can wait, and carries on once the condition holds

**In one sentence**: separate "a thing to be done" from "a run". The thing can stop and wait for a condition, and once the condition holds the appropriate party carries on.

**Example**: you send "summarise this document", and authorisation is needed. The request stops and waits for the condition "you have authorised the Feishu connector". After you authorise, the Feishu connector confirms that the condition holds, the document is read, and the summary is sent to you. You do not need to say anything more.

### 4.1 Four states to keep apart

Between waiting and done, a piece of work passes through four states, and the process can crash between any two adjacent ones:

1. **The condition can be checked**: someone reports "you can go and check now".
2. **Permission holds**: the condition's owner verifies it independently and confirms that it holds.
3. **The effect has happened**: the action was carried out (the document was read, the push was released).
4. **The result was delivered**: the channel confirms delivery.

A report (step 1) is never the same as permission (step 2). Before starting again an action that could produce a second effect, reconcile first.

### 4.2 How it is done: the old run ends normally, and once the condition holds one narrow continuation run is started

No new pair of tables for "requests" and "waits" is created, and no run is left hanging while it waits for a person.

1. The tool answers "a wait is needed". The run records this as an ordinary tool result with no sensitive content, and at the same time stores a small **continuation record**. Only after both have been written may the invitation be sent and the run end. After that, even if the record of this run is cleared under the existing rules, the continuation record can still be found.
2. Nothing is held while waiting. You go on chatting about other things as usual, and the agent goes on answering as usual.
3. When the condition holds, the party that can prove the condition sends a notification. The notification only serves to "wake" the request.
4. After the wake-up a new run is started (with its own id). It does only two things: carry out the one action bound in the continuation record, and send the result as an answer to the original person.
5. Before carrying it out, check again: it has not been cancelled, access has not been withdrawn, it has not expired, and the reply target has not changed. This person's permission is also recomputed from the saved original messages. If the original basis can no longer be found, stop.

What a **continuation record** holds: the id of the original tool call; references to the first few user messages, and the object they point to (where the link and the request were said in two sentences, it records which sentence the link came from); the normalised action and object; the original reply target; the revision of the request; which party can prove which generation of the condition; the deadline; the state.

A few details, to avoid confusion caused by "the same call id":

- The original call id is only a stable key that the tool's side uses for retries and correlation. It is bound to the revision of the request and the generation of the condition.
- A second result is not appended, in the shared conversation record, to the old call that already has a "waiting" result. Nor is it changed which run the original messages belong to.
- The de-duplication key of the final answer is bound to this logical request and its revision. It does not follow the new call id generated when the model retries. After repeated notifications and after a restart, there is still only one answer.
- A lost notification can be reconciled: the continuation record is the source of truth.

### 4.3 What ends a wait

- You say explicitly "never mind", or explicitly change the target ("use the other document instead");
- the system finds that it has expired, or the authorisation is taken away;
- the condition holds and the continuation completes.

Asking about something else in passing ("what's the weather like today") does **not** end the wait: the weather is answered as usual, and the original thing goes on waiting. Saying "I've authorised it" prompts the system to check the condition once. All of these are ordinary messages, understood by the model. Cancelling and changing the target are proposed by the model and carried out after the runtime has checked them. When there are two possible objects, the model asks you. The runtime does not guess.

### 4.4 Who proves, and who carries out

The runtime only coordinates. The party that does the work differs from case to case:

| Case | Who proves the condition | Who does what in the continuation | When the outcome is unknown |
|---|---|---|---|
| Reading a document after waiting for the user to authorise | The connector, verified against the invitation and the generation of the authorisation | The original connector checks permission again and reads again. A read is safe to retry | Read again |
| Waiting for a person to approve a push | A person entitled to, by the rules in section 4.5 | Only hand the decision back to the original task and question; the outbound proxy, which holds the real request, releases it | Ask the worker which decision it recorded; if that cannot be found out, record it as unknown and audit it |
| Waiting for a worker to finish | The worker of that task | Only consume the matching final report; do not reopen the work | The existing "task lost" handling |
| Waiting for a time | The clock | Produce an event that carries nobody's permissions | The existing handling |

The last three rows are the existing implementation and are **not changed this time**. They serve only to test whether the approach above really is general (see section 4.5). A notification must authenticate the caller's identity and be rate limited. It is de-duplicated by the revision of the request, the generation of the condition, the tenant/task/invitation the sender is bound to, and the id of the source event. Who a notification claims to be from counts for nothing.

### 4.5 Existing approvals: kept as they are

The tables of constraints in [Approvals](../approvals.md) are a normative dependency of this design. The rules are not rewritten here. They include:

- The question must actually be delivered and be readable in full, and is bound by the original question and its receipt. Merely "queued" does not count.
- Only a person on a trusted channel, in the right conversation, can approve. In a group or a repository it must be the single original requester (in a direct chat the person themselves may approve a task started by a timer, see section 3). A refusal from any entitled member wins, including a refusal still in the queue. What the same person says afterwards in the place they typed it affects an approval not yet carried out. One reply approves one question.
- Before approving, look again at answers and questions that can be edited: if the answer was changed, the old version is void; if the question was edited, even if put back, it can only be refused; if it cannot be looked up, nothing is approved.
- A single approval and an approval for the rest of the task are accounted for separately. The latter covers only this task and the branches already approved in this repository (one push can contain several branches, and each must be among them). Tags and branch deletions cannot get a standing permission.
- First save the intent to answer, bound to the original question, and only then hand it to the worker. When delivery is uncertain, ask the worker, and conclude "decided", "confirmed not decided" and "cannot be found out" separately. Unknown is audited, and the conclusion is written only once. What the worker reports is which decision it recorded. It does not mean the remote push succeeded.

**The first step does not touch the storage of approvals**: `tasks.pending`, `tasks.answering` (the intent to answer, bound to the original question, saved before the worker is called), `task_events`, `unsettled` and the worker's decision record remain the source of truth. Approving, refusing, saving the decision and reconciling with the worker still have only the original write paths. The new mechanism **observes** their lifecycle through a common interface, and tests can drive the real approval entry points. No second approval state machine is built, nothing is written twice, and a wait flag does not replace `tasks.answering`.

## 5. Mechanism two: content that is read in is restricted, and an answer can be followed up

**In one sentence**: a generation that has read outside content is marked "restricted" by the runtime, and it can only read and reply to the person themselves. An answer that was sent leaves a record with a deadline, which is used for a follow-up after permission has been checked. These two things replace today's rule of "delete everything once anything was read".

**Example**: it sent you a summary. You reply to that summary with "what is the second point based on?". The runtime confirms which answer you mean and whether you still have the right to read that document now, then reads the relevant passage again and answers you. Later you ask about something unrelated. That summary is not in the context, and the agent is not restricted.

### 5.1 Today's rule and its cost

Today's rule (PR #5): once a run has used a connector's tool, from then on it can only "reply to this person" and "read again". When the run ends, the record other than the user's own words is replaced with one sentence. Messages waiting to be sent have a separate rule that clears them after delivery. This blocks malicious instructions inside a document, at the cost that the agent cannot remember what it has just said. Later, to make "send the link first, then say summarise" work, "carry over the previous link, once only, within 10 minutes" was added (PR #8). Both are special cases.

### 5.2 One "restricted" mark

The first version does not build a provenance graph for each piece of content. It uses a single conservative mark, propagated by the runtime: **restricted**.

- Once a model generation has seen outside content, everything it produces is restricted: replies, tool arguments, summaries, compacted content, and the output after a retry or a continuation.
- Content of unknown provenance, and old data with no mark, are treated as restricted.
- The model cannot remove this mark.
- A piece of text does not become the user's instruction because it is wrapped in a "user message": a forwarded message, a quoted email, a worker's report and a tool's output all keep the identity they had.

### 5.3 What a restricted run can do

Only two things: the one read bound to the current request, and replying to the original person.

Long-term memory, timers, sending to someone else and handing over to a worker: these ways out are handled by fixed data rules. They do not depend on the model's judgement, and they are not opened because something "can be taken back later". **Approval does not change the data rules**: a flow the rules do not allow cannot be opened by an approval either. A specific action that the rules allow but that needs a person's agreement is handled the way existing approvals are: first freeze the action and show it to the person so that they can see it clearly (who executes, which repository and branch, which content is handed over, with the actual content visible, whether it is a change inside the sandbox or a push to the outside, the time limit and the number of times). The approval is valid for this one version only, and everything is checked again at execution. If the material or the destination is changed, it must be approved separately. The approval card itself must not leak the content to people who have no right to see it.

"Read the spec, then write the code" takes exactly this path. The first version begins by supporting showing a plan or a patch to the person themselves in a restricted run.

### 5.4 Delivered answers

After the summary is sent, a **delivered answer** record is kept so that a follow-up can be picked up. It sits next to the existing record of sent messages:

- it belongs only to the original direct chat, and has a deadline;
- it is bound to the receipt of the actual delivery (so the connector has to hand back the message id for ordinary answers too. The Feishu API returns it; our connector currently hands back only the id of an approval question, and this has to be added);
- it records the source and its version, and the position in the original text that each conclusion corresponds to.

That the document was changed afterwards does not mean the cited passage was changed. If it can be checked and that passage has not changed, keep citing it. Only when that passage is verified to have really changed is the user told. If it cannot be located, say that "the passage cited at the time cannot be checked in the current version". The second point of a new summary must not pass for the second point of the old summary.

This kind of record is used only for follow-ups **after the answer**. Something not yet finished before the answer (send a link first, then say "summarise" in the next sentence) belongs to section 4.

### 5.5 What goes into the context

- **Ordinary conversation history is kept as usual**: what you said, and the agent's replies that do not involve outside content, are in the context just as today, so the conversation can be followed.
- **Restricted history is not loaded by default.** A restricted answer is loaded in two cases only: you replied to it with Feishu's "reply" function; or there is currently exactly one answer that is clearly being pointed to.
- Before loading, filter: does this person still have the right to access its source now, is the audience right, has it expired. If it does not pass, it is not loaded, and after access is withdrawn there is no falling back to the old text.
- If it is not clear which one is meant, ask.
- Ordinary history is used to understand the conversation. Every new use of a capability is still checked for permission against the resource, the purpose and the audience bound to this request.

In this way a follow-up on "what the second point is based on" is picked up, and when something new and unrelated is asked, the context holds no document content and the agent is not restricted.

### 5.6 "Which document may be read this time"

"The target has appeared in this person's past messages" is not taken as permission. The executor accepts only the action, the normalised resource and the reply target that the current request has already bound. Negation ("don't read B"), ambiguity and a change of target must all be represented. Normalising the resource, the real access rights, and whether the authorisation is valid remain the tool's responsibility.

### 5.7 Retention and clearing

| Content | Retention |
|---|---|
| The user's own words | As today |
| Outside body text, raw tool output | Not kept |
| A delivered answer and the references to its sources | Short term, in this direct chat only, with provenance and a deadline |
| A preference the user states explicitly ("from now on give the conclusion first") | Extracted in a separate step that sees only the user's own words; can be viewed and corrected |

"Checking access rights and validity" happens before content is loaded, and covers every way out: messages not yet sent, APIs that are polled, summaries and compaction, error messages, logs.

### 5.8 Conditions for replacing the old rules

The old and new judgements run side by side. Only the **judgements** are compared. No document is read an extra time and no extra message is sent for the sake of comparison. The criteria:

- the old one refuses and the new one allows: explain case by case;
- the new mechanism exceeds its authority: must be 0;
- follow-ups that were agreed to be opened up: must succeed.

Only once these are met are "wipe the whole turn" and "carry over a link once" deleted, and a switch back to the old strict policy is kept. The order of implementation is: first do reading with provenance, clearing, migration and the handling of withdrawn access, and only at the end turn on "keep answers".

## 6. Mechanism three: one way out towards people

**In one sentence**: tools do not send messages themselves. When a person needs to do something, "interaction needed" is handed to the Brain, and the Brain does all the sending.

- A tool returns a structured "interaction needed" and an opaque reference.
- The Brain first saves the intent to send, then sends through `outbox`. For the same request and the same wait, there is at most one valid entry point. After completion there is at most one logical final answer, guaranteed by a unique key. Whether the person sees it only once depends on the channel's idempotency and its ability to reconcile; when the outcome is unknown it is handled according to what the channel can do.
- The reference is resolved only **at send time**, by the connector. The real authorisation link, the credentials and the signature checks stay inside the connector. They are not passed back to the Brain and do not enter the logs.
- Where the channel supports editing, the same card is updated (the message id has to be saved first). Where it does not, this degrades to "one invitation plus one result".

The existing approval card already has this form.

## 7. Mechanism four: status signals

**In one sentence**: "received, what it is doing, done" is a general capability of connectors. It may be lost, and must not block the result.

- A status describes only a stage that really happened, and carries the request version, a sequence number and a validity period. Once the request has reached a final state, a status that arrives late is simply dropped.
- Each connector presents it according to its capabilities: an emoji on the message, a card that can be updated, 👀 on GitHub.
- A channel that cannot guarantee that a late status will not cover the result either updates the same object or shows no separate status.
- The final result, failures, and things that need a person to act go through the ordered, retryable `outbox`. A status that fails to send does not affect them.
- Timed separately: from receiving the message to visible feedback; from the condition being met to the result being delivered. The time the person spends acting is counted apart.

## 8. Mechanism five: prompts and memory

**The prompt** (already live, PR #13): one section of guidance is chosen by "how this run started", rather than one rule for every place of the same kind. When someone has just written to the agent, someone is waiting: keep using the material and the goal the other person has already given; if it is clear, finish it; only when one piece of information that would change the result is missing, ask that one question; do not repeat the tool's limits to the user; when something fails and the reason is not known, say so truthfully. A run woken by an event may stay silent on routine notifications. But if the event fulfils something promised to someone earlier (a task that was handed over has finished, or has failed), tell that person the result.

**Memory** keeps its current file form, and only three small things are done:

- The index that is always in the context is limited in size, and topic files are read on demand. The limit is set to suit our own situation.
- Only preferences that this person states explicitly and that hold for the long term are recorded ("from now on always give the conclusion first"), and they are extracted only from the person's own words. Something done once is not a preference. What is written can be viewed, corrected and deleted.
- Tell the model what memory is for; do not prescribe how it uses it.

Deliberately not done: searching past conversations across the whole scope (one scope may have several direct chats and console sessions, and a search across all of them would cross the boundaries between sessions); scheduled offline consolidation (it cannot inherit the read permissions of a direct chat). When the simple version really is not enough, add targeted retrieval that "first filters by caller, original session and data level".

## 9. Interface changes

As few as possible. The concrete shape is settled in step 0.

- **A tool's result** is one of three kinds: success, failure, wait. In a wait, the tool gives only "the type of condition" and "the interaction needed". The rest of the continuation record is filled in by the runtime.
- **The continuation record**: a small one; for its fields see section 4.2.
- **Notifications**: carry an authenticated caller identity and a de-duplication key.
- **Sending**: ordinary answers hand back a receipt too; the reference of an interactive element is resolved inside the connector.
- **Status**: an optional capability; carries a revision, a sequence number and a validity period; failure does not block the result.
- **The restricted mark** and the **delivered answer** record: see section 5.

## 10. Order of construction

Production is usable at the end of every step.

**Step 0: the contract.** Deliverables. Implementation is written only after they pass review:

- A one-page table of "events, state transitions, observable evidence", with two real examples filled into the same table. Each row states: the current state, the event and its trusted source, the conditions to check again, the only party that may write or execute, the basis for idempotency and reconciliation, the next states allowed (including unknown), and what can be asserted on the database, the channel or the worker.
- Fill in the two rows that are easiest to confuse first, and from them unfold the two sequences below:
  1. The authorisation has been saved, and the callback is repeated or the process restarts: check the original request and get the same logical summary.
  2. The worker has received the approval, the response is lost, and a cancellation follows: ask for the decision on the original question, and report only the verified result. It must not be claimed from this that the remote has been pushed.
- Two sequences with fault injection: one is "read a document", the other is "existing approvals". What can be asserted after each injection: the database state, the number of times the action was carried out, the number of replies the person saw, the audit records.
- In addition, test the leaner approach with two scenarios: "asking about the weather while waiting for A" (the weather is answered as usual, and A goes on waiting) and "a follow-up after access is withdrawn" (the old content does not reach the model).
- All existing approval tests keep passing. List explicitly which new behaviours should fail on the old implementation. These failing tests are not merged into the main branch and do not count as progress.
- The loading rules of section 5.5 are settled in this step.

**Step 1: wait and resume, plus one way out.** The full flow of reading a document, plus the adapter for existing approvals (observe only, storage unchanged).

**Step 1b: status signals.** Can be done independently.

**Step 2: provenance and context.** For the order see section 5.8.

**Step 3: prompts and memory.** The prompts can come earlier. Memory waits until provenance isolation is complete.

## 11. Acceptance cases

**Should hold**

- Give a link and a goal, press authorise, say nothing more, and receive exactly one summary. Several follow-ups afterwards are all picked up.
- Reply to one particular answer asking "what is the second point based on?", and the answer addresses the second point of that one and points to the position in the original text.
- After a process restart, or repeated or out-of-order callbacks, an action with side effects happens only once, and there is only one logical answer. A read that is safe to repeat may actually be called several times.
- Send exactly one link first, then say only "summarise" in the next sentence, and it is picked up (the positive case that PR #8 already has must be kept).

**Should not hold**

Wait and resume:

- While waiting for A the target is changed to B, and a late "A has been authorised" lets A carry on.
- While waiting for A something unrelated is asked, and A is cancelled, or that question gets no answer.
- The authorisation is still valid, but the basis of the original request has lapsed, and the document is still read (the number of reads should be 0).
- A callback arrives before the wait record, so the request is never woken.
- The final answer has been delivered but the confirmation is lost, so it is sent again, or wrongly reported as delivered.
- A notification from a timer or a worker causes a push to be approved; a run started by a timer uses some person's document permissions.

Approvals (existing guarantees must not be breached):

- The worker has received the approval but the response is lost, and then a cancellation, a new question or a restart happens: it should not push again, and the original approval should not be wrongly reported as withdrawn. When the worker has no record to look up, it is explicitly recorded as unknown and audited.
- The question is cancelled while being delivered; the question is edited and then put back; a refusal from a group member is in the queue; the same person says something afterwards in the place they typed it, before the approval is carried out: in none of these can an old approval not yet carried out take effect. (A decision already carried out is not overturned by anything said afterwards in any topic.)

Provenance and context:

- The same person is in two tenants or two apps, or has two completed answers in the same direct chat: a reply to the first one must find the first one; without a clear basis, ask.
- When a new question is started, the body of the old document appears in the model's input.
- Access is withdrawn "after the read, before it reaches the model", or "queued, not yet delivered", and the content is still disclosed.
- A passed deadline, a restore after compaction, or old data brings the content back.
- An instruction written in a document makes the agent write long-term memory, dispatch a task or send something to someone else.
- After the document is revised, a follow-up on "the second point" gets the second point of a new summary, without saying that the basis has changed.
- The user says "don't read B", and B is still read.

Frozen proposals:

- After approval, the recipient, the repository or the patch is changed, and it is still executed.
- Execution fails but success is reported.
- The approval card leaks the spec to people who have no right to see it.

## 12. What was consulted, and what was adopted

Before this version was finalised it was checked against four Anthropic articles, with the aim of making the implementation leaner:

| Article | Adopted | Not adopted |
|---|---|---|
| Building effective agents | Use the simplest approach, and add complexity only when it can be shown to help; put the effort into the tools' descriptions and what they return | |
| How we built Claude Code auto mode | The idea of not looking at content that was read in when judging an action, reflected in sections 5.3 and 5.5 | Replacing section 5 with a checking model that looks only at "the user's words and the action about to be carried out". The reason: once an old summary has been loaded into the context, an ordinary reply can repeat it, and checking tool calls cannot stop that. The miss rate the article itself gives is 17%, and it says this cannot replace human review in high-risk settings. If it is added later, it can only add blocking on actions that are already allowed; it cannot grant new permissions |
| The components of agent memory | The conversation record is the foundation of memory; the index that is always loaded must be small; tell the model what memory is for, without prescribing how to use it | Offline consolidation, and searching history across the whole scope (for the reasons see section 8) |
| Claude Code's memory documentation | An index plus topic files, a limit on the index, topic files read on demand | Its specific numbers |

## 13. Not solved, and deliberately not done

- A provenance graph for each piece of content, an extra checking model, searching history over an arbitrary range, offline consolidation: none of these is done in the first version.
- Streaming output: comes after status signals.
- Memory across scopes: not in this design.
- Whether Feishu checks PKCE on the older token exchange endpoint: still unknown, and unrelated to this design.
- Moving the storage of approvals onto a unified wait record: not done in step 1. Whether and when to do it is decided after the adapter has run steadily in production.

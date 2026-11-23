# Step 0: the contract

**English** | [简体中文](agent-core-step0.zh-CN.md)

Status: confirmed on 2026-11-22. The user confirmed the nine decisions in section 2 and chose rule A for decision 4; the review agreed to the merge after three rounds of re-checking. Implementation starts at step 1. This document adds only two tests (see section 6). They describe existing behaviour and pass on the existing code.

This is the deliverable that section 10 of the [design document](agent-core.md) asks for. It answers: from "starts waiting" to "done", who triggers each step of a piece of work, who is entitled to write, what keeps it from going wrong after a repeat or an interruption, and what can be looked up afterwards.

How to read it: sections 1 and 2 are the conclusions and the places where you need to decide; section 3 is the state tables; sections 4 and 5 are the sequences with faults and the two scenarios; section 6 is the tests; section 7 is the interfaces.

A limit on what "evidence" means: where this document says "how many messages you see", what can be asserted is how many distinct message keys the channel accepted, and how many receipts we got. A receipt does not prove that a person has read the message.

## 1. Conclusions

1. **The two examples fit into the same table.** The lifecycles of "read a document after waiting for authorisation" and "push after waiting for approval" have the same shape: the wait starts, the entry point is delivered, someone reports, verification, execution, delivery, ending part-way, and reconciling when the outcome is unknown. They differ only in "who is entitled" in each cell. So what is general is the shape of this table, and the rules in each cell still belong to their own owners.
2. **The code that carries out approvals does not need to change.** The existing implementation satisfies every cell of the table. Step 1 only adds a read-only view to it, so that both kinds of wait can be inspected and tested in the same way. The tables of rules in [Approvals](../approvals.md) remain normative and are not rewritten here.
3. **Reading a document needs few new things**: one continuation record, two small interfaces on the connector ("does this condition hold now?" and the notification "the condition holds"), one tool that lets the model cancel a wait, and one check before sending. At the same time, the part of the authorisation connector that sends cards itself and retries itself can be **deleted**, along with the sentence "Authorisation succeeded, please send it again".

## 2. Nine decisions

The design document says "the concrete shape is settled in step 0". Below is the shape I settled on. Item 1 differs from the wording of the design document; **item 4 is a little looser than the design document, and the user has explicitly chosen to loosen it**; items 7, 8 and 9 are behaviours that the review said had to be settled.

| # | Decision | What it means for you |
|---|---|---|
| 1 | **No separate "request revision number".** One continuation record stands for one thing that does not change. Changing the target = the old record ends and a new record is created at the same time | No visible effect; one number fewer to maintain |
| 2 | **In a continuation, the one bound tool call is made by the runtime, not by the model.** The model is only responsible for writing the answer from the result | "Only do the one original thing" is guaranteed by code |
| 3 | **Give the model a cancel tool, `cancel_request`.** When you say "never mind" or "use the other one instead", the model proposes the cancellation, and the runtime carries it out after checking. Cancelling is possible at any time before the answer is first handed to the channel, including while the document is being read and when the answer is written but not yet sent. If two things are waiting and you did not make clear which one you mean, it asks you | Asking about the weather in passing should not cancel the original thing. Whether a sentence is saying "cancel" is judged by the model; if it judges wrongly, that thing is not done, it tells you so, and you only need to say it again |
| 4 | **A follow-up on an old answer is made into one controlled read (`reopen_answer`).** The runtime first determines the candidate, then reads the document again as you, and only if the read succeeds does it hand the old answer and the original text to the model. **Where it is loosened**: when you did not use the "reply" function, "is this sentence a follow-up on the previous answer" is judged by the model, and code guarantees that the candidate is one of the answers still kept in this direct chat (at most 5) and that one request reads the body of at most one of them (amended 2026-11-23; it was "the candidate is the most recent message it sent you"; see 2a in section 5.3). For the other rule, which was not adopted, see section 5.3 | After permission is taken back, the old summary is not repeated. The cost of loosening: when the model judges wrongly, it reads again, with your own permission, a document you could see anyway; the body text enters the model configured for this turn; the reply is sent only to the original direct chat |
| 5 | **A wait has a hard deadline, and no separate message is sent when it expires.** The condition counts only if it holds before the deadline, going by the time the owner of the condition recorded that it held, so a check that comes late does not lead to a wrong judgement. Once the wake-up is claimed, the read and the answer have a separate handling limit | The validity period is already written on the card; raising it again after it has expired is a new request |
| 6 | **One authorisation can wake several waits.** Each one checks permission again on its own, and each gets its own answer | Two documents are both stuck on authorisation, and authorising once is enough |
| 7 | **Restricted content is checked once more before every step it takes outwards.** There are two boundaries: before the body of the document is handed to the model, and before the answer is handed to the channel. Each time, the owner of the condition is asked to confirm that the authorisation is still there, and it is confirmed that you have not cancelled and have not changed the target. If the check does not pass, nothing is handed over, and an answer not yet sent is voided and cleared | Taking back permission takes effect at once, including for content already read, and content already written but not yet delivered. For what has already been handed to the channel, we do not claim it was "never disclosed" |
| 8 | **When delivery cannot be found out, rather not send a second time.** If a message was sent but no receipt came back, and the time within which the channel can de-duplicate has passed, it is recorded as "possibly delivered, cannot be verified" and re-sending stops | In very rare cases you may not receive the answer and need to ask again; but you will not receive two copies |
| 9 | **Your messages come before a restricted answer not yet sent.** When an answer is about to be sent, if this direct chat holds messages from you that have not been handled yet, your messages are handled first, and only then is it decided whether this answer is sent or voided | You said "never mind" while it was reading the document: that sentence is handled first, and the summary does not get sent ahead of it |

## 3. State tables

### 3.1 The eight stages of a wait

| Stage | Meaning |
|---|---|
| T1 The wait starts | The tool says "this cannot be done now; a condition has to be waited for" |
| T2 The entry point is delivered | The thing a person has to act on (an authorisation card, an approval card) was handed to the channel |
| T3 Someone reports | Some party says "the condition may hold now; you can go and check" |
| T4 Verification | The owner of the condition independently confirms that it holds; it is confirmed again that this thing should still be done |
| T5 Execution | The action happens |
| T6 Delivery | The result is handed to the channel |
| T7 Ending part-way | Cancellation, a change of target, expiry, withdrawal of access |
| T8 Reconciling | How to find out, when any step above was done but no confirmation was received |

The four states in section 4.1 of the design document correspond to T3, T4, T5 and T6. A report (T3) is never the same as permission (T4).

### 3.2 Reading a document after waiting for authorisation (to be built in step 1)

Notation:

- `K`: the stable identifier of one piece of work, taken from the id of the first tool call. It is the id of the continuation record, and also the key by which the tool's side recognises this piece of work.
- `r1`, `r2`: the first run and the continuation run. In the conversation record `r2` uses its own call id and does not reuse `K`; otherwise the "waiting" result left by `r1` would be taken for the result of `r2`.

| Stage | The event and its trusted source | What to check again | The only party that may write | What is relied on after a repeat or an interruption | The state afterwards | Evidence that can be asserted |
|---|---|---|---|---|---|---|
| T1 | The connector's tool returns "wait" in `r1`, with the condition (whose authorisation, which permissions are needed), the generation, the deadline and the interaction reference (all opaque to the Brain) | `r1` still stands only for you yourself at this moment (the existing `#actingFor` check) | The Brain, which writes three things in one transaction: a tool result with fixed wording, the continuation record, and the invitation to be sent | `K` does not change; when the same call is replayed, the tool gives the same interaction reference; all three are "do not write if it already exists". Invitations are de-duplicated by interaction reference, so two pieces of work can share one card | Waiting | 1 continuation record; 1 invitation to be sent for this interaction reference; no authorisation link in the tool result or in any of the Brain's records |
| T2 | The outbox delivers the invitation. Only at the moment of sending does the connector turn the interaction reference into a card with a link | At least one waiting record is still using this interaction reference, and the deadline has not passed. Otherwise it is not sent, and an expired old link is not sent again | The Brain's outbox; the link appears only inside the connector | Re-sending with the same message key: the channel accepts it only once within its de-duplication window. Outside the window, see T8 | Waiting | This message key was accepted by the channel 1 time; when the invitation has not been delivered, the view shows it |
| T3 | (a) When the connector saves the token, it records "one notification owed" in the same write, and delivers it to the Brain afterwards; if it cannot be delivered, the connector's own alarm retries until it is acknowledged. (b) The Brain asks for itself: when the record has just been written, when you speak again in this direct chat, and at the moment of the deadline | A notification is only a hint. It carries no permission and does not say which round of waiting it is for. The Brain finds the waiting records whose condition belongs to the same subject (the same connector, the same person's authorisation); the invitation need not be the same | The Brain, which for each such record puts one "go and check `K`" event into the inbox, with the key `K:source event`. This event becomes a run of its own and is not batched with other messages | The inbox accepts the same key only once. Extra or late hints are harmless: T4 checks again | Waiting (the record is unchanged) | Repeated notifications give only 1 event; this event does not count as anything said by anyone |
| T4 | The Brain claims this event | First ask the owner of the condition: do the permissions **this record needs now** hold, and since when. If they do not hold, or the time they began to hold is later than the deadline: drop this event, and **the record is unchanged**. If they hold: check further that the record is still waiting; that the first few messages are still there, their text is still there, and they pass again the checks of "the person themselves, a direct chat, a trusted connector, the same source"; and that the reply target has not changed. Only if one of these does not hold is the record ended. Permission is computed from the original messages the record refers to, not from the event this run claimed | The Brain, which in one transaction changes the record from waiting to continuing and records `r2` and the claim time. Only the handler that completed this change can end this round | The state of the record is the source of truth: a record has only one `r2` at any moment; another event that finds the record not waiting does nothing and does not change the record | Continuing, or ended (basis lapsed); or still waiting as before | 1 more run; the first few messages still belong to `r1`; that call in `r1` has no second result |
| T5 | The runtime makes, in `r2`, the one call bound in the record. The business key handed to the tool is `K`, and "what you said" is taken from the original messages the record refers to | The tool verifies for itself: the tenant, the app, the person themselves, the scope of permissions needed this time, the current generation; it checks once more before handing over the body text. **Every time input containing the body text is about to be submitted to the model** (including after a replay following an interruption, and after a postponement because of a usage limit): the Brain confirms with the owner that the authorisation and the generation are still valid, and confirms that the record has not been cancelled and the audience has not changed. If this does not pass, the model's input has no body text and the record ends | The connector (the read); the Brain only passes it on | A read is safe to do again. "Carry over the previous link, once only" is keyed by `K`, so doing the same piece of work again does not count as a second time | Body text obtained: `r2` is restricted under the existing rules. A wait is still needed: the record goes back to waiting, and a new invitation is sent only if the permissions needed or the invitation have changed. Failure (for example, no right to open it): you are told truthfully | Access withdrawn or cancelled before the read: 0 reads. Access withdrawn after the read and before the hand-over to the model: no body text in the model's input. The number of reads is at least 1 (it can be more after a restart); the audit has `tool.used` |
| T6 | The model writes the answer in `r2`. The de-duplication key of the answer is set by the runtime to `answer:K` | **When it is queued**: `r2` ending, the record moving to "answer to be sent", and this one answer being queued are the same transaction; the sentence "something went wrong" used when `r2` fails has the same key, so there is no second answer. **Before every submission to the channel**: this direct chat holds no message from you that has not been handled yet (if it does, wait until they have been handled); the record has not been cancelled or had its target changed; the handling limit has not been exceeded; the recipient is still the original direct chat; the owner confirms that the authorisation and the generation are still valid. If this does not pass, this answer is voided and cleared | The Brain's outbox | The model's retries and a restart of the run all land on the same key | Done, failed, or voided | At most 1 message with the key `answer:K`. Access withdrawn or cancelled before submission: no submission, and the body text has been cleared. Access withdrawn only after submission: the body text is cleared and re-sending stops, the state stays "delivered" or "possibly delivered", and it is not reported as never disclosed |
| T7 | You explicitly cancel or change the target: the model calls `cancel_request(K)`; for the selection rules see section 5.3. Expiry: the deadline has come, and the owner says the condition did not hold before the deadline. Withdrawal of access: the connector increases the generation by one | Cancellation: this run is based only on your own words in this direct chat, and `K` belongs to this conversation. What can be cancelled is: waiting, continuing, answer to be sent, up to the point where the answer is first handed to the channel | The Brain. When the target is changed, "end the old record, write the new record" is one transaction | An ending is a final state. Cancelling A does not withdraw the card that B is still using | Cancelled, expired, basis lapsed | Later notifications produce no read; what has not been read is no longer read; what has not been sent is no longer sent; the audit has the reason for the ending |
| T8 | A notification was lost: the two paths of T3 cover for each other. A message was handed to the channel and no receipt came back | | The Brain | The states of a message are recorded separately: to be sent, has a receipt, confirmed failed, possibly delivered but cannot be verified. Within the channel's de-duplication window it is re-sent with the same key; after the window, if the channel supports looking up a receipt by key, look it up, and if not, stop at "cannot be verified" and do not re-send blindly | | A message without a receipt is not marked as delivered |

The two times are counted separately:

- **The waiting deadline** is given by the tool (for an authorisation it is the validity period of the invitation). It constrains only T3 and T4: the condition must hold before it, going by the time the owner recorded that it held.
- **The handling limit** is counted from the moment of the claim in T4, and is set to 1 hour in the first version. It constrains T5 and T6: once it is exceeded, what has not been read is not read, and what has not been sent is voided. A continuation postponed to the next day because of a usage limit is therefore voided, and you need to ask again.

Something else you say while waiting ("what's the weather like today") does not appear in the table: it is an ordinary run and does not touch the continuation record.

### 3.3 Pushing after waiting for approval (the existing implementation, unchanged)

Notation: `T` is the task, `q` is the question id on the worker's side. The rules in each cell are those of [Approvals](../approvals.md); this table only says which stage they fall in.

| Stage | The event and its trusted source | What to check again | The only party that may write | What is relied on after a repeat or an interruption | The state afterwards | Evidence that can be asserted |
|---|---|---|---|---|---|---|
| T1 | The worker's outbound proxy holds a real push and reports `needs_input` (with a sequence number) | The task has not ended; this sequence number has not been seen | The Brain (`taskEvent`), which writes in one transaction: the report, the code, the question to be sent, `tasks.pending`. When the conversation has no reply target there is only `pending` and no question, and such a question cannot be approved | Reports are de-duplicated by (task, sequence number) | Waiting for approval | At most 1 question; a repeated report does not produce a second card |
| T2 | The outbox delivers the question and saves the receipt | | The Brain's outbox | "Started" is recorded before sending, and after an interruption it is re-sent with the same key | Waiting for approval | A question with no delivery record cannot be approved. A receipt does not prove that a person has read it |
| T3 | A message from a member in this conversation, or a press on a button on the card; who pressed it comes from Feishu. The model calling `answer_task` only carries the message | Events from timers and workers are not anything said by anyone | Nobody (it is only a report) | | Waiting for approval | Events of this kind **cannot create** an intent to approve (an intent that already exists may still be there) |
| T4 | `#answerTask` checks the approval rules one by one | These include: it was said after the question was delivered, the question can be read in full, the person's own words, in a group it must be the single original requester, a refusal from an entitled member wins (including one still in the queue), it is that person's last word, one reply corresponds to one question, an answer that can be edited is read again, and a question that was edited can only be refused even if it was put back | The Brain, which writes `tasks.answering` (bound to the question id and the message that made the decision) and the audit. Only this one place can write | When the same question already has an unconfirmed intent to approve: a newly arrived valid refusal is judged afresh; the approval is re-sent only when nothing has been said against it since. Which decision finally takes effect goes by the worker's record | Decided, to be delivered to the worker | The audit has the approver, the original text of the question, and that message |
| T5 | The Brain calls `worker.answer(decision, q)`, possibly more than once | The worker checks for itself: `q` is still the question it is waiting on | The worker. For each `q` it records only one decision that takes effect, and answering again returns the original one; the one held request can use a short-lived permit at most once, and the task must still be running. "Do not ask again for the same branches in the same repository for the rest of this task" is a different scope and is recorded separately | The question id | Recorded by the worker | The three pieces of evidence are separate: the worker recorded the approval; the proxy took the permit; the remote push succeeded. An earlier one does not prove a later one |
| T6 | `answer` returns | | The Brain, which clears only the `tasks.pending` that still corresponds to `q`, writes the ending on the question, and changes the card (best effort) | The ending is written only once and is not overwritten | Approved or refused | The ending recorded on the question |
| T7 | (a) A new question takes its place, or the task ends or is cancelled. (b) The worker reports that the held request gave up by itself, and `q` is still the current question | (a) Whether an answer was ever sent for this question | The Brain. (a) Through `#setAside`: if none was sent, it is recorded as withdrawn; if one was sent, it goes to T8. (b) It is recorded as withdrawn directly. When the worker is cancelled, it clears the question it is waiting on but keeps the decisions it already has, so that they can be looked up | | Withdrawn, or to be reconciled | |
| T8 | The Brain's alarm (`#settleQuestions`) asks `worker.decisionOn(q)` | | The Brain writes the ending only as the worker's record says | The worker says it is still waiting, or cannot be asked for the moment: ask again with back-off, at most 12 times | The worker has a record: write what it says. The worker confirms there is none: withdrawn. The worker's records have been cleared, or it can never be asked: **outcome unknown**, and `task.answer_unverified` is written to the audit | "Withdrawn" is not written on a guess |

In T8, what the Brain reports is "which decision the worker recorded", not "the remote push succeeded". Whether the push succeeded comes only from the worker's later reports.

### 3.4 A common way to inspect

Step 1 adds a read-only view that lists both kinds of wait in the same shape: kind, id, state (waiting, reconciling, done, refused, withdrawn, cannot be verified), whether the entry point was delivered, and the start time. The state of a document read is taken from the continuation record; the state of an approval is derived from the existing `tasks.pending`, `unsettled` and the ending on the question.

This view is used in three places: the inspection output of the admin interface, the list of "things being waited for" in the prompt (which is also the range of candidates the model may cancel), and the tests. It writes nothing, and approvals have no second set of states.

## 4. Two sequences with faults

### 4.1 Reading a document

The normal sequence: you send a link and "summarise" → `r1` calls the tool, and the tool says authorisation is needed → the Brain stores the continuation record and sends one card, and `r1` ends → you press authorise → the connector saves the token and notifies the Brain → `r2` reads the document again → you receive one summary. You said only one sentence from start to finish.

The "Today" column says how this assertion stands on the existing code: exists (existing tests already guarantee the part of it that belongs to the connector), or new (it depends on the new record and the new sending path).

| Fault injected | Stage | What should hold afterwards | Today |
|---|---|---|---|
| F1 The process is interrupted after the tool returns and before the record is written | T1 | The same call is replayed; 1 continuation record, 1 invitation | Only one invitation: exists. The continuation record: new |
| F2 The card was handed to the channel, and the receipt was not received | T2 | Re-sent with the same key within the de-duplication window; not sent again outside the window | Re-sending with the same key: exists. Through the Brain's outbox: new |
| F3 You refresh the authorisation-complete page once | T3 | The invitation can be used only once, and the second time shows "the link is no longer valid"; the token is saved only 1 time, and only 1 notification is owed | The invitation is single-use: exists. The notification: new |
| F4 The token has been saved, the process is interrupted before the notification is sent, and you say nothing more afterwards | T3 | The connector's alarm makes up the owed notification; 1 summary | New |
| F5 The notification arrives more than once | T3 | 1 wake-up event, `r2` runs 1 time | New |
| F6 You press an old card left by a previous request, and the token is saved before the continuation record has been written | T1, T3 | The notification at that time finds no record and is dropped; the Brain's own query after the record is written finds that the condition already holds, and the continuation goes ahead as usual | New |
| F7 The process is interrupted after `r2` has read the document | T5 | `r2` carries on; the document may be read 2 times, and there is at most 1 answer | New |
| F8 The summary was handed to the channel, and the receipt was lost | T6, T8 | Re-sent with the same key within the de-duplication window. Downtime longer than the window: recorded as "possibly delivered, cannot be verified", and not sent again | New |
| F9 Before `r2` starts, your first message can no longer be found | T4 | The record ends as "basis lapsed"; 0 reads | New |
| F10 The authorisation is taken back during the wait, and a late notification arrives afterwards | T7 | The generation does not match, and the notification is dropped; even if it did wake the request, the tool could not get the token; 0 reads | A token of an old generation is unusable: exists. The rest: new |
| F11 `r2` has read the document and the body text has not yet been handed to the model (the process is paused, restarted, or postponed because of a usage limit), and at this point the authorisation is taken back | T5 | The check before submission does not pass; no body text in the model's input; no answer | New |
| F12 The model has already received the body text and is writing the answer, or the answer is already queued, and at this point the authorisation is taken back | T6 | The check before submission to the channel does not pass; the answer is voided and the body text cleared; no submission after that | New |
| F13 While `r2` is running or the answer is waiting to be sent, you send "never mind" (it comes in through the normal entry point for incoming messages, not by a test changing the record directly) | T6, T7 | The answer is held back first; "never mind" is handled, the record is cancelled, and the answer is voided. What you receive is "cancelled", not the summary | New |
| F14 In `r2` the tool says a wait is still needed (the permissions are not enough), and a late notification from the previous round then arrives | T3, T4 | This hint triggers one query; the permissions needed now do not hold, the event is dropped, and **the record is still waiting** and is not ended; afterwards you authorise, it completes as usual, and there is at most 1 answer | New |
| F15 Two pieces of work, A and B, share one card; you cancel A, then authorise | T7 | The card is still usable; only B gets an answer; 0 reads for A | New |
| F20 A and B share one card. You reply to the card with "never mind"; it asks you which one you mean; you say "cancel only A, keep B"; then you press authorise (every sentence comes in through the normal entry point for incoming messages) | T7 | The first sentence is refused and a question is asked back; the second sentence cancels only A; after the authorisation only B gets an answer, and there are 0 reads for A | New |
| F16 A waits for authorisation for an ordinary document, and B waits for authorisation for a wiki page; these are two different invitations. You press only B's, and its permissions are already enough for A | T3, T4 | Both A and B are woken and each completes; A does not wait until it expires | New |
| F17 The check at the moment of the deadline comes late (the alarm is delayed), and you had already authorised before the deadline | T4 | Going by the time the owner recorded that the condition held, the continuation goes ahead as usual | New |
| F18 You complete the authorisation only after the deadline | T4, T7 | The record expires; 0 reads; no message | New |
| F19 The answer has been handed to the channel and the receipt is lost, and afterwards the authorisation is taken back | T6, T8 | The body text is cleared and re-sending stops; the state is "possibly delivered, cannot be verified" | New |

After each injection, five things are checked: the database state, the number of times the document was read, whether the input the model received contains the body text, the number of message keys the channel accepted, and the audit records.

Assertions of the "should not happen" kind, such as F9, F10 and F13, are each paired with a positive control that uses the same set-up steps: with the basis still there and the authorisation valid, the document really is read and answered; with only that one premise changed, it stops in the state written in the table. Otherwise they might pass only because "nothing happened at all".

### 4.2 Existing approvals

The normal sequence: the worker's push is held → the Brain sends an approval card → you approve → the Brain records the intent and hands it to the worker → the worker releases that one push → the card shows approved.

| Fault injected | Stage | What should hold afterwards | Which test guarantees it |
|---|---|---|---|
| A1 The worker reports the same question more than once | T1 | 1 question | Existing: "ignores repeated reports…" |
| A2 The question has no delivery record yet | T2 | It cannot be approved | Existing: "does not approve a question nobody has seen yet…" |
| A3 The worker recorded the approval, the response was lost, and you then said "wait a moment" | T4, T5 | That approval is not re-sent; the decision on the worker's side does not change | Existing: "re-sends an unconfirmed approval only while nothing speaks against it…" (in this one `answer` is called twice and the worker records only one decision), "does not re-send … once its author has said more" |
| A4 The worker recorded the approval, the response was lost, and the task was then cancelled | T5, T7, T8 | The question is not recorded as "withdrawn" on a guess; after the worker has been asked it is recorded as "approved"; in this sequence `answer` is called only 1 time; the approval is still attributed to the approver | **Added**: "reports what the worker was told when a task is cancelled with its approval unconfirmed…" |
| A5 The same as A4, but by the time the worker is asked the task's records have been cleared | T8 | Recorded as "outcome unknown", and the audit has `task.answer_unverified` | **Added**: "records that an answer could not be verified, when a cancelled task's records are gone" |
| A6 After the response is lost, the worker raises the next question | T7, T8 | The old question ends as the worker's record says, and the new question stays open | Existing: "learns from the worker how a question ended…" |
| A7 An event from a timer or a worker arrives, and nobody has said anything | T3 | No intent to approve is created | Existing: "does not let the model approve on the strength of a worker report alone" |

A4 is the second row that the design document names. The existing implementation handles it correctly; it is only that until now no test pinned this sequence down.

What A4 and A5 verify: the real Brain, the calls received by the test double of the worker, and the ending recorded on the question. They do not observe what the Feishu card actually displayed, and they do not observe the remote push.

## 5. Scenarios and selection rules

### 5.1 Asking about the weather while waiting for A

1. You send the link to document A and "summarise". The record `K_A` starts waiting, and you receive a card.
2. You ask "what's the weather like today". This is an ordinary run, and it answers the weather. `K_A` does not change, and A is not read again either.
3. You press authorise. `r2` reads A, and you receive the summary.

Assertions: the weather gets an answer; `K_A` is waiting both before and after step 2; in the end exactly 1 answer for A is queued.

### 5.2 A follow-up after access is withdrawn (this belongs to step 2; the rules are settled here first)

1. The summary has been delivered. The Brain keeps a "delivered answer" record `D`: it belongs to this direct chat, has a deadline, and records the receipt, the tool called at the time and its arguments, the version of the document at the time, and the position in the original text that each conclusion in the answer corresponds to.
2. The authorisation is revoked.
3. You reply to that summary: "what is the second point based on?". The model calls `reopen_answer(D)`. The runtime determines that `D` is the one you mean (see section 5.3), then reads the document again as you.
4. There is no token, so it cannot be read. The tool returns "wait", so this follow-up itself becomes a piece of work waiting for authorisation, and follows the flow of section 3.2. The old summary is not handed to the model.
5. After you authorise again, the continuation runs: it checks once more that `D` has not expired and its source has not changed, and only when the read succeeds again is it handed over.

Assertions: in steps 3 and 4 the input the model receives contains no text of the old summary; 0 reads of the document.

**The loading rules (section 5.5 of the design document is settled here)**:

- Ordinary conversation history enters the context as usual.
- Content left by a restricted run does not enter the context; only one fixed sentence is left in its place (as today).
- An old answer can come back only through `reopen_answer`, and only if all of the following hold: this run is based only on your own words in this direct chat; `D` has not expired; `D` is a candidate accepted by section 5.3; reading the source of `D` again as you succeeds.
- The first version keeps a `D` only for answers that "read only one source". When an answer combined two documents, A and B, no record is kept, because reading only A again successfully is not enough to hand over content that includes B.
- What is handed to the model after the read succeeds is: the original text as it is now, the answer delivered at the time, and whether each passage cited at the time can still be found unchanged now. That the version of the whole document changed does not mean the cited passage changed. These are content that was read in, and this run is restricted under the existing rules.

### 5.3 Which one the runtime accepts when the model proposes a cancellation or a follow-up

"You yourself said something in the direct chat" plus "only one thing is waiting at the moment" does not prove that the sentence refers to it. There are three layers:

1. **When there is a trusted binding, the candidates are only those within the binding.** If you used the "reply" function to reply to that answer, the only candidate is that answer. If what you replied to is an invitation card, the candidates are the records still using that card; if there are two (A and B share one card), you still have to be asked which one you mean. If the model gives an id outside the candidates, the runtime refuses.
2. **When there is no binding, the candidates are given by the runtime, and the model can only choose among them.** The candidates for a cancellation are the records in this direct chat that can still be cancelled (waiting, continuing, answer to be sent). The candidates for a follow-up are given in 2a below.

   **2a. A follow-up that is not written as a reply (amended 2026-11-23, confirmed by you).** This is the only rule for such follow-ups; it replaces "at most one candidate: the most recent answer". The first real use showed the old rule to be too strict: after two documents had been read one after the other, "summarise the asset list" could only land on the second.

   **Candidates.** The answers still kept in this direct chat: within 24 hours, with a receipt, a whole record, and exactly one source. At most 5, newest first. The list is fixed once when a request starts and does not change after that. A single kept answer is a candidate too, even if the agent has said something else since (under the old rule there was then none). Being a candidate is not a reason to read: if your words have nothing to do with it, or you say not to, neither a title nor a body is fetched.

   **Three steps; a later one is taken only if the earlier does not settle it:**

   1. **Nothing is read.** The list is given to the model, each entry with only its id, its time and what you yourself said at the time; no document content. The model judges by rule A which one your words mean ("the first one", "the one I sent earlier", or you said what it was when you pasted the link). That is a grounded judgement, not a guess: two bare links and a topic named by you call for step 2. There is no recogniser that matches by language in code. The cost of a wrong judgement is the one stated in decision 4.
   2. **If it cannot tell, the model may ask for titles, once per request.** One read-only tool fetches, as you, the title of each listed answer's document, and not its body.
      - Passive: for one that cannot be fetched (you can no longer open that document, the authorisation has ended, the link now leads to another object) no title is returned, **no authorisation card is sent**, and nothing waits; the same if none can be fetched. An authorisation that still stands does not mean you can still open that document, so each title is fetched there and then, as you, for that document, and checked to be the same object.
      - A title is document content. Before titles are given to the model, and before any message bearing one is sent or sent again, these are checked afresh: the authorisation they were fetched under, the follow-up switch, that the answer is still within the time it is kept for, **and that you can, at that moment, still open that same document as yourself**. An authorisation that stands says the token is good, not that the document is still open to you. If that cannot be established, that title does not appear; in the question, that entry falls back to your own words at the time and its number, in the unchanged order. "Cannot be established" makes no difference between causes: you no longer have access, the wiki link now leads elsewhere, or Feishu cannot be asked just then; in each case the entry falls back at once, with no retry for its sake and without putting the question off. It is done as for an invitation card's interaction reference (T2): the question's record and the queued message hold ids only, and the text with titles is laid out by the connector at the moment of each submission to the channel, looked up by id there and then (the one request for the document's information both establishes that you can open it and returns the title), so no title text sits in the queue. Only the entries a title was fetched for at step 2 are looked up: the list is not widened, and no title is fetched for an entry that had none.
      - The model may choose only among candidates **for which a title was returned**. A single title coming back does not mean that is the one you meant.
   3. **If it is still not settled, the runtime asks.** The runtime itself sends "which one do you mean", lists the candidates in a shown order, and records: which message made the original request, which candidates were shown and in what order, this question's receipt, how long it is good for (one hour from delivery, the same as the handling limit for a request carried on), and whether it has been used. The record holds ids only, no title text. If the question carries titles, the runtime lays it out, and it stands under the same guard as a message from a run that read outside text, with its text removed once delivered. The first new message you send after the question was delivered ("the second one") is read against **the order shown then**, even if the list has changed since, and the original request ("summarise") is carried on. It is accepted once; a repeated delivery does not use it twice; if that first message makes no choice, the question is closed there and the message is handled as an ordinary one; a reply written to the question message itself counts as an answer to it (as for cancelling); if it is a reply to some other message, that binding wins. Once the question is no longer good, "the second one" is handled as an ordinary message. After step 2 has been attempted, a candidate no title was fetched for can be read only when you yourself pick it in this way (a choice made directly at step 1 is not limited by this), and then 5.2 applies as usual (if authorisation is needed, it waits). The runtime never quietly substitutes another candidate that can be reached.

   **One body per request, at most.** Whether chosen at step 1, 2 or 3, the target is recorded before it is read or waited for, and stays the same across a restart, a retry or a renewed authorisation; the same target may be tried again, and after a failure no other may be read instead. This is checked where the read is carried out as well, and the ordinary document-reading tool is not a second way around it.

   **The context that has seen titles has three ways out, and cannot send a message.** It cannot call `send_message`: every sentence that reaches you is either fixed words of the runtime or comes from the clean context described next. The three ways out:
   - It chooses one id a title was returned for: that answer is reopened in a clean context (next paragraph).
   - It cannot settle which: step 3, and the runtime asks.
   - None of them is what you are talking about (you ask about "the asset list", and the kept answers are all weekly reports): the choosing ends. The runtime starts another clean run holding your original words and one fixed remark, "none of the kept answers fits", and it answers as it would an ordinary message (usually by asking you for the link). That run cannot ask for titles again and cannot reopen an answer.

   **After titles have been seen, the answer is written in a clean context.** The context that saw the titles is used only to choose an id. Once it is chosen, the runtime starts another run in the manner of carrying a request on: it holds only your original words and the controlled reopening (5.2) of the chosen answer; no other titles, nothing the model wrote while choosing, no output of that tool. The answer so written rests on one source, is kept as usual and can be followed up again; and if you later lose access to B, B's title does not come back with an old answer about A. The question message itself is not an answer that can be reopened.

   A follow-up written as a reply is still bound exactly by rules 1 and 4, and 2a does not apply. On every path the source must be read again as you, successfully, and be the same object, before the old answer is handed over.

   A known trade-off: step 2 lets up to 5 titles into the context that does the choosing, and some may be titles of documents other people wrote. What a title says is not an instruction; in code, all that context can bring about is "choose one id among the candidates a title was returned for".
3. **For a cancellation, more than one candidate and no unique binding: the runtime refuses, and the model asks you which one you mean.** (A follow-up goes by 2a; its question is recorded in the same way.) At the same time the runtime records "these were the candidates just asked about". Once that question has been handed to the channel, the **first new message** you send in this direct chat ("cancel only A, keep B") counts as the answer to it: the model may pick one of those candidates, and the runtime accepts it once. The bounds:
   - A message that had already arrived while the question was still in the queue is not an answer.
   - If that first message is a reply, made with the reply function, to some other message, that binding takes precedence and this chance is void.
   - If that first message makes no choice, the chance is used up all the same; the same message delivered twice does not carry the chance over to the next one.
   - Before acting, the runtime checks again that the chosen request can still be cancelled; if it cannot, that is said plainly, and no other request is chosen in its place.
   - Which one "cancel only A" means is still for the model to understand; what the code guarantees is the range of choices and at most one use.
4. **Replying to the message you yourself first sent limits the candidates to what that message started.** The continuation record holds which of your messages started each request. If that message started exactly one request that can still be acted on, the reply binds to it; if it started two (one message with links to both A and B), the question of rule 3 is asked; if none is left, you are told there is nothing left to act on. This is the same rule as for a reply to a shared card.
   - **This holds for follow-ups too (added 2026-11-23, from the first real use).** If you reply to your own message that carried the link, the candidate is the answer that was read for that message; if there are two such answers, neither is offered, and the model asks you, or you reply to the answer itself. Reading works the same way: a request without a link that is a reply to a message of yours with a link is about that message's document, not the one you linked last; if the message replied to has no link, you are asked for it, and "the last link" is not used in its place.

A binding answers "which one"; it does not answer "whether to". If you replied to the answer about A but said "don't read A again", the binding identified A, and whether to read again still depends on what you said, which the model judges.

One question remains in layer 2: when there is only one candidate, who judges "is this sentence really about it". **It is settled as rule A: the model judges** (chosen by the user on 2026-11-22). Code only guarantees the range of candidates.

- This is looser than the requirement of "clearly being pointed to" in sections 5.5 and 5.6 of the design document.
- The consequence when the model judges wrongly: it reads again, with your own permission, a document you could see anyway; the body text enters the model configured for this turn; the reply is sent only to the original direct chat. It will not read content you have no right to see, and it will not send to anyone else.
- "Do not read A again when asked about the weather" and "do not read A when told 'don't read A'" therefore rest on the model. They are checked with conversation cases run on a real model, and are not a guarantee at the level of code.

Rule B, which was not adopted: code first requires that your words can be matched with certainty to some item that actually exists in the old answer ("expand on the second point" matches item 2), and does not read if they cannot be matched. The review leaned towards it, because it fits the wording of the design document. The reasons it was not adopted: it would mean writing and maintaining a recogniser that matches by language for one form of message, and a slightly vaguer follow-up ("a bit more detail on that one just now") would be met with a question back. If wrong reads turn out to be a problem in real use later, it can be added without changing the other rules.

The following are guaranteed by code, and are tested by having "a scripted model that forces the tool call in every example":

- What you replied to is a different message: 0 reads, and the cancellation is refused.
- For a cancellation there are two candidates and no unique binding: refused; after the question back, one of them can be chosen in your next sentence, once only.
- Follow-up (2a): once a request's target is fixed as A, a proposal to read B is refused, on a retry too; if A fails to be read, can no longer be opened, or its link leads elsewhere, neither a kept title nor the old answer is handed over, and B is not read in its place.
- Follow-up: after the question has been sent and before you make a valid choice, 0 bodies are read.
- Follow-up: an id outside the list, or, after titles were fetched, an id no title was returned for: refused, 0 reads.
- Follow-up: titles of A and B were fetched and A chosen, you then lose access to B and follow up on A: B's title appears in nothing given to the model or sent to you.
- Follow-up: B's title was fetched; while the question is still queued only your access to document B is removed (the token stays valid), and the question is sent again: B's title does not appear, no authorisation card is sent, and no body is read.

These rest on the model's judgement (rule A). Code does not guarantee them; they are checked as behaviour cases with a real model, not with a scripted one that forces the call:

- A was read, then B, then you say "the asset list" and A is about the asset list: A is chosen, and only A's body is read.
- The two candidates' titles cannot be told apart: you are asked.
- Words that have nothing to do with the candidates ("what's the weather"), or you say not to read: neither a title nor a body is fetched.

Cancellation is not tightened in the same way: a wrong cancellation is easy to put right, the model judges, and after cancelling it tells you.

Conversation cases run on a real model are used to measure how well natural phrasings are covered, and the cases that should not lead to a re-read, such as asking about the weather and negative sentences.

## 6. Tests

**Merged now** (they describe existing behaviour and pass on the existing code): the two tests A4 and A5 of section 4.2. All existing approval tests keep passing.

**To be written in step 1, and expected to fail on the existing implementation** (not merged ahead of time):

| New behaviour | Why the existing implementation fails |
|---|---|
| After pressing authorise and saying nothing more, 1 answer is queued | The callback only saves the token, and tells you to "send the request again" |
| F4, F5, F6, F7: a notification owed, repeated or early, and an interrupted continuation | There is no continuation |
| F14: when waiting again, a late notification from the previous round neither ends the continuation nor repeats it | There is no continuation |
| F16: a broader authorisation satisfies the wait that belongs to a different invitation | There is no continuation |
| F17, F18: the deadline is compared with the time the condition held, and whether the check is early or late does not affect the result. F18 is tested with "the permission for an ordinary document holds first, and the permission the wiki page needs holds only after the deadline"; the time it holds must be strictly earlier than the deadline | There is no wait |
| F20: with a shared card, the ambiguity is resolved by one question back | This tool does not exist |
| Two variants of F20: one original message started two requests, and a reply to it saying "no need for this one" is answered with a question; a message that arrived before the question was handed to the channel does not count as an answer | This tool does not exist |
| F15: two pieces of work share one card, and one of them is cancelled | There is no wait record |
| F11: access is withdrawn after the read and before the hand-over to the model, and the model's input has no body text | Today nothing is checked before submission to the model |
| F12: access is withdrawn after the model has received the body text, and there is no submission after that | Today nothing is checked before sending |
| F13: "never mind" comes in through the normal entry point and races with a continuing run or an answer to be sent, and the result is a cancellation | Today, when a run ends, its messages are sent first and only then is the next incoming message handled |
| F19: the receipt is lost after submission and access is then withdrawn; cleared and no longer sent, and the state stays "possibly delivered" | Today this state does not exist |
| The outside-the-window case of F8: recorded as cannot be verified, and not re-sent blindly | Today there are only three states: "to be sent, sent, given up" |
| The invitation is sent through the Brain's outbox, and the Brain's records hold no authorisation link | Today the authorisation object sends it itself |
| The weather is asked about while waiting for A, and A completes as usual afterwards | There is no wait |
| An ordinary answer has a receipt after it is delivered | The Feishu connector currently hands back a receipt only for approval questions |
| A scripted model forces a call to `cancel_request`: a reply to a different message, two candidates with no binding, and a reply to a shared card with two records are all refused | This tool does not exist |

**Holds today and must keep holding afterwards**: a run started by a timer cannot get anyone's document permissions (`#actingFor` checks the identity of the event); tokens and invitations of an old generation are unusable (the connector already protects this); an invitation can be used only once.

**Passes today because "there is no continuation at all"**: a late authorisation after a cancellation does not read the document; F9. These must be written together with their positive controls (see the end of section 4.1).

**For step 2**: a follow-up can be picked up (fails today); in a follow-up after access is withdrawn, the old content does not enter the model (passes today, because nothing is kept); an answer that combines two sources leaves no record; after re-authorising, the deadline and the source of `D` are verified again; the forced-call cases listed in section 5.3.

## 7. Interfaces

Only the shapes are listed. Whether to use a continuation table or reuse the existing run records, how keys are encoded, and how the view's states are named are left to the implementation.

- **A tool's result gains one more kind, "wait"**: the type of condition (such as `authorisation`), the condition (the subject and the permissions needed this time), the generation, the deadline, and the interaction reference. The condition and the interaction reference are strings that only this connector can resolve. The text shown to the model is written by the runtime; the tool does not supply it.
- **The connector gains two things**: answering "does this condition hold now?" (it holds and since when, not yet, it will never hold), where what is checked includes the tenant, the app, the person themselves, the scope of permissions and the generation; and notifying the Brain when a subject's condition holds, with the notification persisted until it is acknowledged.
- **Sending**: a message can carry an interaction reference, which the connector resolves at send time; every message hands back a receipt; a message that carries a condition is checked before every submission, and gives way to incoming messages in the same direct chat that have not been handled yet (T6); messages gain one more state, "possibly delivered, cannot be verified".
- **The continuation record**: `K`, the conversation, the ids of the first few messages, the tool name and its normalised arguments, the reply target, the condition (the connector, the reference, the generation), the current interaction reference, the deadline, the claim time, the state (waiting, continuing, answer to be sent, the various endings), and the id of the continuation run.
- **The model's tools**: `cancel_request` (step 1) and `reopen_answer` (step 2); their arguments can only be candidates given by the runtime. Rule 2a of section 5.3 adds one read-only tool that fetches the candidates' titles; after it is called, that context cannot send a message, and can only choose an id, hand over to the runtime's question, or end the choosing.
- **The connector gains one more thing (2a)**: answering, passively, "can this person open this same document now, and what is its title". No authorisation card is sent and nothing waits; where it cannot be fetched, nothing is returned. Fetching titles and the check before sending use this one interface.
- **The view**: see section 3.4.

Step 1 also deletes: the code in the authorisation object that sends and retries the invitation, and the related fields; "Authorisation succeeded, please send your earlier request again"; and the three paragraphs in the tool result that instruct the model on how to relay the state of the invitation.

Step 1 **does not touch**: `tasks.pending`, `tasks.answering`, `task_events`, `unsettled`, the worker's decision record, and their write paths; or the two old rules "wipe the whole turn once outside content was read" and "carry over the previous link, once only" (under section 5.8 of the design document, they are replaced only after step 2 meets the criteria).

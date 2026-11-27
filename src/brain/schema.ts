/** The Brain's tables. All of them live in one Durable Object's SQLite, so one scope = one database. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Every trigger lands here first. (source, source_id) is the dedupe key.
CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  session_key TEXT NOT NULL,
  principal TEXT NOT NULL,
  text TEXT,
  data TEXT,
  reply_to TEXT,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | claimed | done | dead | dropped (by an operator)
  run_id TEXT,
  received_at INTEGER NOT NULL,
  UNIQUE (source, source_id)
);
CREATE INDEX IF NOT EXISTS inbox_status ON inbox (status, id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL UNIQUE,
  target TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- The transcript, as model input items. A run can always be resumed from here.
CREATE TABLE IF NOT EXISTS items (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  item TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,                      -- running | done | failed
  entries INTEGER NOT NULL DEFAULT 0,        -- how many times execution (re)started
  steps INTEGER NOT NULL DEFAULT 0,          -- model calls made
  retry_at INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  error TEXT
);

CREATE TABLE IF NOT EXISTS memory (path TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at INTEGER NOT NULL);

-- A timer never runs the agent. When due it becomes an inbox event.
CREATE TABLE IF NOT EXISTS timers (
  id TEXT PRIMARY KEY,
  due_at INTEGER NOT NULL,
  every_s INTEGER,
  session_key TEXT NOT NULL,
  note TEXT NOT NULL,
  data TEXT,
  status TEXT NOT NULL DEFAULT 'active',     -- active | done | cancelled
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS timers_due ON timers (status, due_at);

-- Work handed to a worker agent. op_id is the tool call that created it, so a retry finds the same row.
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  op_id TEXT NOT NULL UNIQUE,
  worker TEXT NOT NULL,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  session_key TEXT NOT NULL,
  requested_by TEXT,
  status TEXT NOT NULL,                      -- dispatching | unconfirmed | running | needs_input | succeeded | failed | lost | cancelled
  pending TEXT,
  last_progress TEXT,
  result TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS task_events (
  task_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  body TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (task_id, seq)
);

-- Messages to deliver. Written by a run, delivered separately, retried until sent or dead.
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idem TEXT NOT NULL UNIQUE,
  run_id TEXT,
  target TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',    -- pending | sent | dead
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS outbox_status ON outbox (status, next_at);
`;

/**
 * Later changes, applied in order and recorded, so a Brain created by an older deploy catches up
 * the first time it wakes. Never edit an entry that has shipped; add a new one.
 */
export const MIGRATIONS: string[] = [
  // 1: mark user turns so the transcript window can be cut at a turn boundary without parsing JSON.
  `ALTER TABLE items ADD COLUMN is_user INTEGER NOT NULL DEFAULT 0;
   UPDATE items SET is_user = 1 WHERE json_extract(item, '$.role') = 'user';`,
  // 2: the decision being passed to a task, recorded before the worker is called.
  `ALTER TABLE tasks ADD COLUMN answering TEXT;`,
  // 3: an append-only record of decisions and their authors: who asked for work, who approved what.
  `CREATE TABLE audit (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     actor TEXT NOT NULL,
     action TEXT NOT NULL,
     detail TEXT
   );`,
  // 4: the current revision of things people wrote that can be edited or deleted after the fact.
  `CREATE TABLE revisions (subject TEXT PRIMARY KEY, revision INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);`,
  // 5: which text holds that revision, so two revisions with the same timestamp are told apart.
  `ALTER TABLE revisions ADD COLUMN holder TEXT NOT NULL DEFAULT '';`,
  // 6: where a delivered message lives and what it said, when others can change it afterwards.
  `ALTER TABLE outbox ADD COLUMN receipt TEXT;`,
  // 7: what an approval question is about, in parts, for connectors that show more than text.
  `ALTER TABLE outbox ADD COLUMN ask TEXT;`,
  // 8: every code ever given to a question here, so none is given twice.
  `CREATE TABLE used_codes (code TEXT PRIMARY KEY, used_at INTEGER NOT NULL);`,
  // 9: how a question ended, kept with the question so it holds whenever its delivery completes.
  `ALTER TABLE outbox ADD COLUMN closed TEXT;`,
  // 10: set before the first attempt to deliver, so an attempt whose outcome was never heard is known of.
  `ALTER TABLE outbox ADD COLUMN started INTEGER NOT NULL DEFAULT 0;`,
  // 11: questions that were waiting to be delivered when the marker was introduced may already have
  // been attempted, whatever their failure count says (an instance can die between sending and
  // recording). They are all taken as begun: the cost of being wrong is one redundant delivery
  // under the same id, against a card left open.
  `UPDATE outbox SET started = 1 WHERE status = 'pending' AND ask IS NOT NULL;`,
  // 12: an account that is not linked to a tenant user used to be recognised by the form of its
  // id; it is now marked as such by the connector. Mark the ones already stored. GLOB, because the
  // old test was case-sensitive and LIKE is not.
  `UPDATE inbox SET principal = json_set(principal, '$.unlinked', json('true'))
     WHERE source = 'github' AND json_extract(principal, '$.kind') = 'human' AND json_extract(principal, '$.id') GLOB 'github:*';`,
  // 13: questions that stopped being waited on while an answer to them was unconfirmed. How each
  // ended is asked of the worker rather than guessed.
  `CREATE TABLE unsettled (ask TEXT PRIMARY KEY, task_id TEXT NOT NULL, question_id TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL);`,
  // 14: a code review's parts, for connectors that can attach comments to lines.
  `ALTER TABLE outbox ADD COLUMN review TEXT;`,
  // 15: 1 on what a connector tool returned, while its run is under way; 2 on the note that
  // replaces everything such a run produced, once the run has ended.
  `ALTER TABLE items ADD COLUMN outside INTEGER NOT NULL DEFAULT 0;`,
  // 16: a message written in a run that read outside text is blanked once it has been delivered.
  `ALTER TABLE outbox ADD COLUMN private INTEGER NOT NULL DEFAULT 0;`,
  // 17, 18: the lookups made for every run and every tool call.
  `CREATE INDEX items_outside ON items (run_id) WHERE outside = 1;`,
  `CREATE INDEX inbox_run ON inbox (run_id, id);`,
  // 19: requests that could not be carried out yet and are carried on when a condition holds.
  // `id` is the tool call that was told to wait, and stays the name of the request.
  `CREATE TABLE continuations (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     events TEXT NOT NULL,                      -- {said, recent}: inbox ids of the person's messages it rests on
     connector TEXT NOT NULL,
     tool TEXT NOT NULL,
     args TEXT NOT NULL,
     target TEXT NOT NULL,                      -- where its answer goes: as it was when asked
     subject TEXT NOT NULL,
     condition TEXT NOT NULL,
     generation INTEGER NOT NULL,
     interaction TEXT NOT NULL,
     until INTEGER NOT NULL,
     status TEXT NOT NULL,                      -- waiting | resuming | answering | done | failed | cancelled | expired | void
     run_id TEXT,
     call_id TEXT,                              -- the call the continuing run makes in its place
     claimed_at INTEGER,
     check_at INTEGER,                          -- when its condition is next asked about, if its owner could not be asked
     created_at INTEGER NOT NULL,
     ended_at INTEGER,
     why TEXT
   );
   CREATE INDEX continuations_open ON continuations (status, until);`,
  // 20: a message that may only go out while a request still stands, or that shows something to
  // act on; when a message was first tried, to know when a repeat would no longer be dropped; and
  // whether any attempt ended without the outside system saying that nothing was posted. Messages
  // already begun when this is introduced are taken as begun when written and as uncertain: they
  // get no fresh window in which to be repeated.
  `ALTER TABLE outbox ADD COLUMN continuation TEXT;
   ALTER TABLE outbox ADD COLUMN interaction TEXT;
   ALTER TABLE outbox ADD COLUMN first_attempt_at INTEGER;
   ALTER TABLE outbox ADD COLUMN uncertain INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE outbox ADD COLUMN unasked INTEGER NOT NULL DEFAULT 0;
   UPDATE outbox SET first_attempt_at = created_at, uncertain = 1 WHERE started = 1 AND status = 'pending' AND ask IS NULL;`,
  // 21: answers that were delivered to a person about one thing read for them, kept for a short
  // while so that a follow-up can be answered: what was said, what it was read from and on whose
  // request, and a fingerprint of what the source said then. `outbox.source` carries the same
  // from the run that read to the moment of delivery. `outbox.guard` is what a message written
  // after reading may only go out under: the conditions its sources were read under, and a time.
  `CREATE TABLE answers (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     outbox_id INTEGER NOT NULL,
     subject TEXT NOT NULL,
     target TEXT NOT NULL,
     connector TEXT NOT NULL,
     sources TEXT NOT NULL,                     -- every thing it was read from: the call to read it again, what it resolved to, its fingerprint then
     quotes TEXT NOT NULL,                      -- the sentences the answer said it rested on, each found word for word in what was read
     text TEXT NOT NULL,
     expires_at INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   );
   ALTER TABLE outbox ADD COLUMN source TEXT;
   ALTER TABLE outbox ADD COLUMN guard TEXT;`,
  // 22: answers are no longer kept apart for follow-ups, and reopen_answer is gone (see
  // docs/design/follow-up-history.zh-CN.md). What was under way on that footing is closed with
  // what is true of it. A follow-up whose answer was being sent with no word back may have
  // reached the person: it ends as unverified, and its answer is not sent again. Any other open
  // follow-up ends as void, and its answer, not yet handed over, is not sent. A message tied to
  // a reopened answer (its guard has `until`) is not sent either. A run still under way that
  // reopened one is stopped by its guards (Requests.guards takes such a read as retired). The
  // sources once copied onto queued messages are removed; nothing kept is turned into anything else.
  `UPDATE continuations SET status = CASE WHEN status = 'answering' AND EXISTS (SELECT 1 FROM outbox o WHERE o.continuation = continuations.id AND o.started = 1 AND o.uncertain = 1 AND o.status IN ('pending', 'draft')) THEN 'unverified' ELSE 'void' END,
       why = 'follow-ups on kept answers were retired', ended_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
     WHERE tool = 'reopen_answer' AND status IN ('waiting', 'resuming', 'answering');
   UPDATE outbox SET status = CASE WHEN started = 1 AND uncertain = 1 THEN 'unverified' ELSE 'void' END, text = '', review = NULL, error = NULL, guard = NULL
     WHERE status IN ('pending', 'draft')
       AND (continuation IN (SELECT id FROM continuations WHERE tool = 'reopen_answer' AND why = 'follow-ups on kept answers were retired')
            OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(outbox.guard) THEN outbox.guard ELSE '[]' END) WHERE json_extract(value, '$.until') IS NOT NULL));
   UPDATE outbox SET source = NULL WHERE source IS NOT NULL;
   DELETE FROM meta WHERE key LIKE 'quotes:%';
   DROP TABLE answers;`,
  // 23: what the agent actually said to a person in their private conversation: the words of each
  // of its own messages as they were delivered, kept with the conversation's history rather than
  // with the outbox row, and what the run had read by the time the message was written.
  // `outbox.reads` carries the latter from when the message is written to when it is delivered.
  // `outbox.authored` says the words are the agent's own (written by the model), not the system's.
  `CREATE TABLE said (
     outbox_id INTEGER PRIMARY KEY,
     run_id TEXT,
     session_id TEXT NOT NULL,
     text TEXT NOT NULL,
     sent_at INTEGER NOT NULL,
     receipt_subject TEXT,
     reads TEXT NOT NULL DEFAULT '[]'
   );
   CREATE INDEX said_receipt ON said (receipt_subject);
   CREATE INDEX said_run ON said (run_id);
   ALTER TABLE outbox ADD COLUMN reads TEXT;
   ALTER TABLE outbox ADD COLUMN authored INTEGER NOT NULL DEFAULT 0;`,
  // 24: the encoding a message was first sent with, fixed at its first attempt so that a retry
  // sends the very same thing under the same idempotency key. A row whose sending began before
  // this existed was sent with the earlier encoding (0).
  `ALTER TABLE outbox ADD COLUMN wire INTEGER;`,
  // 25: the mark a channel put on a person's message to say it arrived (a reaction's id, say),
  // kept until it has been taken off again once the message was dealt with, and when to try that next.
  `ALTER TABLE inbox ADD COLUMN mark TEXT;
   ALTER TABLE inbox ADD COLUMN mark_attempts INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE inbox ADD COLUMN mark_next_at INTEGER;
   CREATE INDEX inbox_mark ON inbox (status, mark_next_at) WHERE mark IS NOT NULL;`,
  // 26: whose request a waiting request is. Where several people share a conversation, each
  // person's requests are listed, called off and answered apart from everyone else's. Those kept
  // before this are given the writer of the first message they rest on, where it is still on record.
  // A "which one?" already put to a person is carried over to that person, with what it asked
  // about and whether it has been answered. Whose it was is taken from the requests it asked
  // about and from whoever wrote the message that answered it, where all that is on record
  // agrees on one person; where it does not, or says nothing, the question is dropped.
  `ALTER TABLE continuations ADD COLUMN person TEXT;
   UPDATE continuations SET person = (SELECT json_extract(i.principal, '$.id') FROM inbox i WHERE i.id = json_extract(continuations.events, '$.said[0]'));
   INSERT OR IGNORE INTO meta (key, value)
     SELECT m.key || ':' || who.person, m.value FROM meta m JOIN (
       SELECT key, MIN(person) AS person FROM (
         SELECT m2.key AS key, c.person AS person FROM meta m2, json_each(m2.value, '$.ids') j JOIN continuations c ON c.id = j.value WHERE m2.key LIKE 'asked_which:%'
         UNION
         SELECT m3.key, json_extract(i.principal, '$.id') FROM meta m3 JOIN inbox i ON i.id = json_extract(m3.value, '$.chose') WHERE m3.key LIKE 'asked_which:%'
       ) WHERE person IS NOT NULL GROUP BY key HAVING COUNT(DISTINCT person) = 1
     ) who ON who.key = m.key
     WHERE m.key NOT LIKE 'asked_which:%:%';
   DELETE FROM meta WHERE key LIKE 'asked_which:%' AND key NOT LIKE 'asked_which:%:%';`,
  // 27: whether a request's way in was put before the person directly, somewhere else than the
  // request was made. The conversation is then told how that went (see Requests.shown).
  `ALTER TABLE continuations ADD COLUMN direct INTEGER NOT NULL DEFAULT 0;`,
  // 28: a run one of its tools has closed: "settled" (the tool ended the matter itself; nothing
  // more is done in the run) or "waited" (a call of it has to wait; it can only reply and read again).
  `ALTER TABLE runs ADD COLUMN closed TEXT;`,
  // 29: whom an answer was written for: the person the run that wrote it acted for, or whose
  // request it carried on. What it was written from counts, later, only for that same person.
  `ALTER TABLE said ADD COLUMN person TEXT;`,
  // 30: every piece of work handed to a worker, whichever worker: one row under the id the work
  // has where it is carried out (a task's id; the id of the request a connector's tool keeps).
  // An index beside what each worker keeps for itself, which stays where it is. Written, and not
  // read by anything yet: see docs/design/workers.zh-CN.md, step 2. Tasks under way are given
  // their row here; anything else under way gets one when something is next said of it.
  `CREATE TABLE IF NOT EXISTS work (
     id TEXT PRIMARY KEY,
     worker TEXT NOT NULL,
     session_key TEXT NOT NULL,
     person TEXT,
     state TEXT NOT NULL,                     -- open | done | failed | cancelled | expired | void | unknown
     condition TEXT,
     generation INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS work_session ON work (session_key, created_at);
   INSERT OR IGNORE INTO work (id, worker, session_key, person, state, created_at, updated_at)
     SELECT id, worker, session_key, requested_by, 'open', created_at, updated_at FROM tasks WHERE status IN ('dispatching', 'running', 'needs_input');`,
  // 31: whether a piece of work was handed over to its worker, or may have been, as whoever
  // carries it out says: stopping one that was is only to stop waiting for it here.
  `ALTER TABLE work ADD COLUMN handed INTEGER NOT NULL DEFAULT 0;`,
  // 32: tasks whose start was not answered, each to be asked about until it is known whether
  // the worker has it (see Tasks.settle).
  `CREATE TABLE IF NOT EXISTS unconfirmed (
     task_id TEXT PRIMARY KEY,
     attempts INTEGER NOT NULL DEFAULT 0,
     next_at INTEGER NOT NULL
   );`,
  // 33: how far a task may go (how long it may run, how often it may ask the model), fixed as
  // the task is written: its worker, its place with the tenant and its watchdog all go by this.
  // (A table of its own, so that this step can be gone through again without harm.)
  `CREATE TABLE IF NOT EXISTS task_bounds (task_id TEXT PRIMARY KEY, bounds TEXT NOT NULL);`,
  // 34: the earlier task a task goes on from, written with the task once that was found to be
  // allowed: a start made again goes by this, not by what the call says the second time.
  `CREATE TABLE IF NOT EXISTS task_follows (task_id TEXT PRIMARY KEY, from_id TEXT NOT NULL);`,
  // 35: a task put after one that has not ended yet, until it runs: what its worker is to be given,
  // when it was let through to be started (nothing before that), and when to look at it next.
  `CREATE TABLE IF NOT EXISTS task_queued (task_id TEXT PRIMARY KEY, options TEXT NOT NULL, started_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, lease TEXT);`,
  // 36: places with the tenant that are to be given back and were not yet known to have been: tried
  // again by the task's id, so that giving one back never has to be waited for where others wait behind it.
  `CREATE TABLE IF NOT EXISTS task_releases (task_id TEXT PRIMARY KEY, next_at INTEGER NOT NULL, lease TEXT);`,
  // 37: what became of each thing said to work under way, by the call that said it: written as
  // `sent` before the worker is asked, so that a call made again after an answer was lost is not
  // told that nothing was added when something was.
  `CREATE TABLE IF NOT EXISTS task_notes (call_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL);`,
  // 38: what a person's request said was to be done for them once a task it handed over has
  // ended well, written when the task is handed over (before anything is read from outside):
  // which of a connector's tools, and the person's own messages the request was made in
  // (`events`: { said, recent }, inbox ids, as a request that waits keeps them). `request` is
  // the run that handed the task over: every task of that run is of the one request. And the
  // one thing a request has had done in the person's name, claimed before it is done.
  // `task_on`: what a task was given to work on, as the Brain gave it; one that goes on from
  // another is given none and works on what that one did, so it is taken from that one.
  // `repository`: the same, of the task something was to follow. Of the one thing
  // done: which tool and a digest of what it was called with (never the words themselves), and,
  // `sending`, set in the one step that lets it be sent (after which taking it back is too late and
  // is told so), and `result`, set once it has had its end, so that it is not done again.
  `CREATE TABLE IF NOT EXISTS task_then (task_id TEXT PRIMARY KEY, request TEXT NOT NULL, tools TEXT NOT NULL, events TEXT NOT NULL, repository TEXT, withdrawn INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS request_acts (request TEXT PRIMARY KEY, tool TEXT NOT NULL, digest TEXT NOT NULL, sending INTEGER NOT NULL DEFAULT 0, result TEXT, at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS task_on (task_id TEXT PRIMARY KEY, repository TEXT NOT NULL);`,
  // 39: who a message reminds (their ids, fixed when it is kept, so that every attempt at
  // sending it reminds the same people); who asked for a task, whom they named and where, kept with it;
  // whom a drafted answer is to remind, until it is let go; and that a person was reminded of a
  // thing (the message, the task, one firing of a timer), so that they are not reminded of it twice.
  // (Beside the outbox and the tasks, by their keys, as the other things added to tasks are.)
  `CREATE TABLE IF NOT EXISTS outbox_reminds (idem TEXT PRIMARY KEY, mention TEXT, notify TEXT);
   CREATE TABLE IF NOT EXISTS task_asked (task_id TEXT PRIMARY KEY, asked TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS reminded (event TEXT NOT NULL, person TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (event, person));`,
  // 40: a conversation's record read back by time (see History): what people wrote there, and what the agent said there.
  `CREATE INDEX IF NOT EXISTS inbox_session ON inbox (session_key, received_at);
   CREATE INDEX IF NOT EXISTS said_session ON said (session_id, sent_at);`,
  // 41: beside a message that reminds people, the name the one who asked wrote for some of them
  // (by their ids): where the message's own words name the person, a channel puts its mention there.
  `CREATE TABLE IF NOT EXISTS outbox_names (idem TEXT PRIMARY KEY, names TEXT NOT NULL);`,
  // 42: what a task's worker bound it to when it looked at it before it was written (see
  // Worker.prepareStart): the worker's own record, kept as it was given and handed back when the
  // task is started. Beside the task, by its id, as the other things added to tasks are.
  `CREATE TABLE IF NOT EXISTS task_lends (task_id TEXT PRIMARY KEY, record TEXT NOT NULL);`,
];

export function migrate(storage: DurableObjectStorage): void {
  const sql = storage.sql;
  sql.exec(SCHEMA);
  for (;;) {
    const row = sql.exec("SELECT value FROM meta WHERE key = 'schema_version'").toArray()[0] as { value?: string } | undefined;
    const version = Number(row?.value ?? 0);
    if (version >= MIGRATIONS.length) return;
    // A step and its version bump commit together, so a half-applied step is never recorded as done.
    storage.transactionSync(() => {
      sql.exec(MIGRATIONS[version]);
      sql.exec("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(version + 1));
    });
  }
}

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
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | claimed | done | dead
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
  status TEXT NOT NULL,                      -- dispatching | running | needs_input | succeeded | failed | lost | cancelled
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

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
const MIGRATIONS: string[] = [
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

/**
 * The Brain's database, and the few things every part of the Brain does with it. There is one
 * per Brain, shared by all of its parts: they work on the same tables and in the same
 * transactions, so a step that touches several tables is still one step.
 */
import { type InboundEvent, type Scope, parseScope } from "../events";

export type Row = Record<string, any>;

export interface InboxRow {
  id: number;
  source: string;
  source_id: string;
  kind: string;
  session_key: string;
  principal: string;
  text: string | null;
  data: string | null;
  reply_to: string | null;
  received_at: number;
}

export interface RunRow {
  id: string;
  session_id: string;
  status: string;
  entries: number;
  steps: number;
  retry_at: number | null;
  /** Set once a tool of the run closed it: "settled" (nothing more is done in it) or "waited" (it can only reply and read again). */
  closed: string | null;
}

/** The states a task ends in. */
export const TERMINAL_TASK = new Set(["succeeded", "failed", "lost", "cancelled"]);

/** A part of the Brain that can have something to do at a later time. */
export interface Wakes {
  /** When this part next needs the Brain awake (a time in ms, possibly already past), or null if it is waiting for nothing. */
  nextWakeAt(now: number): number | null;
}

export class BrainStore {
  readonly sql: SqlStorage;
  readonly #ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    this.#ctx = ctx;
    this.sql = ctx.storage.sql;
  }

  /** One synchronous step: everything done inside is kept together, or, if it throws, not at all. */
  transaction<T>(step: () => T): T {
    return this.#ctx.storage.transactionSync(step);
  }

  rows<T = Row>(query: string, ...bindings: unknown[]): T[] {
    return this.sql.exec(query, ...(bindings as SqlStorageValue[])).toArray() as unknown as T[];
  }

  meta(key: string): string | undefined {
    return this.rows<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)[0]?.value;
  }

  setMeta(key: string, value: string): void {
    this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  scopeName(): string {
    const name = this.#ctx.id.name;
    if (!name) throw new Error("a Brain must be addressed by name");
    return name;
  }

  scope(): Scope {
    return parseScope(this.scopeName());
  }

  /** Who decided what. Append-only, kept long after the events themselves are gone. */
  audit(actor: string, action: string, detail: Record<string, unknown>): void {
    this.sql.exec("INSERT INTO audit (at, actor, action, detail) VALUES (?, ?, ?, ?)", Date.now(), actor, action, JSON.stringify(detail));
  }

  /** One structured line per thing an operator would want to be alerted on. */
  log(event: string, detail: Record<string, unknown>): void {
    console.log(JSON.stringify({ event, scope: this.#ctx.id.name, ...detail }));
  }

  /** Stores an event unless the same (source, source_id) is already held. Says whether it was stored. */
  insertEvent(event: InboundEvent): boolean {
    // Checked explicitly: rowsWritten also counts index writes, so it cannot tell an insert from an ignore.
    if (this.rows("SELECT 1 FROM inbox WHERE source = ? AND source_id = ?", event.source, event.source_id).length > 0) return false;
    // Only the latest state under a key means anything (see InboundEvent.supersedes). Settled here,
    // as the event is written and only for one that is new: what it supersedes is still waiting
    // (what has been taken up is left alone), and is kept, as dropped. One that comes after a
    // later one under its key was superseded before it arrived.
    const latest = event.supersedes;
    const KEY = "json_extract(data, '$.supersedes.key')";
    const AT = "json_extract(data, '$.supersedes.at')";
    const late = latest !== undefined && this.rows(`SELECT 1 FROM inbox WHERE source = ? AND ${KEY} = ? AND ${AT} > ?`, event.source, latest.key, latest.at).length > 0;
    if (latest && !late) this.sql.exec(`UPDATE inbox SET status = 'dropped' WHERE status = 'pending' AND source = ? AND ${KEY} = ? AND ${AT} <= ?`, event.source, latest.key, latest.at);
    if (latest) event = { ...event, data: { ...event.data, supersedes: { key: latest.key, at: latest.at } } };
    this.sql.exec(
      `INSERT OR IGNORE INTO inbox (source, source_id, kind, session_key, principal, text, data, reply_to, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.source,
      event.source_id,
      event.kind,
      event.session_key,
      JSON.stringify(event.principal),
      event.text ?? null,
      event.data ? JSON.stringify(event.data) : null,
      event.reply_to ? JSON.stringify(event.reply_to) : null,
      Date.now(),
    );
    if (latest && (late || latest.void)) this.sql.exec("UPDATE inbox SET status = 'dropped' WHERE source = ? AND source_id = ?", event.source, event.source_id);
    return true;
  }
}

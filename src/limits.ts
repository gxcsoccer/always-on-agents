/**
 * What a tenant may use: how much it may spend on models in a day, in one scope and in all, and
 * how much work may be under way at once. The figures here are what holds where nothing else
 * was set; a tenant's own are kept by the registry and set by the operator.
 */
export interface Limits {
  /** Tokens one scope (a person's own, a chat, a repository) may spend on models per UTC day, its workers' included. */
  scope_daily_tokens: number;
  /** Tokens the tenant may spend per UTC day, across all of its scopes and sandboxes. */
  tenant_daily_tokens: number;
  /** How many tasks one scope may have under way at once. */
  scope_active_tasks: number;
  /** How many sandbox containers the tenant may run at once. */
  tenant_sandboxes: number;
  /** How many times the model may be asked in one run of the agent, before the run ends as it stands. */
  run_steps: number;
  /** How long a sandbox task may run, in minutes, from when its sandbox took it. */
  task_minutes: number;
  /** How many times the model may be asked within one sandbox task. */
  task_model_calls: number;
}

export const DEFAULT_LIMITS: Limits = {
  scope_daily_tokens: 2_000_000,
  tenant_daily_tokens: 20_000_000,
  scope_active_tasks: 3,
  tenant_sandboxes: 5,
  run_steps: 16,
  task_minutes: 120,
  task_model_calls: 400,
};

/**
 * Tokens set aside against the tenant's day before a call to the model, and corrected to what
 * the call really used after it. A tenant's day that is smaller than this (and not nothing)
 * could never begin a call, so it is not a figure the tenant's day can be set to.
 */
export const MODEL_CALL_RESERVE = 20_000;

/** The most each may be set to: beyond these a figure is a mistake, not a limit. */
export const MOST: Limits = {
  scope_daily_tokens: 1_000_000_000,
  tenant_daily_tokens: 10_000_000_000,
  scope_active_tasks: 50,
  tenant_sandboxes: 100,
  run_steps: 100,
  task_minutes: 480,
  task_model_calls: 5_000,
};

/**
 * The least each may be set to. Nothing is 0 for the four that say how much may be used: that
 * turns the thing off. The rest say how far one run or one task may go, and a run of no steps
 * or a task of no time is not a limit but a mistake; to have no tasks, set how many may be under way.
 */
export const LEAST: Limits = {
  scope_daily_tokens: 0,
  tenant_daily_tokens: 0,
  scope_active_tasks: 0,
  tenant_sandboxes: 0,
  run_steps: 1,
  task_minutes: 5,
  task_model_calls: 1,
};

const NAMES = Object.keys(DEFAULT_LIMITS) as (keyof Limits)[];

/** Limits as kept or as given: each a whole number within its range, and the default where it is absent or anything else. */
export function limitsFrom(value: unknown): Limits {
  const given = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(NAMES.map((name) => [name, valid(name, given[name]) ? (given[name] as number) : DEFAULT_LIMITS[name]])) as unknown as Limits;
}

/**
 * What a change to a tenant's limits comes to: each figure named is set (a whole number from 0
 * to its most) or, given as null, goes back to the default; those not named stay as they are.
 * Throws for a name that is not a limit or a figure that cannot be one.
 */
export function changed(kept: unknown, change: unknown): Partial<Limits> {
  if (!change || typeof change !== "object" || Array.isArray(change)) throw new Error("limits are given as an object of figures");
  const next: Partial<Limits> = Object.fromEntries(NAMES.flatMap((name) => (valid(name, (kept as Record<string, unknown> | null)?.[name]) ? [[name, (kept as Record<string, number>)[name]]] : [])));
  for (const [name, figure] of Object.entries(change as Record<string, unknown>)) {
    if (!NAMES.includes(name as keyof Limits)) throw new Error(`${name} is not a limit; the limits are ${NAMES.join(", ")}`);
    if (figure === null) delete next[name as keyof Limits];
    else if (valid(name as keyof Limits, figure)) next[name as keyof Limits] = figure as number;
    else throw new Error(`${name} must be a whole number from ${LEAST[name as keyof Limits]} to ${MOST[name as keyof Limits]}${name === "tenant_daily_tokens" ? ` (and, unless it is 0, at least ${MODEL_CALL_RESERVE}: that much is set aside before every call to the model)` : ""}, or null for the default`);
  }
  return next;
}

function valid(name: keyof Limits, figure: unknown): boolean {
  if (typeof figure !== "number" || !Number.isInteger(figure) || figure < LEAST[name] || figure > MOST[name]) return false;
  return name !== "tenant_daily_tokens" || figure === 0 || figure >= MODEL_CALL_RESERVE;
}

/** The figures of a tenant's own that were set, as kept: those that are not there hold by default. */
export function overridesFrom(kept: unknown): Partial<Limits> {
  return changed(kept, {});
}

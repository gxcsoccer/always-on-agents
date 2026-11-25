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
}

export const DEFAULT_LIMITS: Limits = {
  scope_daily_tokens: 2_000_000,
  tenant_daily_tokens: 20_000_000,
  scope_active_tasks: 3,
  tenant_sandboxes: 5,
};

/** The most each may be set to: beyond these a figure is a mistake, not a limit. */
const MOST: Limits = {
  scope_daily_tokens: 1_000_000_000,
  tenant_daily_tokens: 10_000_000_000,
  scope_active_tasks: 50,
  tenant_sandboxes: 100,
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
    else throw new Error(`${name} must be a whole number from 0 to ${MOST[name as keyof Limits]}, or null for the default`);
  }
  return next;
}

function valid(name: keyof Limits, figure: unknown): boolean {
  return typeof figure === "number" && Number.isInteger(figure) && figure >= 0 && figure <= MOST[name];
}

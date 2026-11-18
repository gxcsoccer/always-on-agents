/**
 * The tenant registry: who the tenants are, which API key belongs to which tenant, and how external
 * identities (a GitHub App installation, a GitHub login) map onto them. One instance, named
 * "global". Everything tenant-wide that needs a single consistent answer lives here.
 */
import { DurableObject } from "cloudflare:workers";

import type { Env } from "./env";

export interface FeishuApp {
  app_id: string;
  tenant: string;
  app_secret: string;
  encrypt_key: string | null;
  verification_token: string | null;
  /** The bot's own open_id, if known; used to tell an @ of this bot from an @ of another. */
  bot_open_id: string | null;
  token: string | null;
  token_expires_at: number | null;
}

export interface Tenant {
  id: string;
  name: string;
  created_at: number;
}

/** What one tenant may spend on models per UTC day, across all of its scopes and sandboxes. */
const TENANT_DAILY_TOKEN_BUDGET = 20_000_000;
/** How many sandbox containers one tenant may run at once. */
const MAX_TASKS_PER_TENANT = 5;
/** A slot nobody released is reclaimed after this long. */
const SLOT_TTL_MS = 3 * 60 * 60 * 1_000;

export class Registry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS api_keys (hash TEXT PRIMARY KEY, tenant TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS github_installations (installation_id TEXT PRIMARY KEY, tenant TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS identities (
        tenant TEXT NOT NULL, provider TEXT NOT NULL, external_id TEXT NOT NULL, user_id TEXT NOT NULL,
        PRIMARY KEY (tenant, provider, external_id)
      );
      CREATE TABLE IF NOT EXISTS task_slots (task_id TEXT PRIMARY KEY, tenant TEXT NOT NULL, taken_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS feishu_apps (
        app_id TEXT PRIMARY KEY, tenant TEXT NOT NULL, app_secret TEXT NOT NULL, encrypt_key TEXT, verification_token TEXT,
        bot_open_id TEXT, token TEXT, token_expires_at INTEGER
      );
      DROP TABLE IF EXISTS github_tokens;
      CREATE TABLE IF NOT EXISTS tenant_usage (tenant TEXT NOT NULL, day TEXT NOT NULL, tokens INTEGER NOT NULL, PRIMARY KEY (tenant, day));
    `);
  }

  /** Creates the tenant if needed and issues a new API key. The key is returned once and not stored. */
  async createTenant(id: string, name: string): Promise<{ tenant: Tenant; api_key: string }> {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new Error("tenant id must be lowercase letters, digits and hyphens");
    const sql = this.ctx.storage.sql;
    sql.exec("INSERT OR IGNORE INTO tenants (id, name, created_at) VALUES (?, ?, ?)", id, name, Date.now());
    const tenant = sql.exec<Tenant & Record<string, SqlStorageValue>>("SELECT id, name, created_at FROM tenants WHERE id = ?", id).one();
    const secret = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const apiKey = `aoa_${secret}`;
    sql.exec("INSERT INTO api_keys (hash, tenant, created_at) VALUES (?, ?, ?)", await sha256(apiKey), id, Date.now());
    return { tenant: { id: tenant.id, name: tenant.name, created_at: tenant.created_at }, api_key: apiKey };
  }

  async authenticate(apiKey: string): Promise<string | null> {
    if (!apiKey.startsWith("aoa_")) return null;
    const rows = this.ctx.storage.sql.exec<{ tenant: string }>("SELECT tenant FROM api_keys WHERE hash = ?", await sha256(apiKey)).toArray();
    return rows[0]?.tenant ?? null;
  }

  async linkGithubInstallation(installationId: string, tenant: string): Promise<void> {
    this.#requireTenant(tenant);
    this.ctx.storage.sql.exec(
      "INSERT INTO github_installations (installation_id, tenant) VALUES (?, ?) ON CONFLICT(installation_id) DO UPDATE SET tenant = excluded.tenant",
      installationId,
      tenant,
    );
  }

  async tenantForGithubInstallation(installationId: string): Promise<string | null> {
    const rows = this.ctx.storage.sql
      .exec<{ tenant: string }>("SELECT tenant FROM github_installations WHERE installation_id = ?", installationId)
      .toArray();
    return rows[0]?.tenant ?? null;
  }

  async githubInstallations(tenant: string): Promise<string[]> {
    return this.ctx.storage.sql.exec<{ installation_id: string }>("SELECT installation_id FROM github_installations WHERE tenant = ?", tenant).toArray().map((r) => r.installation_id);
  }

  /** Registers (or updates) the Feishu bot app a tenant uses. Its webhook is /v1/feishu/events/<app_id>. */
  async setFeishuApp(tenant: string, app: { app_id: string; app_secret: string; encrypt_key?: string; verification_token?: string; bot_open_id?: string }): Promise<void> {
    this.#requireTenant(tenant);
    if (!/^[A-Za-z0-9_]{1,64}$/.test(app.app_id) || !app.app_secret) throw new Error("app_id and app_secret are required");
    if (!app.encrypt_key) throw new Error("an encrypt_key is required: events are only accepted encrypted and signed");
    const owner = this.ctx.storage.sql.exec<{ tenant: string }>("SELECT tenant FROM feishu_apps WHERE app_id = ?", app.app_id).toArray()[0]?.tenant;
    if (owner && owner !== tenant) throw new Error("that app is registered to another tenant");
    this.ctx.storage.sql.exec(
      `INSERT INTO feishu_apps (app_id, tenant, app_secret, encrypt_key, verification_token, bot_open_id) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(app_id) DO UPDATE SET app_secret = excluded.app_secret, encrypt_key = excluded.encrypt_key,
         verification_token = excluded.verification_token, bot_open_id = excluded.bot_open_id, token = NULL, token_expires_at = NULL`,
      app.app_id,
      tenant,
      app.app_secret,
      app.encrypt_key ?? null,
      app.verification_token ?? null,
      app.bot_open_id ?? null,
    );
  }

  async feishuApp(appId: string): Promise<FeishuApp | null> {
    const row = this.ctx.storage.sql.exec("SELECT * FROM feishu_apps WHERE app_id = ?", appId).toArray()[0] as unknown as FeishuApp | undefined;
    return row ? { ...row } : null;
  }

  async saveFeishuToken(appId: string, token: string, expiresAt: number): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE feishu_apps SET token = ?, token_expires_at = ? WHERE app_id = ?", token, expiresAt, appId);
  }

  /** Records that an external account (e.g. a GitHub login) is this tenant's user. */
  async linkIdentity(tenant: string, provider: string, externalId: string, userId: string): Promise<void> {
    this.#requireTenant(tenant);
    this.ctx.storage.sql.exec(
      "INSERT INTO identities (tenant, provider, external_id, user_id) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET user_id = excluded.user_id",
      tenant,
      provider,
      externalId,
      userId,
    );
  }

  async resolveIdentity(tenant: string, provider: string, externalId: string): Promise<string | null> {
    const rows = this.ctx.storage.sql
      .exec<{ user_id: string }>("SELECT user_id FROM identities WHERE tenant = ? AND provider = ? AND external_id = ?", tenant, provider, externalId)
      .toArray();
    return rows[0]?.user_id ?? null;
  }

  /**
   * Records model tokens a tenant used and says whether it may keep spending today. All tenants
   * share one provider key, so this is what stops one tenant from using up everyone's allowance.
   */
  async recordUsage(tenant: string, tokens: number): Promise<{ allowed: boolean; used: number; budget: number }> {
    const day = new Date().toISOString().slice(0, 10);
    const sql = this.ctx.storage.sql;
    const add = Number.isFinite(tokens) && tokens > 0 ? Math.min(Math.floor(tokens), 1_000_000_000) : 0;
    if (add > 0) {
      sql.exec("INSERT INTO tenant_usage (tenant, day, tokens) VALUES (?, ?, ?) ON CONFLICT(tenant, day) DO UPDATE SET tokens = tokens + excluded.tokens", tenant, day, add);
      sql.exec("DELETE FROM tenant_usage WHERE day < ?", new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10));
    }
    const used = sql.exec<{ tokens: number }>("SELECT tokens FROM tenant_usage WHERE tenant = ? AND day = ?", tenant, day).toArray()[0]?.tokens ?? 0;
    return { allowed: used < TENANT_DAILY_TOKEN_BUDGET, used, budget: TENANT_DAILY_TOKEN_BUDGET };
  }

  /** Reserves a sandbox slot for a tenant, so one tenant's burst cannot take every container. */
  async acquireTaskSlot(tenant: string, taskId: string): Promise<boolean> {
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM task_slots WHERE taken_at < ?", Date.now() - SLOT_TTL_MS);
    if (sql.exec("SELECT 1 FROM task_slots WHERE task_id = ?", taskId).toArray().length > 0) return true;
    const used = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM task_slots WHERE tenant = ?", tenant).one().n;
    if (used >= MAX_TASKS_PER_TENANT) return false;
    sql.exec("INSERT INTO task_slots (task_id, tenant, taken_at) VALUES (?, ?, ?)", taskId, tenant, Date.now());
    return true;
  }

  async releaseTaskSlot(taskId: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM task_slots WHERE task_id = ?", taskId);
  }

  #requireTenant(tenant: string) {
    if (this.ctx.storage.sql.exec("SELECT 1 FROM tenants WHERE id = ?", tenant).toArray().length === 0) {
      throw new Error(`no such tenant: ${tenant}`);
    }
  }
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function registry(env: Env) {
  return env.REGISTRY.getByName("global");
}

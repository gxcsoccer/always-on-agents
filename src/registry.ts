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
  /** How this app's events reach us: Feishu calls our webhook, or we hold a connection open to Feishu. */
  transport: "webhook" | "long_connection";
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
      CREATE TABLE IF NOT EXISTS chat_repos (tenant TEXT NOT NULL, chat TEXT NOT NULL, repo TEXT NOT NULL, PRIMARY KEY (tenant, chat));
      CREATE TABLE IF NOT EXISTS feishu_apps (
        app_id TEXT PRIMARY KEY, tenant TEXT NOT NULL, app_secret TEXT NOT NULL, encrypt_key TEXT, verification_token TEXT,
        bot_open_id TEXT, token TEXT, token_expires_at INTEGER
      );
      DROP TABLE IF EXISTS github_tokens;
      CREATE TABLE IF NOT EXISTS github_repos (repo TEXT PRIMARY KEY, tenant TEXT NOT NULL, secret TEXT);
      CREATE TABLE IF NOT EXISTS tenant_usage (tenant TEXT NOT NULL, day TEXT NOT NULL, tokens INTEGER NOT NULL, PRIMARY KEY (tenant, day));
    `);
    this.#addColumn("github_repos", "secret TEXT");
    this.#addColumn("feishu_apps", "transport TEXT NOT NULL DEFAULT 'webhook'");
  }

  /** Adds a column to a table made by an earlier deploy. A no-op once it exists. */
  #addColumn(table: string, column: string): void {
    const columns = this.ctx.storage.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().map((c) => c.name);
    if (!columns.includes(column.split(" ")[0])) this.ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
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

  /**
   * Registers one repository as a tenant's, for a webhook configured on the repository itself
   * rather than through a GitHub App (such webhooks carry no installation id).
   */
  async linkGithubRepo(repo: string, tenant: string): Promise<{ webhook_secret: string }> {
    this.#requireTenant(tenant);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("repo must be owner/name");
    const sql = this.ctx.storage.sql;
    const existing = sql.exec<{ tenant: string }>("SELECT tenant FROM github_repos WHERE repo = ?", repo.toLowerCase()).toArray()[0];
    if (existing && existing.tenant !== tenant) throw new Error("that repository is registered to another tenant");
    // Each repository gets its own webhook secret. Whoever configures the hook on one repository
    // learns only that repository's secret and cannot sign events in another repository's name.
    const secret = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
    sql.exec("INSERT INTO github_repos (repo, tenant, secret) VALUES (?, ?, ?) ON CONFLICT(repo) DO UPDATE SET secret = excluded.secret", repo.toLowerCase(), tenant, secret);
    return { webhook_secret: secret };
  }

  async githubRepo(repo: string): Promise<{ tenant: string; secret: string | null } | null> {
    const row = this.ctx.storage.sql.exec<{ tenant: string; secret: string | null }>("SELECT tenant, secret FROM github_repos WHERE repo = ?", repo.toLowerCase()).toArray()[0];
    return row ? { tenant: row.tenant, secret: row.secret } : null;
  }

  async githubInstallations(tenant: string): Promise<string[]> {
    return this.ctx.storage.sql.exec<{ installation_id: string }>("SELECT installation_id FROM github_installations WHERE tenant = ?", tenant).toArray().map((r) => r.installation_id);
  }

  /** Registers (or updates) the Feishu bot app a tenant uses. Its webhook is /v1/feishu/events/<app_id>. */
  async setFeishuApp(
    tenant: string,
    app: { app_id: string; app_secret: string; encrypt_key?: string; verification_token?: string; bot_open_id?: string; transport?: "webhook" | "long_connection" },
  ): Promise<void> {
    this.#requireTenant(tenant);
    if (!/^[A-Za-z0-9_]{1,64}$/.test(app.app_id) || !app.app_secret) throw new Error("app_id and app_secret are required");
    const transport = app.transport ?? "webhook";
    if (transport !== "webhook" && transport !== "long_connection") throw new Error("transport must be webhook or long_connection");
    // Over the long connection nothing is delivered to a public address, so there is nothing to
    // encrypt or sign. A webhook is only served encrypted and signed.
    if (transport === "webhook" && !app.encrypt_key) throw new Error("an encrypt_key is required: events are only accepted encrypted and signed");
    const owner = this.ctx.storage.sql.exec<{ tenant: string }>("SELECT tenant FROM feishu_apps WHERE app_id = ?", app.app_id).toArray()[0]?.tenant;
    if (owner && owner !== tenant) throw new Error("that app is registered to another tenant");
    this.ctx.storage.sql.exec(
      `INSERT INTO feishu_apps (app_id, tenant, app_secret, encrypt_key, verification_token, bot_open_id, transport) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(app_id) DO UPDATE SET app_secret = excluded.app_secret, encrypt_key = excluded.encrypt_key,
         verification_token = excluded.verification_token, bot_open_id = excluded.bot_open_id, transport = excluded.transport, token = NULL, token_expires_at = NULL`,
      app.app_id,
      tenant,
      app.app_secret,
      app.encrypt_key ?? null,
      app.verification_token ?? null,
      app.bot_open_id ?? null,
      transport,
    );
  }

  async feishuApp(appId: string): Promise<FeishuApp | null> {
    const row = this.ctx.storage.sql.exec("SELECT * FROM feishu_apps WHERE app_id = ?", appId).toArray()[0] as unknown as FeishuApp | undefined;
    return row ? { ...row } : null;
  }

  /** The apps whose events arrive over a connection we hold open. */
  async feishuLongConnectionApps(): Promise<string[]> {
    return this.ctx.storage.sql.exec<{ app_id: string }>("SELECT app_id FROM feishu_apps WHERE transport = 'long_connection'").toArray().map((row) => row.app_id);
  }

  async saveFeishuToken(appId: string, token: string, expiresAt: number): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE feishu_apps SET token = ?, token_expires_at = ? WHERE app_id = ?", token, expiresAt, appId);
  }

  /** Records that an external account (e.g. a GitHub login) is this tenant's user. */
  async linkIdentity(tenant: string, provider: string, externalId: string, userId: string): Promise<void> {
    this.#requireTenant(tenant);
    // "<system>:<account>" is how an account that is not linked to anyone is named, so no user is.
    // A link that already exists may be made again as it is, whatever it looks like.
    if (userId.includes(":") && (await this.resolveIdentity(tenant, provider, externalId)) !== userId) throw new Error("user_id cannot contain ':'");
    this.ctx.storage.sql.exec(
      "INSERT INTO identities (tenant, provider, external_id, user_id) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET user_id = excluded.user_id",
      tenant,
      provider,
      externalId,
      userId,
    );
  }

  /**
   * Lets one group chat work on one repository: tasks started in that chat are lent the tenant's
   * credential for that repository, as tasks started in the repository's own conversation are.
   * An operator's decision, made per chat. Without it a chat's tasks get no repository credential
   * at all, since a chat can name any repository. Passing no repository removes the link.
   */
  async linkChatRepo(tenant: string, chat: string, repo: string | null): Promise<void> {
    this.#requireTenant(tenant);
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(chat)) throw new Error("chat must be a chat id");
    if (repo === null) {
      this.ctx.storage.sql.exec("DELETE FROM chat_repos WHERE tenant = ? AND chat = ?", tenant, chat);
      return;
    }
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("repo must be owner/name");
    this.ctx.storage.sql.exec("INSERT INTO chat_repos (tenant, chat, repo) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET repo = excluded.repo", tenant, chat, repo.toLowerCase());
  }

  /** The repository a chat's tasks may be lent a credential for, as lowercase owner/name, if any. */
  async chatRepo(tenant: string, chat: string): Promise<string | null> {
    return this.ctx.storage.sql.exec<{ repo: string }>("SELECT repo FROM chat_repos WHERE tenant = ? AND chat = ?", tenant, chat).toArray()[0]?.repo ?? null;
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
  async recordUsage(tenant: string, tokens: number): Promise<{ allowed: boolean; used: number; budget: number; day: string }> {
    const day = new Date().toISOString().slice(0, 10);
    const sql = this.ctx.storage.sql;
    const add = Number.isFinite(tokens) && tokens > 0 ? Math.min(Math.floor(tokens), 1_000_000_000) : 0;
    if (add > 0) {
      sql.exec("INSERT INTO tenant_usage (tenant, day, tokens) VALUES (?, ?, ?) ON CONFLICT(tenant, day) DO UPDATE SET tokens = tokens + excluded.tokens", tenant, day, add);
      sql.exec("DELETE FROM tenant_usage WHERE day < ?", new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10));
    }
    const used = sql.exec<{ tokens: number }>("SELECT tokens FROM tenant_usage WHERE tenant = ? AND day = ?", tenant, day).toArray()[0]?.tokens ?? 0;
    // Allowed if the total, including what was just added, is still within the budget.
    return { allowed: used <= TENANT_DAILY_TOKEN_BUDGET, used, budget: TENANT_DAILY_TOKEN_BUDGET, day };
  }

  /** Corrects a reservation to what was actually used. May be negative; the total never goes below zero. */
  async adjustUsage(tenant: string, delta: number, day: string): Promise<void> {
    // `day` is the day the reservation was made: a call that spans midnight is settled where it was charged.
    if (!Number.isFinite(delta) || delta === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
    this.ctx.storage.sql.exec(
      "INSERT INTO tenant_usage (tenant, day, tokens) VALUES (?, ?, MAX(0, ?)) ON CONFLICT(tenant, day) DO UPDATE SET tokens = MAX(0, tokens + ?)",
      tenant,
      day,
      Math.floor(delta),
      Math.floor(delta),
    );
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

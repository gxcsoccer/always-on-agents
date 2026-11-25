/**
 * The tenant registry: who the tenants are, which API key belongs to which tenant, and how external
 * identities (a GitHub App installation, a GitHub login) map onto them. One instance, named
 * "global". Everything tenant-wide that needs a single consistent answer lives here.
 */
import { DurableObject } from "cloudflare:workers";

import type { Env } from "./env";
import { type Limits, changed, limitsFrom, overridesFrom } from "./limits";

/** Which Doubao app a chat app's people are served with, and how a person is known to be the same on both sides. */
export interface DoubaoApp {
  chat_connector: string;
  chat_app_id: string;
  tenant: string;
  app_id: string;
  app_secret: string;
  match: "union_id" | "open_id";
  /** Names this pairing: changes whenever it is set again. */
  version: string;
}

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
  /**
   * 1 if a person's authorisation code for this app is exchanged at Feishu's older token endpoint.
   * Off unless an operator turns it on for this app. See TOKEN_V2 in connectors/feishu-docs.ts.
   */
  oauth_v2: number;
  /**
   * 1 if people are asked for `offline_access` too, so that their authorisation can be renewed
   * without them. Off unless an operator turns it on: the app must have that permission enabled
   * and published in Feishu first, or the consent page fails.
   */
  oauth_offline: number;
  /**
   * 1 if a person's documents may be read for them where several people talk (a group that is
   * the organisation's own), and answered there. Off unless an operator turns it on.
   */
  group_documents?: number;
  /** Counts every change of `group_documents`: what was read while it was on one time is not let out under another. */
  group_documents_gen?: number;
}

export interface Tenant {
  id: string;
  name: string;
  created_at: number;
}

/** A slot nobody released is reclaimed after this long. */
const SLOT_TTL_MS = 3 * 60 * 60 * 1_000;

export class Registry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS api_keys (hash TEXT PRIMARY KEY, tenant TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tenant_limits (tenant TEXT PRIMARY KEY, limits TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS github_installations (installation_id TEXT PRIMARY KEY, tenant TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS identities (
        tenant TEXT NOT NULL, provider TEXT NOT NULL, external_id TEXT NOT NULL, user_id TEXT NOT NULL,
        PRIMARY KEY (tenant, provider, external_id)
      );
      CREATE TABLE IF NOT EXISTS task_slots (task_id TEXT PRIMARY KEY, tenant TEXT NOT NULL, taken_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_repos (tenant TEXT NOT NULL, chat TEXT NOT NULL, repo TEXT NOT NULL, PRIMARY KEY (tenant, chat));
      CREATE TABLE IF NOT EXISTS doubao_apps (
        chat_app_id TEXT PRIMARY KEY, chat_connector TEXT NOT NULL, tenant TEXT NOT NULL, app_id TEXT NOT NULL, app_secret TEXT NOT NULL,
        match TEXT NOT NULL, version TEXT NOT NULL
      );
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
    this.#addColumn("feishu_apps", "oauth_v2 INTEGER NOT NULL DEFAULT 0");
    this.#addColumn("feishu_apps", "oauth_offline INTEGER NOT NULL DEFAULT 0");
    this.#addColumn("feishu_apps", "group_documents INTEGER NOT NULL DEFAULT 0");
    this.#addColumn("feishu_apps", "group_documents_gen INTEGER NOT NULL DEFAULT 0");
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

  /** Which Doubao app the people of one chat app are served with, if the operator set one. */
  async doubaoApp(chatAppId: string): Promise<DoubaoApp | null> {
    return (this.ctx.storage.sql.exec("SELECT * FROM doubao_apps WHERE chat_app_id = ?", chatAppId).toArray()[0] as unknown as DoubaoApp | undefined) ?? null;
  }

  /** Whether a chat app is paired at all: for those who need to know that and none of the rest. */
  async doubaoPaired(chatAppId: string): Promise<boolean> {
    return this.ctx.storage.sql.exec("SELECT 1 FROM doubao_apps WHERE chat_app_id = ?", chatAppId).toArray().length > 0;
  }

  /**
   * Pairs a registered chat app with a Doubao app. Each setting is a new pairing with its own
   * version: an authorisation begun or given under an earlier one does not count under this one.
   */
  async setDoubaoApp(pair: Pick<DoubaoApp, "chat_connector" | "chat_app_id" | "app_id" | "app_secret" | "match">): Promise<DoubaoApp | null> {
    const chat = await this.feishuApp(pair.chat_app_id);
    if (!chat) return null;
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO doubao_apps (chat_app_id, chat_connector, tenant, app_id, app_secret, match, version) VALUES (?, ?, ?, ?, ?, ?, ?)", pair.chat_app_id, pair.chat_connector, chat.tenant, pair.app_id, pair.app_secret, pair.match, crypto.randomUUID());
    return this.doubaoApp(pair.chat_app_id);
  }

  async removeDoubaoApp(chatAppId: string): Promise<boolean> {
    return this.ctx.storage.sql.exec("DELETE FROM doubao_apps WHERE chat_app_id = ? RETURNING chat_app_id", chatAppId).toArray().length > 0;
  }

  /**
   * Sets, for one registered app, how people's authorisations are obtained: which of Feishu's
   * token endpoints is used, and whether leave to renew (`offline_access`) is asked for. What is
   * not given is left as it is. Returns the settings, or nothing for an unknown app.
   */
  async setFeishuOauth(appId: string, change: { token_endpoint?: "v2" | "v3"; offline_access?: boolean; group_documents?: boolean }): Promise<{ token_endpoint: "v2" | "v3"; offline_access: boolean; group_documents: boolean } | null> {
    if (change.group_documents !== undefined && typeof change.group_documents !== "boolean") throw new Error("group_documents must be true or false");
    if (change.token_endpoint !== undefined && change.token_endpoint !== "v2" && change.token_endpoint !== "v3") throw new Error("token_endpoint must be v2 or v3");
    if (change.offline_access !== undefined && typeof change.offline_access !== "boolean") throw new Error("offline_access must be true or false");
    if (!(await this.feishuApp(appId))) return null;
    if (change.token_endpoint !== undefined) this.ctx.storage.sql.exec("UPDATE feishu_apps SET oauth_v2 = ? WHERE app_id = ?", change.token_endpoint === "v2" ? 1 : 0, appId);
    if (change.offline_access !== undefined) this.ctx.storage.sql.exec("UPDATE feishu_apps SET oauth_offline = ? WHERE app_id = ?", change.offline_access ? 1 : 0, appId);
    // Only a change counts: setting it to what it is leaves what was read under it as it was.
    if (change.group_documents !== undefined) this.ctx.storage.sql.exec("UPDATE feishu_apps SET group_documents = ?, group_documents_gen = group_documents_gen + 1 WHERE app_id = ? AND group_documents != ?", change.group_documents ? 1 : 0, appId, change.group_documents ? 1 : 0);
    const app = (await this.feishuApp(appId))!;
    return { token_endpoint: app.oauth_v2 ? "v2" : "v3", offline_access: Boolean(app.oauth_offline), group_documents: Boolean(app.group_documents) };
  }

  /** The apps whose events arrive over a connection we hold open. */
  async feishuLongConnectionApps(): Promise<string[]> {
    return this.ctx.storage.sql.exec<{ app_id: string }>("SELECT app_id FROM feishu_apps WHERE transport = 'long_connection'").toArray().map((row) => row.app_id);
  }

  /** Forgets the app's token, but only if it is still this one: one renewed meanwhile is kept. */
  async forgetFeishuToken(appId: string, token: string): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE feishu_apps SET token = NULL, token_expires_at = NULL WHERE app_id = ? AND token = ?", appId, token);
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
  /** What a tenant may use: its own figures where the operator set them, the defaults elsewhere. */
  async limits(tenant: string): Promise<{ limits: Limits; overrides: Partial<Limits> } | null> {
    if (this.ctx.storage.sql.exec("SELECT 1 FROM tenants WHERE id = ?", tenant).toArray().length === 0) return null;
    return { limits: this.#limits(tenant), overrides: overridesFrom(this.#kept(tenant)) };
  }

  /** Sets some of a tenant's limits (null: back to the default) and says what holds then. See `changed`. */
  async setLimits(tenant: string, change: unknown): Promise<{ limits: Limits; overrides: Partial<Limits> } | { error: string; missing?: true }> {
    const sql = this.ctx.storage.sql;
    if (sql.exec("SELECT 1 FROM tenants WHERE id = ?", tenant).toArray().length === 0) return { error: "no such tenant", missing: true };
    // Read apart from the check below: failing to read what is kept is something going wrong here, not a mistake in what was asked.
    const kept = this.#kept(tenant);
    let next: Partial<Limits>;
    try {
      next = changed(kept, change);
    } catch (err) {
      // What was asked for is not a change that can be made: said as that, apart from anything going wrong here.
      return { error: err instanceof Error ? err.message : String(err) };
    }
    if (Object.keys(next).length === 0) sql.exec("DELETE FROM tenant_limits WHERE tenant = ?", tenant);
    else sql.exec("INSERT INTO tenant_limits (tenant, limits, updated_at) VALUES (?, ?, ?) ON CONFLICT(tenant) DO UPDATE SET limits = excluded.limits, updated_at = excluded.updated_at", tenant, JSON.stringify(next), Date.now());
    return { limits: this.#limits(tenant), overrides: next };
  }

  #kept(tenant: string): unknown {
    const kept = this.ctx.storage.sql.exec<{ limits: string }>("SELECT limits FROM tenant_limits WHERE tenant = ?", tenant).toArray()[0]?.limits;
    try {
      return kept ? JSON.parse(kept) : null;
    } catch {
      return null;
    }
  }

  #limits(tenant: string): Limits {
    return limitsFrom(this.#kept(tenant));
  }

  /**
   * Counts tokens against the tenant's day and says whether it is still within what it may
   * spend; with it, the tenant's limits as they stand, for the scope that asked to go by.
   */
  async recordUsage(tenant: string, tokens: number): Promise<{ allowed: boolean; used: number; budget: number; day: string; limits: Limits }> {
    const day = new Date().toISOString().slice(0, 10);
    const sql = this.ctx.storage.sql;
    const add = Number.isFinite(tokens) && tokens > 0 ? Math.min(Math.floor(tokens), 1_000_000_000) : 0;
    if (add > 0) {
      sql.exec("INSERT INTO tenant_usage (tenant, day, tokens) VALUES (?, ?, ?) ON CONFLICT(tenant, day) DO UPDATE SET tokens = tokens + excluded.tokens", tenant, day, add);
      sql.exec("DELETE FROM tenant_usage WHERE day < ?", new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10));
    }
    const used = sql.exec<{ tokens: number }>("SELECT tokens FROM tenant_usage WHERE tenant = ? AND day = ?", tenant, day).toArray()[0]?.tokens ?? 0;
    // Allowed if the total, including what was just added, is still within the budget.
    const limits = this.#limits(tenant);
    // A reservation is taken if the day, with it, is still within the limit. Asked with nothing to
    // add ("may another call begin?"), a day that is used up says no: also one whose limit is nothing.
    return { allowed: add > 0 ? used <= limits.tenant_daily_tokens : used < limits.tenant_daily_tokens, used, budget: limits.tenant_daily_tokens, day, limits };
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
    if (used >= this.#limits(tenant).tenant_sandboxes) return false;
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

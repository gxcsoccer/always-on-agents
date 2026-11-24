/**
 * Calls to Feishu that more than one part of the connector makes: the app's own token, and a
 * message from the bot straight to one person.
 */
import type { Env } from "../env";
import { registry } from "../registry";

export const API = "https://open.feishu.cn/open-apis";

/** Feishu's token endpoint. It checks the PKCE verifier against the challenge sent at authorisation. */
export const TOKEN_V3 = "https://accounts.feishu.cn/oauth/v3/token";
/**
 * Feishu's older token endpoint, used only for an app the operator has switched to it (see
 * `oauth_v2` in the registry). Feishu's authorisation page says to pair PKCE with this one for
 * now; its notes also say this one does not refuse a verifier when no challenge is held for the
 * code. So on this endpoint a successful exchange does not show that the verifier was checked.
 * Request and response are the same.
 */
export const TOKEN_V2 = "https://open.feishu.cn/open-apis/authen/v2/oauth/token";

/** Forgets a tenant_access_token Feishu no longer takes, so that the next one asked for is fresh. A newer one is kept. */
export async function forgetTenantAccessToken(env: Env, appId: string, token: string): Promise<void> {
  await registry(env).forgetFeishuToken(appId, token);
}

/** The app's tenant_access_token, cached in the registry until shortly before it expires. `signal` stops a request for a new one. */
export async function tenantAccessToken(env: Env, appId: string, signal?: AbortSignal): Promise<string> {
  const app = await registry(env).feishuApp(appId);
  if (!app) throw new Error("unknown Feishu app");
  if (app.token && app.token_expires_at && app.token_expires_at - Date.now() > 5 * 60_000) return app.token;
  const response = await fetch(`${API}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: app.app_id, app_secret: app.app_secret }),
    // Given up when whoever asked no longer waits for it.
    ...(signal ? { signal } : {}),
  });
  const result = (await response.json().catch(() => ({}))) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
  if (!response.ok || result.code !== 0 || !result.tenant_access_token) throw new Error(`Feishu token request failed: ${response.status} code ${result.code} ${String(result.msg).slice(0, 200)}`);
  await registry(env).saveFeishuToken(appId, result.tenant_access_token, Date.now() + (result.expire ?? 0) * 1_000);
  return result.tenant_access_token;
}

/**
 * Sends one message from the bot to one person, in their direct chat with it. `idem` names the
 * message: Feishu drops a repeat of the same one within an hour, so this is safe to call twice.
 */
export async function sendToPerson(env: Env, appId: string, openId: string, idem: string, message: { text: string } | { card: unknown }): Promise<void> {
  const token = await tenantAccessToken(env, appId);
  const response = await fetch(`${API}/im/v1/messages?receive_id_type=open_id`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      receive_id: openId,
      msg_type: "card" in message ? "interactive" : "text",
      content: JSON.stringify("card" in message ? message.card : { text: message.text }),
      uuid: (await hex(idem)).slice(0, 40),
    }),
  });
  const result = (await response.json().catch(() => ({}))) as { code?: number; msg?: string };
  if (!response.ok || result.code !== 0) throw new Error(`Feishu returned ${response.status} code ${result.code}: ${String(result.msg).slice(0, 200)}`);
}

export async function hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

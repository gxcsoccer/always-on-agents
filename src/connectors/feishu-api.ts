/**
 * Calls to Feishu that more than one part of the connector makes: the app's own token, and a
 * message from the bot straight to one person.
 */
import type { Env } from "../env";
import { registry } from "../registry";

export const API = "https://open.feishu.cn/open-apis";

/** The app's tenant_access_token, cached in the registry until shortly before it expires. */
export async function tenantAccessToken(env: Env, appId: string): Promise<string> {
  const app = await registry(env).feishuApp(appId);
  if (!app) throw new Error("unknown Feishu app");
  if (app.token && app.token_expires_at && app.token_expires_at - Date.now() > 5 * 60_000) return app.token;
  const response = await fetch(`${API}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: app.app_id, app_secret: app.app_secret }),
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

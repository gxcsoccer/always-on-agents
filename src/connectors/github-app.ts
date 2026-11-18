/**
 * GitHub App credentials: short-lived tokens issued per installation and narrowed to one repository.
 *
 * This is what keeps tenants apart on GitHub. A token is minted from an installation that belongs
 * to the tenant, and GitHub itself refuses to issue it for a repository the installation does not
 * cover. Nothing here can reach a repository of another tenant, whatever a task asks for.
 *
 * NOT YET VERIFIED AGAINST A REAL GITHUB APP. The JWT construction is tested (the signature
 * verifies against the public key); the token exchange follows GitHub's documented API.
 */
import type { Env } from "../env";
import { registry } from "../registry";

const API = "https://api.github.com";

/**
 * A token good for one repository, or undefined if the tenant has no installation that covers it.
 *
 * A half-configured App (an id without a key, or the reverse) yields nothing rather than falling
 * back to a broader credential. The deployment-wide GITHUB_TOKEN is used only when no App is
 * configured at all, which is the local-development setup.
 */
export async function githubTokenFor(env: Env, tenant: string, repo: string): Promise<{ token: string; expires_at: number } | undefined> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return undefined;
  if (!env.GITHUB_APP_ID && !env.GITHUB_APP_PRIVATE_KEY) return env.GITHUB_TOKEN ? { token: env.GITHUB_TOKEN, expires_at: Date.now() + 60 * 60_000 } : undefined;
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) return undefined;

  const jwt = await appJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  for (const installation of await registry(env).githubInstallations(tenant)) {
    const response = await fetch(`${API}/app/installations/${encodeURIComponent(installation)}/access_tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "user-agent": "always-on-agent", "content-type": "application/json" },
      // Narrowed to the one repository and to what the agent does: read and push code, comment.
      body: JSON.stringify({ repositories: [repo.split("/")[1]], permissions: { contents: "write", pull_requests: "write", issues: "write" } }),
    });
    // 422 means this installation does not cover a repository of that name; another one might.
    if (response.status === 422 || response.status === 404) continue;
    if (!response.ok) throw new Error(`GitHub refused to issue a token: ${response.status}`);
    const body = (await response.json()) as { token: string; expires_at: string; repositories?: { full_name?: string }[] };
    // The request names the repository without its owner. Check the token is for the one we mean:
    // two owners can each have a repository of the same name.
    // and it must be for that repository alone.
    if (body.repositories?.length !== 1 || body.repositories[0].full_name?.toLowerCase() !== repo.toLowerCase()) continue;
    return { token: body.token, expires_at: Date.parse(body.expires_at) };
  }
  return undefined;
}

/** The App's own identity: a JWT signed with its private key, valid for a few minutes. */
export async function appJwt(appId: string, privateKeyPem: string, now = Date.now()): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", pemToPkcs8(privateKeyPem).buffer as ArrayBuffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const seconds = Math.floor(now / 1_000);
  // Issued a minute in the past to tolerate clock drift, as GitHub recommends.
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 9 * 60, iss: appId }))}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64url(new Uint8Array(signature))}`;
}

/**
 * GitHub hands out the key as PKCS#1 ("BEGIN RSA PRIVATE KEY"); WebCrypto only imports PKCS#8.
 * A PKCS#8 key is the PKCS#1 key wrapped in a small fixed header, so wrap it instead of asking
 * operators to convert the file.
 */
export function pemToPkcs8(pem: string): Uint8Array {
  const der = Uint8Array.from(atob(pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  if (!pem.includes("BEGIN RSA PRIVATE KEY")) return der;
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]; // rsaEncryption, NULL
  const key = [0x04, ...derLength(der.length), ...der]; // OCTET STRING
  const content = [0x02, 0x01, 0x00, ...algorithm, ...key]; // version 0
  return Uint8Array.from([0x30, ...derLength(content.length), ...content]);
}

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function base64url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

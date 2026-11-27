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
export async function githubTokenFor(env: Env, tenant: string, repo: string, to: "write" | "read" | "public" = "write"): Promise<{ token: string; expires_at: number; installation?: string } | undefined> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return undefined;
  // One that can only read is never the deployment's own token, which can do whatever it was made for.
  if (!env.GITHUB_APP_ID && !env.GITHUB_APP_PRIVATE_KEY) return env.GITHUB_TOKEN && to === "write" ? { token: env.GITHUB_TOKEN, expires_at: Date.now() + 60 * 60_000 } : undefined;
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) return undefined;

  const jwt = await appJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  for (const installation of await registry(env).githubInstallations(tenant)) {
    const response = await fetch(`${API}/app/installations/${encodeURIComponent(installation)}/access_tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "user-agent": "always-on-agent", "content-type": "application/json" },
      // Narrowed to the one repository and to what the agent does: read and push code, comment.
      // Or, asked for to read with: the same three, to read only.
      // Or "public": allowed nothing but what every token of an installation is (to see that the
      // repository is there). GitHub answers it for what anyone may read of a public repository
      // (its issues, its pull requests, the search of them), counted as its own and not against
      // an address shared with strangers; of a private one it gives it none of those. (Seen
      // against GitHub itself on 2026-11-27.)
      body: JSON.stringify({ repositories: [repo.split("/")[1]], permissions: to === "public" ? { metadata: "read" } : { contents: to, pull_requests: to, issues: to } }),
    });
    // 422 means this installation does not cover a repository of that name; another one might.
    if (response.status === 422 || response.status === 404) continue;
    if (!response.ok) throw new Error(`GitHub refused to issue a token: ${response.status}`);
    const body = (await response.json()) as { token: string; expires_at: string; repositories?: { full_name?: string; private?: unknown; visibility?: unknown }[] };
    // The request names the repository without its owner. Check the token is for the one we mean:
    // two owners can each have a repository of the same name.
    // and it must be for that repository alone.
    if (body.repositories?.length !== 1 || body.repositories[0].full_name?.toLowerCase() !== repo.toLowerCase()) continue;
    // One for what anyone may read is for a repository anyone may read: GitHub says with the token
    // whether it is. Of one that is not public it would be given nothing of the issues anyway, but
    // how it is turned away (and against which count) would tell a private repository that is
    // there from one that is not. None, then, and the read is as a stranger's. (One made private
    // after this is no longer answered for by GitHub itself.)
    if (to === "public" && (body.repositories[0].private !== false || (body.repositories[0].visibility !== undefined && body.repositories[0].visibility !== "public"))) continue;
    // Which installation it came from is kept with it: that installation may be given to another tenant later.
    return { token: body.token, expires_at: Date.parse(body.expires_at), installation };
  }
  return undefined;
}

/**
 * Whether a credential issued for a tenant is still that tenant's to use. One issued through the
 * App is, while the installation it came from is the tenant's; one that does not say which
 * installation that was (an earlier version kept them so) is not known to be, and is asked for
 * again. The deployment's own token, of local development, comes from no installation.
 */
export async function fromTheirs(source: string, installation: string | undefined, tenant: string, tenantOf: (installation: string) => Promise<string | null>): Promise<boolean> {
  if (installation === undefined) return source === "token";
  return (await tenantOf(installation)) === tenant;
}

/**
 * Whether a task is lent a credential of the tenant's for a repository: decided here, by the
 * connector that issues it, from where the task was started (the scope name of its Brain) and,
 * where one person is established to have asked for it, who.
 *
 * Lent in the repository's own conversation (which exists only because GitHub delivered a signed
 * event for it under this tenant's installation), or in a group chat an operator has linked to
 * this very repository. A task started anywhere else can name any repository, so it is lent none
 * and reads only what is public: being in a tenant is not having access to all of its code. One
 * that is allowed nothing ("public") is lent to any task of the tenant's.
 *
 * Looked up each time it is asked, so removing a chat's link stops the lending at once.
 * (Who asked changes nothing yet: it is what a person's own authorisation will be lent by.)
 */
export async function lendsTo(env: Env, task: { scope: string; by?: string }, repo: string, to: "write" | "read" | "public"): Promise<boolean> {
  // (However its name is written: a caller need not have made it lower case. None for no name.)
  const wanted = repo.toLowerCase();
  if (wanted === "") return false;
  if (to === "public") return true;
  const [tenant, kind, ...rest] = task.scope.split(":");
  const id = rest.join(":");
  if (kind === "repo") return id.toLowerCase() === wanted;
  return kind === "chat" && (await registry(env).chatRepo(tenant, id)) === wanted;
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

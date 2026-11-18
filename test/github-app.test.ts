import { describe, expect, it } from "vitest";

import { appJwt, pemToPkcs8 } from "../src/connectors/github-app";

const pem = (label: string, der: Uint8Array) => `-----BEGIN ${label}-----\n${btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n")}\n-----END ${label}-----\n`;
const fromBase64url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function keyPair() {
  const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { pair, pkcs8: new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer) };
}

describe("GitHub App identity", () => {
  it("signs a short-lived JWT that verifies against the App's public key", async () => {
    const { pair, pkcs8 } = await keyPair();
    const now = 1_800_000_000_000;
    const jwt = await appJwt("12345", pem("PRIVATE KEY", pkcs8), now);
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(new TextDecoder().decode(fromBase64url(header)))).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(payload)));
    expect(claims.iss).toBe("12345");
    expect(claims.iat).toBe(now / 1_000 - 60);
    // GitHub rejects a JWT valid for more than ten minutes.
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pair.publicKey, fromBase64url(signature), new TextEncoder().encode(`${header}.${payload}`))).toBe(true);
  });

  it("accepts the PKCS#1 key file that GitHub hands out", async () => {
    const { pair, pkcs8 } = await keyPair();
    // A PKCS#8 RSA key is a fixed 26-byte header followed by the PKCS#1 key (for a 2048-bit key).
    const pkcs1 = pkcs8.slice(26);
    expect([...pemToPkcs8(pem("RSA PRIVATE KEY", pkcs1))]).toEqual([...pkcs8]);
    const jwt = await appJwt("1", pem("RSA PRIVATE KEY", pkcs1));
    const [header, payload, signature] = jwt.split(".");
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pair.publicKey, fromBase64url(signature), new TextEncoder().encode(`${header}.${payload}`))).toBe(true);
  });
});

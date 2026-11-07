/**
 * PKCE (RFC 7636) helpers. The extension can never hold a client secret safely, so every
 * authorization uses Authorization Code + PKCE: the server mints a verifier, sends only its
 * S256 challenge to the provider, and proves possession of the verifier at token exchange.
 */
import { createHash, randomBytes } from "node:crypto";

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createVerifier(): string {
  return b64url(randomBytes(32)); // 43 chars, within the 43–128 spec range
}

export function challengeFor(verifier: string): string {
  return b64url(createHash("sha256").update(verifier).digest());
}

export function randomState(): string {
  return b64url(randomBytes(24));
}

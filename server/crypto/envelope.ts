/**
 * Envelope encryption for OAuth tokens at rest — the "not E2EE, and we say so" design from
 * README.md and db/schema.sql.
 *
 * Model:
 *   - A per-connection Data Encryption Key (DEK) encrypts the token with AES-256-GCM.
 *   - The DEK is derived from the master key + a random per-connection id via HKDF, so it is
 *     never itself stored. `data_key_id` (a column in oauth_connections) is that random id.
 *   - In production the master key lives in KMS and the DEK is wrapped by a KMS call instead
 *     of HKDF; the ciphertext format below is unchanged, so that swap is local to this file.
 *
 * Ciphertext layout stored in the `bytea` column:  [12-byte IV][16-byte GCM tag][ciphertext]
 *
 * Plaintext tokens exist only in memory, inside the sync path, and are never logged or
 * returned to any client — enforced by oauth_connections having no client-role SELECT policy.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { config } from "../config.ts";

const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

function masterKey(): Buffer {
  if (!config.masterKey) {
    throw new Error(
      "MASTER_KEY is not set. Generate one with:  node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
    );
  }
  const key = Buffer.from(config.masterKey, "base64");
  if (key.length !== KEY_LEN) throw new Error(`MASTER_KEY must be 32 bytes base64 (got ${key.length})`);
  return key;
}

function deriveDek(dataKeyId: string): Buffer {
  // HKDF-SHA256(master, salt=dataKeyId, info="pcc-oauth-dek") -> 32-byte DEK.
  return Buffer.from(hkdfSync("sha256", masterKey(), Buffer.from(dataKeyId), Buffer.from("pcc-oauth-dek"), KEY_LEN));
}

/** Create a fresh random data-key id for a new connection. Store it in `data_key_id`. */
export function newDataKeyId(): string {
  return randomBytes(16).toString("hex");
}

export function encryptToken(plaintext: string, dataKeyId: string): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", deriveDek(dataKeyId), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

export function decryptToken(blob: Buffer, dataKeyId: string): string {
  // A blob too short to hold a full tag would let a shortened tag through.
  if (blob.length < IV_LEN + TAG_LEN) throw new Error("Encrypted value is malformed");
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", deriveDek(dataKeyId), iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

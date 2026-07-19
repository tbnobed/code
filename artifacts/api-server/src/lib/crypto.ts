import crypto from "node:crypto";

/**
 * At-rest encryption for user credentials (GitHub PATs) stored in Postgres.
 * AES-256-GCM with a key derived from SESSION_SECRET — a DB dump alone must
 * not yield usable tokens. Format: "v1:<iv>:<authTag>:<ciphertext>" (base64).
 *
 * If SESSION_SECRET is rotated, existing ciphertexts stop decrypting; callers
 * treat that as "not connected" and the user re-enters their token.
 */

let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (!cachedKey) {
    const secret = process.env.SESSION_SECRET;
    if (!secret) {
      throw new Error("SESSION_SECRET must be set to store encrypted credentials");
    }
    cachedKey = crypto.scryptSync(secret, "forge-credential-encryption-v1", 32);
  }
  return cachedKey;
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

export function decryptSecret(stored: string): string | null {
  try {
    const [v, ivB64, tagB64, ctB64] = stored.split(":");
    if (v !== "v1" || !ivB64 || !tagB64 || !ctB64) return null;
    const tag = Buffer.from(tagB64, "base64");
    if (tag.length !== 16) return null; // full 128-bit tag required
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"), {
      authTagLength: 16,
    });
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null; // rotated SESSION_SECRET or corrupt value — treat as disconnected
  }
}

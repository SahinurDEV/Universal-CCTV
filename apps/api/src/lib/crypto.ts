import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { loadEnv } from "../env.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function getKey(): Buffer {
  const env = loadEnv();
  return Buffer.from(env.CREDENTIAL_ENCRYPTION_KEY, "hex");
}

export interface EncryptedPayload {
  ciphertext: string; // base64, includes the auth tag appended
  iv: string; // base64
}

/**
 * Encrypts a camera credential (e.g. a JSON blob of {username, password}) at
 * rest. Never log the plaintext input or the key. The auth tag is appended to
 * the ciphertext so decrypt() only needs ciphertext + iv to verify integrity.
 */
export function encryptSecret(plaintext: string): EncryptedPayload {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: Buffer.concat([encrypted, authTag]).toString("base64"),
    iv: iv.toString("base64"),
  };
}

export function decryptSecret(payload: EncryptedPayload): string {
  const raw = Buffer.from(payload.ciphertext, "base64");
  const authTag = raw.subarray(raw.length - 16);
  const encrypted = raw.subarray(0, raw.length - 16);
  const iv = Buffer.from(payload.iv, "base64");

  const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}

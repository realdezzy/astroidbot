import crypto from "node:crypto";
import { ConfigManager } from "../config.js";

const ALGORITHM = "aes-256-gcm";
export const IV_LENGTH = 12;
export const AUTH_TAG_LENGTH = 16;
export const KEY_LENGTH = 32;

export function encryptWithKey(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  let encrypted = cipher.update(plaintext, "utf8");
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const authTag = cipher.getAuthTag();

  const result = Buffer.concat([iv, encrypted, authTag]);

  return result.toString("base64");
}

export function decryptWithKey(ciphertext: string, key: Buffer): string {
  const data = Buffer.from(ciphertext, "base64");

  if (data.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Invalid ciphertext: too short");
  }

  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(data.length - AUTH_TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH, data.length - AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  decipher.setAuthTag(authTag);

  try {
    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    throw new Error(
      "Decryption failed: wrong key or corrupted ciphertext"
    );
  }
}

function getKey(): Buffer {
  const keyB64 = ConfigManager.getInstance().config.AES_KEY;
  const masterKey = Buffer.from(keyB64, "base64");

  if (masterKey.length !== KEY_LENGTH) {
    throw new Error(
      `AES_KEY must decode to exactly ${KEY_LENGTH} bytes (got ${masterKey.length}). Provide a base64-encoded 32-byte key.`
    );
  }

  // Derive actual AES-256 key securely using HKDF
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      masterKey,
      Buffer.from("astroidbot-salt"),
      Buffer.from("wallet-encryption"),
      KEY_LENGTH
    )
  );
}

export function encrypt(plaintext: string): string {
  return encryptWithKey(plaintext, getKey());
}

export function decrypt(ciphertext: string): string {
  try {
    return decryptWithKey(ciphertext, getKey());
  } catch (err) {
    // Fallback to legacy decryption using raw AES key (no HKDF)
    const keyB64 = ConfigManager.getInstance().config.AES_KEY;
    const masterKey = Buffer.from(keyB64, "base64");

    if (masterKey.length >= KEY_LENGTH) {
      try {
        const rawKey = masterKey.subarray(0, KEY_LENGTH);
        return decryptWithKey(ciphertext, rawKey);
      } catch (fallbackErr) {
        throw err;
      }
    }
    throw err;
  }
}

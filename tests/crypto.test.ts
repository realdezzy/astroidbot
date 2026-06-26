import crypto from "node:crypto";
import { encryptWithKey, decryptWithKey, IV_LENGTH, AUTH_TAG_LENGTH, KEY_LENGTH } from "../src/utils/crypto.js";

function generateKey(): Buffer {
  return crypto.randomBytes(KEY_LENGTH);
}

describe("AES-256-GCM Crypto", () => {
  let key: Buffer;

  beforeEach(() => {
    key = generateKey();
  });

  it("encrypts and decrypts a plaintext round-trip", () => {
    const plaintext = "this-is-a-stacks-private-key-0123456789abcdef";
    const ciphertext = encryptWithKey(plaintext, key);
    expect(ciphertext).not.toBe(plaintext);
    expect(ciphertext.length).toBeGreaterThan(0);

    const decrypted = decryptWithKey(ciphertext, key);
    expect(decrypted).toBe(plaintext);
  });

  it("produces different ciphertext for the same plaintext", () => {
    const plaintext = "secret-data";
    const ct1 = encryptWithKey(plaintext, key);
    const ct2 = encryptWithKey(plaintext, key);
    expect(ct1).not.toBe(ct2);
  });

  it("fails to decrypt with wrong key", () => {
    const plaintext = "secret";
    const ciphertext = encryptWithKey(plaintext, key);
    const wrongKey = generateKey();
    expect(() => decryptWithKey(ciphertext, wrongKey)).toThrow();
  });

  it("fails to decrypt corrupted ciphertext", () => {
    const plaintext = "secret";
    const ciphertext = encryptWithKey(plaintext, key);
    const corrupted = ciphertext.slice(0, -4) + "ffff";
    expect(() => decryptWithKey(corrupted, key)).toThrow();
  });

  it("handles empty string", () => {
    const ciphertext = encryptWithKey("", key);
    const decrypted = decryptWithKey(ciphertext, key);
    expect(decrypted).toBe("");
  });

  it("handles long text (private key length)", () => {
    const pk = "0".repeat(64);
    const ciphertext = encryptWithKey(pk, key);
    const decrypted = decryptWithKey(ciphertext, key);
    expect(decrypted).toBe(pk);
  });

  it("rejects keys of wrong length", () => {
    const shortKey = crypto.randomBytes(16);
    const plaintext = "test";
    expect(() => encryptWithKey(plaintext, shortKey)).toThrow();
  });

  it("cross-version compatibility: multiple rounds", () => {
    const rounds = 10;
    for (let i = 0; i < rounds; i++) {
      const msg = `message-${i}-${crypto.randomBytes(8).toString("hex")}`;
      const k = generateKey();
      const ct = encryptWithKey(msg, k);
      expect(decryptWithKey(ct, k)).toBe(msg);
    }
  });

  it("outputs base64-encoded string", () => {
    const ct = encryptWithKey("hello", key);
    expect(() => Buffer.from(ct, "base64")).not.toThrow();
    const decoded = Buffer.from(ct, "base64");
    expect(decoded.length).toBe(IV_LENGTH + 5 + AUTH_TAG_LENGTH); // hello=5 bytes
  });

  it("format matches: iv + ciphertext + auth_tag (base64)", () => {
    const ct = encryptWithKey("test1234", key); // 8 bytes
    const data = Buffer.from(ct, "base64");
    expect(data.length).toBe(IV_LENGTH + 8 + AUTH_TAG_LENGTH);

    const iv = data.subarray(0, IV_LENGTH);
    const tag = data.subarray(data.length - AUTH_TAG_LENGTH);
    const body = data.subarray(IV_LENGTH, data.length - AUTH_TAG_LENGTH);

    expect(iv.length).toBe(IV_LENGTH);
    expect(tag.length).toBe(AUTH_TAG_LENGTH);
    expect(body.length).toBe(8);
  });
});

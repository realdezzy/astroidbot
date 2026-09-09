import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { assertNoPlaceholders } from "../../src/config.js";

/**
 * The `.env` of this repository shipped with `AES_KEY` set to a typed sentence
 * — 40 bytes of printable ASCII rather than 32 random ones — and `JWT_SECRET`
 * still reading `change-me-in-production-…`. Both passed `envSchema`, because
 * `z.string().min(1)` and `z.string().min(32)` are satisfied by prose.
 *
 * So the failure was not that nobody checked; it was that the check measured
 * length and the problem was entropy. These cases pin the difference, and the
 * first one is the exact value that was live.
 */

/** A real key: 32 bytes from the CSPRNG, base64-encoded. */
const realAesKey = (): string => randomBytes(32).toString("base64");
const realJwtSecret = (): string => randomBytes(48).toString("base64");

/** The shape under test, with every field defaulted to something valid. */
const good = (over: Record<string, string | undefined> = {}) => ({
  AES_KEY: realAesKey(),
  JWT_SECRET: realJwtSecret(),
  AI_PROVIDER: "openai" as const,
  OPENAI_API_KEY: "sk-proj-Zx8Qv2mKp7nR4tYw1bLcHdJfGe9sA3uV",
  ...over,
});

describe("assertNoPlaceholders", () => {
  it("accepts real, randomly generated secrets", () => {
    expect(() => assertNoPlaceholders(good())).not.toThrow();
  });

  describe("AES_KEY — the key wallet private keys are encrypted under", () => {
    it("rejects the value this repository actually shipped with", () => {
      // 40 bytes of printable ASCII. Valid base64, passes `min(1)`, and is a
      // sentence somebody typed.
      const typed = Buffer.from("[lthis is not a real encryption key!!]xy").toString("base64");
      expect(Buffer.from(typed, "base64")).toHaveLength(40);

      expect(() => assertNoPlaceholders(good({ AES_KEY: typed }))).toThrow(/AES_KEY/);
    });

    it("rejects a key that decodes to the wrong number of bytes", () => {
      expect(() => assertNoPlaceholders(good({ AES_KEY: randomBytes(16).toString("base64") }))).toThrow(
        /AES_KEY/
      );
      expect(() => assertNoPlaceholders(good({ AES_KEY: randomBytes(64).toString("base64") }))).toThrow(
        /AES_KEY/
      );
    });

    it("rejects 32 bytes that are entirely printable ASCII", () => {
      // The right length, so a length check passes it — but a CSPRNG produces
      // 32 printable bytes about once in 10^14 draws, so this is a typed
      // string and nothing else.
      const typed = Buffer.from("abcdefghijklmnopqrstuvwxyz012345").toString("base64");
      expect(Buffer.from(typed, "base64")).toHaveLength(32);

      expect(() => assertNoPlaceholders(good({ AES_KEY: typed }))).toThrow(/AES_KEY/);
    });

    it("rejects a value that is not base64 at all", () => {
      expect(() => assertNoPlaceholders(good({ AES_KEY: "your-generated-base64-key-here" }))).toThrow(
        /AES_KEY/
      );
    });

    it("names the generator command, so the error is actionable", () => {
      expect(() => assertNoPlaceholders(good({ AES_KEY: "testkey" }))).toThrow(/randomBytes|openssl/);
    });
  });

  describe("JWT_SECRET", () => {
    it("rejects the .env.example value even though it is long enough", () => {
      expect(() =>
        assertNoPlaceholders(good({ JWT_SECRET: "change-me-in-production-to-32-char-min-xyz" }))
      ).toThrow(/JWT_SECRET/);
    });

    it("rejects the .env.example prose verbatim", () => {
      expect(() =>
        assertNoPlaceholders(
          good({ JWT_SECRET: "generate-a-random-string-at-least-32-characters-and-replace-this" })
        )
      ).toThrow(/JWT_SECRET/);
    });
  });

  describe("provider credentials", () => {
    it("rejects the OpenAI placeholder", () => {
      expect(() => assertNoPlaceholders(good({ OPENAI_API_KEY: "sk-..." }))).toThrow(
        /OPENAI_API_KEY/
      );
    });

    it("rejects a bare ellipsis", () => {
      expect(() =>
        assertNoPlaceholders(good({ AI_PROVIDER: "google", GOOGLE_AI_API_KEY: "..." }))
      ).toThrow(/GOOGLE_AI_API_KEY/);
    });

    it("rejects the .env.example Telegram token", () => {
      expect(() =>
        assertNoPlaceholders(good({ TELEGRAM_BOT_TOKEN: "1234567890:ABCdefGHIjklMNOpqrsTUVwxyz" }))
      ).toThrow(/TELEGRAM_BOT_TOKEN/);
    });

    it("rejects the .env.example admin id", () => {
      expect(() => assertNoPlaceholders(good({ TELEGRAM_ADMIN_IDS: "123456789" }))).toThrow(
        /TELEGRAM_ADMIN_IDS/
      );
    });

    /**
     * Absent is a decision; a placeholder is an accident that reads as one.
     * A deployment with no Telegram bot is perfectly valid, and must not be
     * made to invent a credential to boot.
     */
    it("accepts optional credentials that are simply unset", () => {
      expect(() =>
        assertNoPlaceholders(good({ TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_ADMIN_IDS: undefined }))
      ).not.toThrow();
      expect(() =>
        assertNoPlaceholders(good({ TELEGRAM_BOT_TOKEN: "", TELEGRAM_ADMIN_IDS: "" }))
      ).not.toThrow();
    });

    /**
     * Only the provider actually selected has to be real. Leaving a stale
     * placeholder in an unused slot is untidy, not a reason to refuse to boot.
     */
    it("ignores the placeholder of a provider that is not selected", () => {
      expect(() =>
        assertNoPlaceholders(good({ AI_PROVIDER: "openai", DEEPSEEK_API_KEY: "sk-..." }))
      ).not.toThrow();
    });
  });

  /**
   * One boot, one list. Reporting only the first offender means an operator
   * fixes a placeholder, restarts, and is told about the next one — which for
   * a container under `set -e` is a crash loop that reveals its causes one
   * restart at a time.
   */
  it("reports every offender at once rather than the first", () => {
    let message = "";
    try {
      assertNoPlaceholders({
        AES_KEY: "testkey",
        JWT_SECRET: "change-me-in-production-to-32-char-min-xyz",
        AI_PROVIDER: "openai",
        OPENAI_API_KEY: "sk-...",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/AES_KEY/);
    expect(message).toMatch(/JWT_SECRET/);
    expect(message).toMatch(/OPENAI_API_KEY/);
  });
});

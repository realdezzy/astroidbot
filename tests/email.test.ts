import { beforeAll } from "vitest";
import { buildOtpEmail, buildVerificationEmail, buildPasswordResetEmail, sendEmail } from "../src/utils/email.js";
import { ConfigManager } from "../src/config.js";

beforeAll(() => {
  process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
  process.env.AES_KEY = "testkey";
  process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
  if (process.env.TELEGRAM_WEBHOOK_URL === "") {
    delete process.env.TELEGRAM_WEBHOOK_URL;
  }
  if (process.env.VELUMX_RELAYER_URL === "") {
    delete process.env.VELUMX_RELAYER_URL;
  }
  ConfigManager.load();
});

describe("Email Service & Templates", () => {
  it("builds a verification email template", () => {
    const link = "https://example.com/verify";
    const email = buildVerificationEmail(link);
    expect(email.subject).toContain("Verify");
    expect(email.html).toContain(link);
  });

  it("builds a password reset email template", () => {
    const link = "https://example.com/reset";
    const email = buildPasswordResetEmail(link);
    expect(email.subject).toContain("Reset");
    expect(email.html).toContain(link);
  });

  it("builds an OTP email template", () => {
    const otp = "123456";
    const email = buildOtpEmail(otp);
    expect(email.subject).toContain("Verify");
    expect(email.html).toContain(otp);
  });

  it("respects DRY_RUN when sending emails", async () => {
    const config = ConfigManager.getInstance().config;
    const originalDryRun = config.DRY_RUN;
    config.DRY_RUN = true;

    try {
      const result = await sendEmail("test@example.com", "Test", "<h1>Test</h1>");
      expect(result).toBe(true);
    } finally {
      config.DRY_RUN = originalDryRun;
    }
  });
});

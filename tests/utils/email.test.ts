import { describe, it, expect, beforeEach } from "vitest";
import { loadTestConfig } from "../helpers/config.js";
import {
  sendEmail,
  buildVerificationEmail,
  buildPasswordResetEmail,
  buildOtpEmail,
} from "../../src/utils/email.js";

/**
 * This module had no tests, and it is on the account-recovery path: a broken
 * template or a link that doesn't render is a user who cannot get back in.
 *
 * It is also where `npm run build` was failing. `nodemailer.Transporter` is not
 * a namespace member — TS2503 — so the typecheck exited non-zero, which meant
 * the Docker image (whose build stage runs the typecheck as the deploy gate)
 * could not be built at all. A file with no tests, breaking the build, on the
 * password-reset path.
 */
describe("email", () => {
  beforeEach(() => {
    loadTestConfig({ DRY_RUN: "true" });
  });

  describe("sendEmail", () => {
    it("reports success without sending under DRY_RUN", async () => {
      // No SMTP is configured in tests, so a DRY_RUN that tried to connect
      // would hang or throw rather than short-circuit.
      await expect(sendEmail("someone@example.com", "Subject", "<p>Body</p>")).resolves.toBe(true);
    });

    it("reports failure rather than throwing when SMTP is not configured", async () => {
      // The caller is an HTTP handler. An exception here turns "we could not
      // email you a reset link" into a 500 with no explanation.
      loadTestConfig({ DRY_RUN: "false" });
      await expect(sendEmail("someone@example.com", "Subject", "<p>Body</p>")).resolves.toBe(false);
    });
  });

  describe("templates", () => {
    const link = "https://app.example.com/verify?token=abc123";

    it("puts the verification link in the body as an href", () => {
      const { subject, html } = buildVerificationEmail(link);
      expect(subject).toBeTruthy();
      expect(html).toContain(`href="${link}"`);
    });

    it("puts the reset link in the body as an href", () => {
      const { html } = buildPasswordResetEmail(link);
      expect(html).toContain(`href="${link}"`);
    });

    it("shows the OTP itself, since there is nothing to click", () => {
      const { html } = buildOtpEmail("483927");
      expect(html).toContain("483927");
    });

    it("does not leave an unsubstituted placeholder in any template", () => {
      // A template that renders "${link}" or "undefined" is worse than an error:
      // it sends, and the user sees a broken email from us.
      for (const { html } of [
        buildVerificationEmail(link),
        buildPasswordResetEmail(link),
        buildOtpEmail("483927"),
      ]) {
        expect(html).not.toContain("undefined");
        expect(html).not.toMatch(/\$\{/);
      }
    });
  });
});

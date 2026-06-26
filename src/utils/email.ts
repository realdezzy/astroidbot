import nodemailer from "nodemailer";
import { ConfigManager } from "../config.js";
import { logger } from "./logger.js";


let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (transporter) return transporter;

  const config = ConfigManager.getInstance().config;
  if (!config.SMTP_HOST || !config.SMTP_USER) {
    logger.info("SMTP not configured — email sending disabled");
    return null;
  }

  transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    auth: {
      user: config.SMTP_USER,
      pass: config.SMTP_PASS,
    },
  });

  return transporter;
}

export async function sendEmail(
  to: string,
  subject: string,
  html: string
): Promise<boolean> {
  const config = ConfigManager.getInstance().config;

  if (config.DRY_RUN) {
    logger.info("DRY_RUN — would send email", { to, subject });
    return true;
  }

  const t = getTransporter();
  if (!t) return false;

  try {
    await t.sendMail({
      from: config.SMTP_FROM || config.SMTP_USER,
      to,
      subject,
      html,
    });
    logger.info("Email sent", { to, subject });
    return true;
  } catch (error) {
    logger.error("Failed to send email", { to, subject, error });
    return false;
  }
}

export function buildVerificationEmail(link: string): { subject: string; html: string } {
  return {
    subject: "Verify your AstroidBot account",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #5b8def;">AstroidBot</h2>
        <p>Welcome! Please verify your email address by clicking the button below:</p>
        <a href="${link}" style="display: inline-block; padding: 12px 24px; background: #5b8def; color: white; text-decoration: none; border-radius: 8px; font-weight: bold;">
          Verify Email
        </a>
        <p style="margin-top: 16px; color: #666; font-size: 13px;">
          Or copy this link: ${link}
        </p>
        <p style="color: #999; font-size: 12px;">
          This link expires in 1 hour. If you didn't create this account, ignore this email.
        </p>
      </div>
    `,
  };
}

export function buildPasswordResetEmail(link: string): { subject: string; html: string } {
  return {
    subject: "Reset your AstroidBot password",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #5b8def;">AstroidBot</h2>
        <p>You requested a password reset. Click below to set a new password:</p>
        <a href="${link}" style="display: inline-block; padding: 12px 24px; background: #5b8def; color: white; text-decoration: none; border-radius: 8px; font-weight: bold;">
          Reset Password
        </a>
        <p style="margin-top: 16px; color: #666; font-size: 13px;">
          Or copy this link: ${link}
        </p>
        <p style="color: #999; font-size: 12px;">
          This link expires in 1 hour. If you didn't request this, ignore this email.
        </p>
      </div>
    `,
  };
}

export function buildOtpEmail(otp: string): { subject: string; html: string } {
  return {
    subject: "Verify your email - AstroidBot Link Request",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 20px; border: 1px solid #eaeaea; border-radius: 12px; background-color: #fafafa;">
        <h2 style="color: #5b8def; margin-top: 0;">AstroidBot</h2>
        <p style="font-size: 16px; color: #333;">You requested to link this email to your Telegram account on AstroidBot.</p>
        <p style="font-size: 16px; color: #333;">Your verification code is:</p>
        <div style="font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #5b8def; margin: 20px 0; font-family: monospace; text-align: center;">
          ${otp}
        </div>
        <p style="font-size: 14px; color: #666;">This code is valid for 10 minutes. If you did not request this link, you can safely ignore this email.</p>
      </div>
    `,
  };
}

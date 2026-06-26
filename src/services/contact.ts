import { DatabaseService } from "./db.js";
import { logger } from "../utils/logger.js";
import { sendEmail } from "../utils/email.js";
import { ConfigManager } from "../config.js";

export class ContactService {
  private static instance: ContactService;

  private constructor() {}

  static getInstance(): ContactService {
    if (!ContactService.instance) {
      ContactService.instance = new ContactService();
    }
    return ContactService.instance;
  }

  async saveAndDeliver(data: { name: string; email: string; message: string }): Promise<void> {
    const { name, email, message } = data;

    // 1. Save to database
    const db = DatabaseService.getInstance();
    await db.prisma.contactMessage.create({
      data: { name, email, message },
    });
    logger.info("[ContactService] Contact message saved to database", { from: email });

    // 2. Deliver email
    const config = ConfigManager.getInstance().config;
    const recipient = config.SMTP_FROM;

    if (!recipient) {
      logger.warn("[ContactService] SMTP_FROM not configured — cannot deliver contact message");
      return;
    }

    const subject = `[AstroidBot] Contact form — ${name}`;
    const html = `
      <p><strong>Name:</strong> ${name}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Message:</strong></p>
      <pre style="white-space:pre-wrap">${message}</pre>
    `;

    await sendEmail(recipient, subject, html);
    logger.info("[ContactService] Contact form delivered via email", { from: email });
  }
}

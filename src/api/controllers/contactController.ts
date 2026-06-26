import type { Request, Response } from "express";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import { ContactService } from "../../services/contact.js";

const contactSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  email: z.string().email().max(254).trim(),
  message: z.string().min(10).max(2000).trim(),
});

export class ContactController {
  static async submitContactMessage(req: Request, res: Response): Promise<Response> {
    const parsed = contactSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid submission",
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { name, email, message } = parsed.data;

    try {
      const contactService = ContactService.getInstance();
      await contactService.saveAndDeliver({ name, email, message });
      return res.status(200).json({ ok: true });
    } catch (err) {
      logger.error("[ContactController] Failed to process contact submission", { error: err });
      return res.status(500).json({ error: "Failed to process message. Please try again later." });
    }
  }
}

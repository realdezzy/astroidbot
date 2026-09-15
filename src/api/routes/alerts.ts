import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { AlertPreferenceService, alertCadenceSchema, alertChannelSchema, alertSeveritySchema } from "../../services/alertPreferenceService.js";

const preferenceSchema = z.object({
  channel: alertChannelSchema,
  eventType: z.string().min(2).max(64),
  enabled: z.boolean().optional(),
  cadence: alertCadenceSchema.optional(),
  minimumSeverity: alertSeveritySchema.optional(),
});
const router = Router();

router.get("/", authenticate, async (req, res, next) => {
  try {
    res.json(await AlertPreferenceService.getInstance().list(req.userId!));
  } catch (error) { next(error); }
});

router.put("/", authenticate, validateBody(preferenceSchema), async (req, res, next) => {
  try {
    res.json(await AlertPreferenceService.getInstance().upsert(req.userId!, req.body));
  } catch (error) { next(error); }
});
export default router;

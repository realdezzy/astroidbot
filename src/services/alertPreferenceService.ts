import { z } from "zod";
import { DatabaseService } from "./db.js";

export const alertChannelSchema = z.enum(["TELEGRAM", "PUSH"]);
export const alertCadenceSchema = z.enum(["INSTANT", "DIGEST", "MUTED"]);
export const alertSeveritySchema = z.enum(["INFO", "SUCCESS", "WARNING", "ERROR"]);
const severityRank = { INFO: 0, SUCCESS: 0, WARNING: 1, ERROR: 2 } as const;

export class AlertPreferenceService {
  private static instance: AlertPreferenceService;
  static getInstance(): AlertPreferenceService {
    if (!this.instance) this.instance = new AlertPreferenceService();
    return this.instance;
  }

  async list(userId: number) {
    return DatabaseService.getInstance().prisma.alertPreference.findMany({
      where: { userId }, orderBy: [{ channel: "asc" }, { eventType: "asc" }],
    });
  }

  async upsert(userId: number, input: {
    channel: z.infer<typeof alertChannelSchema>; eventType: string; enabled?: boolean;
    cadence?: z.infer<typeof alertCadenceSchema>; minimumSeverity?: z.infer<typeof alertSeveritySchema>;
  }) {
    const channel = alertChannelSchema.parse(input.channel);
    const eventType = input.eventType.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(eventType)) throw new Error("Invalid alert event type");
    const cadence = input.cadence ? alertCadenceSchema.parse(input.cadence) : undefined;
    const minimumSeverity = input.minimumSeverity ? alertSeveritySchema.parse(input.minimumSeverity) : undefined;
    return DatabaseService.getInstance().prisma.alertPreference.upsert({
      where: { userId_channel_eventType: { userId, channel, eventType } },
      update: { ...(input.enabled === undefined ? {} : { enabled: input.enabled }), ...(cadence ? { cadence } : {}), ...(minimumSeverity ? { minimumSeverity } : {}) },
      create: { userId, channel, eventType, enabled: input.enabled ?? true, cadence: cadence ?? "INSTANT", minimumSeverity: minimumSeverity ?? "INFO" },
    });
  }

  async shouldDeliver(userId: number, channel: "TELEGRAM" | "PUSH", eventType: string, severity: keyof typeof severityRank): Promise<boolean> {
    const pref = await DatabaseService.getInstance().prisma.alertPreference.findUnique({
      where: { userId_channel_eventType: { userId, channel, eventType: eventType.toUpperCase() } },
    });
    if (!pref) return true;
    if (!pref.enabled || pref.cadence !== "INSTANT") return false;
    const minimum = alertSeveritySchema.safeParse(pref.minimumSeverity);
    return severityRank[severity] >= severityRank[minimum.success ? minimum.data : "INFO"];
  }
}

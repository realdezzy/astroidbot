import crypto from "node:crypto";
import { z } from "zod";
import { RedisService } from "../redis.js";

export const deepLinkTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("screen"), screen: z.enum(["main", "portfolio", "wallets", "orders", "agents", "settings", "trade", "trades"]) }),
  z.object({ kind: z.literal("token"), chainId: z.string().min(1), contractId: z.string().min(1) }),
  z.object({ kind: z.literal("agent"), agentId: z.number().int().positive() }),
  z.object({ kind: z.literal("pending_action"), actionId: z.string().uuid() }),
]);

export type DeepLinkTarget = z.infer<typeof deepLinkTargetSchema>;
interface StoredLink { target: DeepLinkTarget; expectedUserId?: number; source: string; }

export class DeepLinkService {
  constructor(private readonly redis: Pick<RedisService, "set" | "getDel"> = RedisService.getInstance()) {}

  async create(input: StoredLink, ttlSeconds = 15 * 60): Promise<string> {
    const nonce = crypto.randomBytes(24).toString("base64url");
    const record: StoredLink = { ...input, target: deepLinkTargetSchema.parse(input.target) };
    const audience = input.expectedUserId ?? "any";
    await this.redis.set(`telegram:link:${nonce}:${audience}`, JSON.stringify(record), ttlSeconds);
    return `dl_${nonce}`;
  }

  async consume(parameter: string, userId: number): Promise<DeepLinkTarget | null> {
    if (!/^dl_[A-Za-z0-9_-]{32}$/.test(parameter)) return null;
    const nonce = parameter.slice(3);
    const raw = await this.redis.getDel(`telegram:link:${nonce}:${userId}`)
      ?? await this.redis.getDel(`telegram:link:${nonce}:any`);
    if (!raw) return null;
    try {
      const stored = JSON.parse(raw) as StoredLink;
      if (stored.expectedUserId !== undefined && stored.expectedUserId !== userId) return null;
      return deepLinkTargetSchema.parse(stored.target);
    } catch {
      return null;
    }
  }
}

import { Prisma } from "@prisma/client";
import { DatabaseService } from "./db.js";
import { logger } from "../utils/logger.js";

export interface AgentDecisionInput {
  userId: number;
  strategyId: number;
  agentId?: number | null;
  outcome: "NO_ACTION" | "SUPPRESSED" | "EXECUTED" | "FAILED";
  observed: Record<string, unknown>;
  triggeredRule?: string;
  expectedRisk: Record<string, unknown>;
  confidence?: number;
  action?: Record<string, unknown>;
  explanation: string;
}

export class AgentDecisionService {
  private static instance: AgentDecisionService;
  static getInstance(): AgentDecisionService {
    return this.instance ??= new AgentDecisionService();
  }

  async record(input: AgentDecisionInput): Promise<void> {
    try {
      await DatabaseService.getInstance().prisma.agentDecision.create({
        data: {
          ...input,
          agentId: input.agentId ?? null,
          observed: input.observed as Prisma.InputJsonValue,
          expectedRisk: input.expectedRisk as Prisma.InputJsonValue,
          action: input.action ? input.action as Prisma.InputJsonValue : Prisma.JsonNull,
        },
      });
    } catch (error) {
      logger.warn("Could not persist agent decision report", {
        strategyId: input.strategyId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

import type { Request, Response, NextFunction } from "express";
import { Prisma } from "@prisma/client";
import { DatabaseService } from "../../services/db.js";
import { AgentService } from "../../services/agentService.js";
import { logger } from "../../utils/logger.js";
import { ValidationError, NotFoundError, InternalError } from "../errors.js";

export class AgentController {
  static async getAgents(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const db = DatabaseService.getInstance();
      const agents = await db.prisma.tradeAgent.findMany({
        where: { userId: req.userId! },
        orderBy: { createdAt: "desc" },
      });

      const agentIds = agents.map((a) => a.id);
      const strategies = agentIds.length > 0
        ? await db.prisma.tradingStrategy.findMany({
            where: { agentId: { in: agentIds }, userId: req.userId! },
            select: { id: true, agentId: true, type: true, isActive: true },
          })
        : [];

      const byAgent = new Map<number, typeof strategies>();
      for (const s of strategies) {
        if (s.agentId === null) continue;
        const list = byAgent.get(s.agentId) ?? [];
        list.push(s);
        byAgent.set(s.agentId, list);
      }

      const enriched = agents.map((a) => ({
        ...a,
        strategies: byAgent.get(a.id) ?? [],
      }));

      res.json({ agents: enriched });
    } catch (error) {
      logger.error("Failed to fetch agents", { error });
      next(new InternalError());
    }
  }

  static async createAgent(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { name, context, aiMode, config, model } = req.body as {
        name: string; context: string; aiMode: string; config?: Record<string, unknown>; model?: string;
      };
      const normalizedConfig = validateAgentConfig(config ?? {});
      const agent = await DatabaseService.getInstance().prisma.tradeAgent.create({
        data: {
          userId: req.userId!,
          name,
          context,
          aiMode,
          config: normalizedConfig as Prisma.InputJsonValue,
          model: model ?? "deepseek-v4-pro",
        },
      });
      res.status(201).json(agent);
    } catch (error) {
      if (error instanceof ValidationError) return next(error);
      logger.error("Failed to create agent", { error });
      next(new InternalError());
    }
  }

  static async updateAgent(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const id = parseInt(String(req.params.id ?? ""), 10);
      if (isNaN(id)) return next(new ValidationError("Invalid agent ID"));
      const existing = await DatabaseService.getInstance().prisma.tradeAgent.findUnique({ where: { id } });
      if (!existing || existing.userId !== req.userId) return next(new NotFoundError("Agent"));
      const { isActive, name, aiMode, config } = req.body as {
        isActive?: boolean; name?: string; aiMode?: string; config?: Record<string, unknown>;
      };
      if (aiMode !== undefined && !["off", "advisor", "autonomous"].includes(aiMode)) {
        return next(new ValidationError("Invalid AI mode"));
      }
      if (name !== undefined && (typeof name !== "string" || name.trim().length === 0 || name.length > 64)) {
        return next(new ValidationError("Invalid agent name"));
      }
      const data: Record<string, unknown> = {};
      if (isActive !== undefined) data.isActive = isActive;
      if (name) data.name = name.trim();
      if (aiMode) data.aiMode = aiMode;
      if (config) data.config = validateAgentConfig(config);
      const updated = await DatabaseService.getInstance().prisma.tradeAgent.update({ where: { id }, data });
      res.json(updated);
    } catch (error) {
      if (error instanceof ValidationError) return next(error);
      logger.error("Failed to update agent", { error });
      next(new InternalError());
    }
  }

  static async deleteAgent(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const id = parseInt(String(req.params.id ?? ""), 10);
      if (isNaN(id)) return next(new ValidationError("Invalid agent ID"));
      const existing = await DatabaseService.getInstance().prisma.tradeAgent.findUnique({ where: { id } });
      if (!existing || existing.userId !== req.userId) return next(new NotFoundError("Agent"));
      await DatabaseService.getInstance().prisma.tradeAgent.delete({ where: { id } });
      res.json({ ok: true });
    } catch (error) {
      logger.error("Failed to delete agent", { error });
      next(new InternalError());
    }
  }

  static async runAgent(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const id = parseInt(String(req.params.id ?? ""), 10);
      if (isNaN(id)) return next(new ValidationError("Invalid agent ID"));
      const existing = await DatabaseService.getInstance().prisma.tradeAgent.findUnique({ where: { id } });
      if (!existing || existing.userId !== req.userId) return next(new NotFoundError("Agent"));
      const result = await AgentService.getInstance().runAgentCycle(id);
      res.json(result);
    } catch (error) {
      logger.error("Failed to run agent", { error });
      next(new InternalError());
    }
  }
}

function validateAgentConfig(config: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...config };
  for (const key of ["maxPositionPct", "maxAutonomousTradeAmount", "dailyLossLimit"]) {
    if (normalized[key] === undefined) continue;
    const value = Number(normalized[key]);
    if (!Number.isFinite(value) || value <= 0) {
      throw new ValidationError(`Invalid agent config: ${key}`);
    }
    if ((key === "maxPositionPct" || key === "dailyLossLimit") && value > 100) {
      throw new ValidationError(`Invalid agent config: ${key}`);
    }
    normalized[key] = value;
  }
  return normalized;
}

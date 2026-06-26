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
      const agent = await DatabaseService.getInstance().prisma.tradeAgent.create({
        data: {
          userId: req.userId!,
          name,
          context,
          aiMode,
          config: (config ?? {}) as Prisma.InputJsonValue,
          model: model ?? "deepseek-v4-pro",
        },
      });
      res.status(201).json(agent);
    } catch (error) {
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
      const data: Record<string, unknown> = {};
      if (isActive !== undefined) data.isActive = isActive;
      if (name) data.name = name;
      if (aiMode) data.aiMode = aiMode;
      if (config) data.config = config;
      const updated = await DatabaseService.getInstance().prisma.tradeAgent.update({ where: { id }, data });
      res.json(updated);
    } catch (error) {
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
      const result = await AgentService.getInstance().runAgentCycle(id);
      res.json(result);
    } catch (error) {
      logger.error("Failed to run agent", { error });
      next(new InternalError());
    }
  }
}

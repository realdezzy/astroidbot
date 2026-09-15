import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { z } from "zod";
import { AgentController } from "../controllers/agentController.js";
import { DatabaseService } from "../../services/db.js";
import { NotFoundError, ValidationError } from "../errors.js";

const router = Router();

const createAgentSchema = z.object({
  name: z.string().min(1).max(64),
  context: z.enum(["portfolio_rebalance", "grid", "sniper", "custom"]).default("custom"),
  aiMode: z.enum(["off", "advisor", "autonomous"]).default("off"),
  config: z.record(z.unknown()).optional(),
  model: z.string().optional(),
});

router.get("/", authenticate, AgentController.getAgents);
router.get("/:id/reports", authenticate, async (req, res, next) => {
  try {
    const agentId = Number(req.params.id);
    if (!Number.isInteger(agentId) || agentId <= 0) throw new ValidationError("Invalid agent ID");
    const db = DatabaseService.getInstance();
    const agent = await db.prisma.tradeAgent.findFirst({ where: { id: agentId, userId: req.userId! } });
    if (!agent) throw new NotFoundError("Agent");
    const reports = await db.prisma.agentDecision.findMany({
      where: { agentId, userId: req.userId! },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    res.json({ reports });
  } catch (error) { next(error); }
});
router.post("/", authenticate, validateBody(createAgentSchema), AgentController.createAgent);
router.put("/:id", authenticate, AgentController.updateAgent);
router.delete("/:id", authenticate, AgentController.deleteAgent);
router.post("/:id/run", authenticate, AgentController.runAgent);

export default router;

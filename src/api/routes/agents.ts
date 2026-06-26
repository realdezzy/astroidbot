import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { z } from "zod";
import { AgentController } from "../controllers/agentController.js";

const router = Router();

const createAgentSchema = z.object({
  name: z.string().min(1).max(64),
  context: z.enum(["portfolio_rebalance", "grid", "sniper", "custom"]).default("custom"),
  aiMode: z.enum(["off", "advisor", "autonomous"]).default("off"),
  config: z.record(z.unknown()).optional(),
  model: z.string().optional(),
});

router.get("/", authenticate, AgentController.getAgents);
router.post("/", authenticate, validateBody(createAgentSchema), AgentController.createAgent);
router.put("/:id", authenticate, AgentController.updateAgent);
router.delete("/:id", authenticate, AgentController.deleteAgent);
router.post("/:id/run", authenticate, AgentController.runAgent);

export default router;

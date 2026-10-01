/**
 * Automation API routes
 */
import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { automationService, CreateAutomationInput, UpdateAutomationInput } from "../services/automation.service";

const router = Router();

// All routes require auth
router.use(requireAuth);

// GET /automations — list all automations
router.get("/", async (req: Request, res: Response) => {
    try {
        const automations = await automationService.list(req.user!.id);
        res.json({ automations });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to list automations";
        res.status(500).json({ error: msg });
    }
});

// GET /automations/stats — automation dashboard stats
router.get("/stats", async (req: Request, res: Response) => {
    try {
        const stats = await automationService.getStats(req.user!.id);
        res.json(stats);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to get stats";
        res.status(500).json({ error: msg });
    }
});

// GET /automations/:id — get single automation
router.get("/:id", async (req: Request, res: Response) => {
    try {
        const automation = await automationService.getById(req.user!.id, req.params.id);
        if (!automation) { res.status(404).json({ error: "Automation not found" }); return; }
        res.json(automation);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to get automation";
        res.status(500).json({ error: msg });
    }
});

// POST /automations — create automation
router.post("/", async (req: Request, res: Response) => {
    try {
        const input: CreateAutomationInput = req.body;
        if (!input.name || !input.channel || !input.triggers?.length || !input.actions?.length) {
            res.status(400).json({ error: "name, channel, triggers, and actions are required" });
            return;
        }
        const automation = await automationService.create(req.user!.id, input);
        res.status(201).json(automation);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to create automation";
        res.status(500).json({ error: msg });
    }
});

// PATCH /automations/:id — update automation
router.patch("/:id", async (req: Request, res: Response) => {
    try {
        const input: UpdateAutomationInput = req.body;
        const automation = await automationService.update(req.user!.id, req.params.id, input);
        if (!automation) { res.status(404).json({ error: "Automation not found" }); return; }
        res.json(automation);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to update automation";
        res.status(500).json({ error: msg });
    }
});

// DELETE /automations/:id — delete automation
router.delete("/:id", async (req: Request, res: Response) => {
    try {
        const deleted = await automationService.delete(req.user!.id, req.params.id);
        if (!deleted) { res.status(404).json({ error: "Automation not found" }); return; }
        res.json({ deleted: true });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to delete automation";
        res.status(500).json({ error: msg });
    }
});

// POST /automations/:id/activate — activate automation
router.post("/:id/activate", async (req: Request, res: Response) => {
    try {
        const result = await automationService.activate(req.user!.id, req.params.id);
        if (!result) { res.status(404).json({ error: "Automation not found" }); return; }
        res.json(result);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to activate";
        res.status(500).json({ error: msg });
    }
});

// POST /automations/:id/pause — pause automation
router.post("/:id/pause", async (req: Request, res: Response) => {
    try {
        const result = await automationService.pause(req.user!.id, req.params.id);
        if (!result) { res.status(404).json({ error: "Automation not found" }); return; }
        res.json(result);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to pause";
        res.status(500).json({ error: msg });
    }
});

// GET /automations/:id/logs — execution logs
router.get("/:id/logs", async (req: Request, res: Response) => {
    try {
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
        const logs = await automationService.getLogs(req.user!.id, req.params.id, limit);
        if (!logs) { res.status(404).json({ error: "Automation not found" }); return; }
        res.json({ logs });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to get logs";
        res.status(500).json({ error: msg });
    }
});

export default router;

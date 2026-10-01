/**
 * Knowledge Base API routes
 */
import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { knowledgeService, KnowledgeBaseInput } from "../services/knowledge.service";

const router = Router();

router.use(requireAuth);

// GET /knowledge — get knowledge base
router.get("/", async (req: Request, res: Response) => {
    try {
        const kb = await knowledgeService.get(req.user!.id);
        res.json(kb || {});
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to get knowledge base";
        res.status(500).json({ error: msg });
    }
});

// PUT /knowledge — save/update knowledge base
router.put("/", async (req: Request, res: Response) => {
    try {
        const input: KnowledgeBaseInput = req.body;
        // Validate URLs in resources
        if (input.resources) {
            for (const r of input.resources) {
                if (r.url && !/^https?:\/\//i.test(r.url)) {
                    res.status(400).json({ error: `Invalid URL in resource "${r.name}": ${r.url}. Only http/https allowed.` });
                    return;
                }
            }
        }
        if (input.links) {
            for (const l of input.links) {
                if (l.url && !/^https?:\/\//i.test(l.url)) {
                    res.status(400).json({ error: `Invalid URL in link "${l.label}": ${l.url}. Only http/https allowed.` });
                    return;
                }
            }
        }
        const kb = await knowledgeService.upsert(req.user!.id, input);
        res.json(kb);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to update knowledge base";
        res.status(500).json({ error: msg });
    }
});

// DELETE /knowledge — delete knowledge base
router.delete("/", async (req: Request, res: Response) => {
    try {
        await knowledgeService.delete(req.user!.id);
        res.json({ deleted: true });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to delete knowledge base";
        res.status(500).json({ error: msg });
    }
});

export default router;

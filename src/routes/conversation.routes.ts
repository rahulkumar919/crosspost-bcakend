/**
 * Conversation / Inbox API routes
 */
import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { conversationService } from "../services/conversation.service";
import type { ConversationChannel, ConversationMode } from "@prisma/client";

const router = Router();

router.use(requireAuth);

// GET /conversations — inbox list
router.get("/", async (req: Request, res: Response) => {
    try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = Math.min(parseInt(req.query.limit as string) || 30, 100);
        const channel = req.query.channel as ConversationChannel | undefined;
        const mode = req.query.mode as ConversationMode | undefined;
        const search = req.query.search as string | undefined;
        const unreadOnly = req.query.unread === "true";

        const result = await conversationService.list(
            req.user!.id,
            { channel, mode, search, unreadOnly },
            page,
            limit
        );
        res.json(result);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to list conversations";
        res.status(500).json({ error: msg });
    }
});

// GET /conversations/stats — inbox stats
router.get("/stats", async (req: Request, res: Response) => {
    try {
        const stats = await conversationService.getInboxStats(req.user!.id);
        res.json(stats);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to get stats";
        res.status(500).json({ error: msg });
    }
});

// GET /conversations/:id — single conversation detail
router.get("/:id", async (req: Request, res: Response) => {
    try {
        const conversation = await conversationService.getById(req.user!.id, req.params.id);
        if (!conversation) { res.status(404).json({ error: "Conversation not found" }); return; }
        res.json(conversation);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to get conversation";
        res.status(500).json({ error: msg });
    }
});

// GET /conversations/:id/messages — messages for a conversation
router.get("/:id/messages", async (req: Request, res: Response) => {
    try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
        const result = await conversationService.getMessages(req.user!.id, req.params.id, page, limit);
        if (!result) { res.status(404).json({ error: "Conversation not found" }); return; }
        res.json(result);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to get messages";
        res.status(500).json({ error: msg });
    }
});

// POST /conversations/:id/messages — manual agent reply
router.post("/:id/messages", async (req: Request, res: Response) => {
    try {
        const { content } = req.body;
        if (!content?.trim()) { res.status(400).json({ error: "content is required" }); return; }
        const message = await conversationService.sendManualReply(req.user!.id, req.params.id, content);
        if (!message) { res.status(404).json({ error: "Conversation not found" }); return; }
        res.status(201).json(message);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to send message";
        res.status(500).json({ error: msg });
    }
});

// POST /conversations/:id/takeover — human takeover
router.post("/:id/takeover", async (req: Request, res: Response) => {
    try {
        const result = await conversationService.takeover(req.user!.id, req.params.id);
        if (!result) { res.status(404).json({ error: "Conversation not found" }); return; }
        res.json(result);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to takeover";
        res.status(500).json({ error: msg });
    }
});

// POST /conversations/:id/resume — resume bot
router.post("/:id/resume", async (req: Request, res: Response) => {
    try {
        const result = await conversationService.resumeBot(req.user!.id, req.params.id);
        if (!result) { res.status(404).json({ error: "Conversation not found" }); return; }
        res.json(result);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to resume bot";
        res.status(500).json({ error: msg });
    }
});

export default router;

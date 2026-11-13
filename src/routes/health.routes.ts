import { Router, Request, Response } from "express";
import { prisma } from "../config/db";
import { pingCloudinary } from "../lib/cloudinary";
import { getProvider } from "../ai-providers/registry";

const router = Router();

/**
 * GET /health/ping — ultra-lightweight wake-up endpoint.
 * Returns 200 immediately — used by Vercel to wake Render from free-tier sleep
 * without running the expensive DB / Cloudinary / AI checks.
 */
router.get("/ping", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

/**
 * GET /health — full health check (DB, Cloudinary, AI provider).
 *
 * The AI ping is provider-agnostic: getProvider().ping() works for Ollama,
 * Gemini, Mistral, or any future provider without modifying this file.
 * The response key is the active provider name (e.g. "mistral", "gemini").
 */
router.get("/", async (_req: Request, res: Response) => {
    const provider = getProvider();

    const [db, cloudinary, ai] = await Promise.allSettled([
        prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
        pingCloudinary(),
        provider.ping(),
    ]);

    const status = {
        db: db.status === "fulfilled" ? db.value : false,
        cloudinary: cloudinary.status === "fulfilled" ? cloudinary.value : false,
        // Dynamic key = active provider name (e.g. "mistral": true)
        [provider.name]: ai.status === "fulfilled" ? ai.value : false,
    };

    const allHealthy = Object.values(status).every(Boolean);

    res.status(allHealthy ? 200 : 207).json({
        status: allHealthy ? "ok" : "degraded",
        provider: provider.name,
        services: status,
        timestamp: new Date().toISOString(),
    });
});

/**
 * GET /health/webhook-debug — shows connected Instagram accounts + their stored IGIDs.
 * Use this to verify that the IGID in the webhook entry.id matches what's stored.
 * Remove or protect this endpoint before going public.
 */
router.get("/webhook-debug", async (_req: Request, res: Response) => {
    try {
        const accounts = await prisma.connectedAccount.findMany({
            where: { platform: "INSTAGRAM" },
            select: {
                id: true,
                platform_account_id: true,
                platform_account_name: true,
                status: true,
                token_expires_at: true,
                updated_at: true,
            },
        });
        const recentEvents = await prisma.webhookEvent.findMany({
            where: { channel: "INSTAGRAM" },
            orderBy: { id: "desc" },
            take: 10,
        });
        const recentExecutions = await prisma.automationExecution.findMany({
            where: { channel: "INSTAGRAM" },
            orderBy: { executed_at: "desc" },
            take: 5,
            select: {
                id: true,
                automation_id: true,
                success: true,
                error_message: true,
                executed_at: true,
                actions_executed: true,
            },
        });
        res.json({
            instagram_accounts: accounts,
            recent_webhook_events: recentEvents,
            recent_executions: recentExecutions,
            env_check: {
                has_app_id: !!process.env.INSTAGRAM_APP_ID,
                app_id_value: process.env.INSTAGRAM_APP_ID,
                has_app_secret: !!process.env.INSTAGRAM_APP_SECRET,
                has_webhook_secret: !!process.env.INSTAGRAM_WEBHOOK_SECRET,
                node_env: process.env.NODE_ENV,
            },
        });
    } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});

export default router;

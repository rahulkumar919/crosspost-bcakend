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
        db:         db.status         === "fulfilled" ? db.value         : false,
        cloudinary: cloudinary.status === "fulfilled" ? cloudinary.value : false,
        // Dynamic key = active provider name (e.g. "mistral": true)
        [provider.name]: ai.status === "fulfilled" ? ai.value : false,
    };

    const allHealthy = Object.values(status).every(Boolean);

    res.status(allHealthy ? 200 : 207).json({
        status:    allHealthy ? "ok" : "degraded",
        provider:  provider.name,
        services:  status,
        timestamp: new Date().toISOString(),
    });
});

export default router;

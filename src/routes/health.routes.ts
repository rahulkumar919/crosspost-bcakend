import { Router, Request, Response } from "express";
import { prisma } from "../config/db";
import { pingCloudinary } from "../lib/cloudinary";
import { pingOllama } from "../lib/ollama-client";
import { pingGemini } from "../lib/gemini-client";
import { env } from "../config/env";

const router = Router();

/**
 * GET /health/ping — ultra-lightweight wake-up endpoint.
 * Returns 200 immediately — used by Vercel to wake Render from free-tier sleep
 * without running the expensive DB / Cloudinary / AI checks.
 */
router.get("/ping", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

/** GET /health — full health check (DB, Cloudinary, AI) */
router.get("/", async (_req: Request, res: Response) => {
    const aiPing = env.AI_PROVIDER === "gemini" ? pingGemini() : pingOllama();

    const [db, cloudinary, ai] = await Promise.allSettled([
        prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
        pingCloudinary(),
        aiPing,
    ]);

    const status = {
        db: db.status === "fulfilled" ? db.value : false,
        cloudinary: cloudinary.status === "fulfilled" ? cloudinary.value : false,
        [env.AI_PROVIDER]: ai.status === "fulfilled" ? ai.value : false,
    };

    const allHealthy = Object.values(status).every(Boolean);

    res.status(allHealthy ? 200 : 207).json({
        status: allHealthy ? "ok" : "degraded",
        services: status,
        timestamp: new Date().toISOString(),
    });
});

export default router;

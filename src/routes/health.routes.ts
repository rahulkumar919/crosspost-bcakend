import { Router, Request, Response } from "express";
import { prisma } from "../config/db";
import { pingCloudinary } from "../lib/cloudinary";
import { pingOllama } from "../lib/ollama-client";
import { pingGemini } from "../lib/gemini-client";
import { env } from "../config/env";

const router = Router();

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

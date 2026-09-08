import { PrismaClient } from "@prisma/client";
import { logger } from "../lib/logger";

// Reuse the single PrismaClient instance across hot-reloads in dev
declare global {
    // eslint-disable-next-line no-var
    var __prisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
    global.__prisma ??
    new PrismaClient({
        log:
            process.env.NODE_ENV === "development"
                ? ["warn", "error"]
                : ["error"],
        // Neon serverless closes idle connections after ~5 min.
        // These settings ensure Prisma reconnects automatically.
        datasources: {
            db: {
                url: process.env.DATABASE_URL,
            },
        },
    });

if (process.env.NODE_ENV !== "production") {
    global.__prisma = prisma;
}

export async function connectDB(): Promise<void> {
    await prisma.$connect();
    logger.info("PostgreSQL connected via Prisma");

    // Keep-alive: ping Neon every 4 minutes so the idle connection
    // is not dropped (Neon serverless closes after ~5 min of inactivity).
    setInterval(async () => {
        try {
            await prisma.$queryRaw`SELECT 1`;
        } catch (err) {
            logger.warn("DB keep-alive ping failed — will reconnect on next query", {
                error: (err as Error).message,
            });
        }
    }, 4 * 60 * 1000); // every 4 minutes
}

export async function disconnectDB(): Promise<void> {
    await prisma.$disconnect();
    logger.info("PostgreSQL disconnected");
}

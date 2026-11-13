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
}

export async function disconnectDB(): Promise<void> {
    await prisma.$disconnect();
    logger.info("PostgreSQL disconnected");
}

import app from "./app";
import { env } from "./config/env";
import { connectDB, disconnectDB } from "./config/db";
import { logger } from "./lib/logger";

async function main() {
    // ── 1. Connect to Postgres (required) ─────────────────────────────────────
    await connectDB();

    // ── 2. Start HTTP server ───────────────────────────────────────────────────
    const server = app.listen(env.PORT, () => {
        logger.info(`🚀  CrossPost AI API running on http://localhost:${env.PORT}`);
        logger.info(`    Environment : ${env.NODE_ENV}`);
        logger.info(`    Postgres    : connected`);
        logger.info(`    Queue       : inline (no Redis required)`);
        logger.info(`    Ollama      : ${env.OLLAMA_BASE_URL}  model=${env.OLLAMA_MODEL}`);
    });

    // ── 3. Graceful shutdown ───────────────────────────────────────────────────
    const shutdown = async (signal: string) => {
        logger.info(`${signal} received — shutting down gracefully`);
        server.close(async () => {
            await disconnectDB();
            logger.info("Server closed");
            process.exit(0);
        });
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
    logger.error("Fatal startup error", { error: (err as Error).message });
    process.exit(1);
});

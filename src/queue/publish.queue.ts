/**
 * Publish queue — runs jobs inline (no Redis/BullMQ required).
 *
 * Jobs are dispatched asynchronously via setImmediate so the HTTP
 * response returns immediately while publishing happens in the background.
 *
 * Retry logic (up to 3 attempts with exponential back-off) is handled
 * inside runPublishJob in publish.worker.ts.
 */
import { runPublishJob } from "./publish.worker";
import { logger } from "../lib/logger";
import type { Platform } from "@prisma/client";

export interface PublishJobData {
    postId: string;
    postTargetId: string;
    userId: string;
    platform: Platform;
}

/**
 * Dispatches a publish job asynchronously.
 * The HTTP response is NOT blocked — publishing runs in the background.
 */
export function enqueuePublishJob(data: PublishJobData): void {
    logger.info("Dispatching publish job inline", {
        platform: data.platform,
        postTargetId: data.postTargetId,
    });

    setImmediate(() => {
        runPublishJob(data, 0, 3).catch((err: Error) => {
            logger.error("Inline publish job failed (all retries exhausted)", {
                platform: data.platform,
                postTargetId: data.postTargetId,
                error: err.message,
            });
        });
    });
}

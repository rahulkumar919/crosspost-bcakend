/**
 * Publish worker — core publish logic with built-in retry.
 *
 * Handles all platform publishing: fetching account, calling the
 * platform adapter, updating DB status, and reconciling post status.
 *
 * Retries up to maxAttempts times with exponential back-off (5s → 25s → 125s).
 * On final failure, the PostTarget is marked FAILED with a user-friendly message.
 */
import { prisma } from "../config/db";
import { getAdapter } from "../services/accounts.service";
import { logger } from "../lib/logger";
import { AppError } from "../middleware/error-handler.middleware";
import type { Platform } from "@prisma/client";
import type { PublishJobData } from "./publish.queue";

/**
 * Maps a raw error to a user-safe message.
 * Full error detail is always logged server-side.
 */
function toUserError(err: unknown, platform: Platform): string {
    if (err instanceof AppError) {
        return err.message;
    }
    if (typeof err === "object" && err !== null && "response" in err) {
        const status = (err as { response?: { status?: number } }).response?.status;
        if (status === 401 || status === 403) {
            return `Your ${platform} account connection has expired. Please reconnect.`;
        }
        if (status === 429) {
            return `${platform} rate limit reached. Please try again later.`;
        }
        if (status && status >= 500) {
            return `${platform} is experiencing issues. Please try again later.`;
        }
    }
    return `Publishing to ${platform} failed. Please try again.`;
}

// ─── Core publish logic ───────────────────────────────────────────────────────

export async function runPublishJob(
    data: PublishJobData,
    attemptsMade = 0,
    maxAttempts = 3
): Promise<void> {
    const { postId, postTargetId, userId, platform } = data;

    logger.info("Processing publish job", {
        postTargetId,
        platform,
        attempt: attemptsMade + 1,
        maxAttempts,
    });

    try {
        // ── 1. Mark target as UPLOADING ────────────────────────────────────────
        await prisma.postTarget.update({
            where: { id: postTargetId },
            data: { publish_status: "UPLOADING" },
        });

        // ── 2. Fetch the post and target ───────────────────────────────────────
        const post = await prisma.post.findUnique({
            where: { id: postId },
            include: { targets: { where: { id: postTargetId } } },
        });

        if (!post || !post.targets[0]) {
            // Non-retryable: data missing from DB
            await markTargetFailed(postTargetId, postId, "Post data not found.", attemptsMade + 1);
            return;
        }

        const postTarget = post.targets[0];

        // ── 3. Fetch the connected account ─────────────────────────────────────
        const account = await prisma.connectedAccount.findUnique({
            where: { user_id_platform: { user_id: userId, platform } },
        });

        if (!account) {
            await markTargetFailed(
                postTargetId,
                postId,
                `Your ${platform} account is no longer connected. Please reconnect.`,
                attemptsMade + 1
            );
            return;
        }

        if (account.status === "EXPIRED" || account.status === "REVOKED") {
            await markTargetFailed(
                postTargetId,
                postId,
                `Your ${platform} connection has expired. Please reconnect your account.`,
                attemptsMade + 1
            );
            return;
        }

        // ── 4. Call the platform adapter ───────────────────────────────────────
        const adapter = getAdapter(platform);
        const result = await adapter.publish(
            account,
            postTarget,
            post.media_url,
            post.media_type
        );

        if (result.success) {
            await prisma.postTarget.update({
                where: { id: postTargetId },
                data: {
                    publish_status: "PUBLISHED",
                    platform_post_url: result.platformPostUrl ?? null,
                    error_message: null,
                    retry_count: attemptsMade,
                    published_at: new Date(),
                },
            });
            await reconcilePostStatus(postId);
            logger.info("Publish job completed", { postTargetId, platform });
        } else {
            // Adapter returned failure — retry if attempts remain
            const isLastAttempt = attemptsMade + 1 >= maxAttempts;
            if (isLastAttempt) {
                await markTargetFailed(
                    postTargetId,
                    postId,
                    result.errorMessage ?? "Publish failed",
                    attemptsMade + 1
                );
                return;
            }

            // Retry with exponential back-off: 5s → 25s → 125s
            const delayMs = Math.pow(5, attemptsMade + 1) * 1000;
            logger.warn(`Publish attempt ${attemptsMade + 1} failed, retrying in ${delayMs / 1000}s`, {
                platform,
                postTargetId,
                error: result.errorMessage,
            });

            await sleep(delayMs);
            await runPublishJob(data, attemptsMade + 1, maxAttempts);
        }
    } catch (err: unknown) {
        const isLastAttempt = attemptsMade + 1 >= maxAttempts;
        const userMessage = toUserError(err, platform);

        logger.error("Publish job threw an error", {
            platform,
            postTargetId,
            attempt: attemptsMade + 1,
            isLastAttempt,
            error: err instanceof Error ? err.message : String(err),
        });

        if (isLastAttempt) {
            await markTargetFailed(postTargetId, postId, userMessage, attemptsMade + 1);
            return;
        }

        // Retry with exponential back-off
        const delayMs = Math.pow(5, attemptsMade + 1) * 1000;
        logger.warn(`Retrying in ${delayMs / 1000}s...`, { platform, postTargetId });
        await sleep(delayMs);
        await runPublishJob(data, attemptsMade + 1, maxAttempts);
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function markTargetFailed(
    postTargetId: string,
    postId: string,
    errorMessage: string,
    retryCount: number
): Promise<void> {
    await prisma.postTarget.update({
        where: { id: postTargetId },
        data: {
            publish_status: "FAILED",
            error_message: errorMessage,
            retry_count: retryCount,
            published_at: null,
        },
    });
    await reconcilePostStatus(postId);
}

async function reconcilePostStatus(postId: string): Promise<void> {
    const targets = await prisma.postTarget.findMany({
        where: { post_id: postId },
        select: { publish_status: true },
    });

    const allDone = targets.every(
        (t) => t.publish_status === "PUBLISHED" || t.publish_status === "FAILED"
    );

    if (!allDone) return;

    const allPublished = targets.every((t) => t.publish_status === "PUBLISHED");

    await prisma.post.update({
        where: { id: postId },
        data: {
            status: allPublished ? "COMPLETED" : "PARTIALLY_FAILED",
        },
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

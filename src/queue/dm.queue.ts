/**
 * DM Queue — rate-limited Instagram DM dispatcher.
 *
 * Problem: 1000 comments on a reel fire 1000 DMs simultaneously.
 * Instagram allows ~200 DMs/hour per business account. Burst = account flag/ban.
 *
 * Solution: per-account FIFO queue, draining at max 180 DMs/hour (safe margin).
 * No Redis needed — in-memory is fine because:
 *   - We're on a single Render instance
 *   - If the server restarts, queued DMs are lost — acceptable (comment already happened)
 *
 * Usage:
 *   enqueueDM(accountId, () => sendInstagramDM(account, userId, text))
 */

import { logger } from "../lib/logger";

// 180 DMs/hour = 1 DM every 20 seconds (safe under Meta's 200/hour limit)
const DM_INTERVAL_MS = 20_000;

interface DMJob {
    fn: () => Promise<void>;
    addedAt: number;
}

// One queue per Instagram connected account ID
const queues = new Map<string, DMJob[]>();
const timers = new Map<string, NodeJS.Timeout>();

/**
 * Enqueue a DM send function for the given account.
 * The function will be called respecting the 180/hour rate limit.
 */
export function enqueueDM(accountId: string, fn: () => Promise<void>): void {
    if (!queues.has(accountId)) {
        queues.set(accountId, []);
    }

    queues.get(accountId)!.push({ fn, addedAt: Date.now() });

    logger.debug("DM enqueued", {
        accountId,
        queueLength: queues.get(accountId)!.length,
    });

    // Start draining if not already running
    if (!timers.has(accountId)) {
        drainNext(accountId);
    }
}

function drainNext(accountId: string): void {
    const queue = queues.get(accountId);

    if (!queue || queue.length === 0) {
        // Queue empty — stop timer
        timers.delete(accountId);
        queues.delete(accountId);
        return;
    }

    const job = queue.shift()!;

    job.fn().catch((err: Error) => {
        logger.error("DM queue job failed", {
            accountId,
            error: err.message,
        });
    });

    // Schedule next DM after interval
    const timer = setTimeout(() => {
        timers.delete(accountId);
        drainNext(accountId);
    }, DM_INTERVAL_MS);

    timers.set(accountId, timer);
}

/** How many DMs are currently waiting for a given account. */
export function getDMQueueLength(accountId: string): number {
    return queues.get(accountId)?.length ?? 0;
}

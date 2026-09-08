/**
 * BullMQ Redis connection — configured for Upstash TLS.
 *
 * Upstash ioredis connection string format:
 *   rediss://default:<PASSWORD>@<host>.upstash.io:6379
 */
import IORedis from "ioredis";
import { env } from "../config/env";
import { logger } from "../lib/logger";

function buildRedisUrl(raw: string): string {
    if (raw.startsWith("rediss://") || raw.startsWith("redis://")) {
        return raw;
    }
    // Upstash REST URL — convert to ioredis format using UPSTASH_REDIS_TOKEN
    if (raw.startsWith("https://")) {
        const token = env.UPSTASH_REDIS_TOKEN || "";
        const host = raw.replace("https://", "").replace(/\/$/, "");
        if (token) return `rediss://default:${token}@${host}:6379`;
        logger.warn("UPSTASH_REDIS_URL is https:// without a token — BullMQ will be disabled.");
    }
    return raw;
}

const redisUrl = buildRedisUrl(env.UPSTASH_REDIS_URL);

export const redisConnection = new IORedis(redisUrl, {
    tls: redisUrl.startsWith("rediss://") ? {} : undefined,
    maxRetriesPerRequest: null,   // required by BullMQ
    enableReadyCheck: false,
    lazyConnect: true,            // don't connect until first command
    connectTimeout: 5000,
    retryStrategy: (times: number) => {
        // Back off up to 60 s — avoids log spam when Redis is unavailable
        return Math.min(times * 2000, 60_000);
    },
});

// ─── Track connection availability ───────────────────────────────────────────

export let redisQueueAvailable = false;

let _loggedConnected = false;
let _loggedError = false;

redisConnection.on("ready", () => {
    redisQueueAvailable = true;
    _loggedError = false;
    if (!_loggedConnected) {
        logger.info("BullMQ Redis connection established");
        _loggedConnected = true;
    }
});

redisConnection.on("error", (err: Error) => {
    redisQueueAvailable = false;
    _loggedConnected = false;
    if (!_loggedError) {
        // Log once per disconnect cycle — don't spam
        logger.warn("BullMQ Redis unavailable — publish jobs will run inline.", {
            reason: err.message,
        });
        _loggedError = true;
    }
});

redisConnection.on("reconnecting", () => {
    // Suppress reconnect spam — error log above is enough
});

/** Ping BullMQ Redis — used by /health */
export async function pingRedis(): Promise<boolean> {
    try {
        const pong = await redisConnection.ping();
        return pong === "PONG";
    } catch {
        return false;
    }
}

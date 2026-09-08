/**
 * Upstash Redis client — uses the REST API over HTTPS.
 * Works in any environment regardless of TCP/firewall restrictions.
 *
 * Drop-in helpers that mirror the ioredis API surface we actually use:
 *   get, set, setex, del, ping
 *
 * In-memory fallback: when Redis is unavailable (network/expired credentials),
 * all operations fall back to a local Map with TTL support.
 * This keeps OAuth state and OTP flows working in development without Redis.
 *
 * ⚠️  The in-memory fallback is NOT suitable for production multi-instance
 *     deployments — it is local to the process. For production, always provide
 *     valid UPSTASH_REDIS_URL and UPSTASH_REDIS_TOKEN.
 */
import { Redis } from "@upstash/redis";
import { env } from "../config/env";
import { logger } from "./logger";

// ─── Upstash client ───────────────────────────────────────────────────────────

let _client: Redis | null = null;
let _redisAvailable: boolean | null = null; // null = not tested yet

function getClient(): Redis {
    if (_client) return _client;
    if (!env.UPSTASH_REDIS_URL || !env.UPSTASH_REDIS_TOKEN) {
        throw new Error("UPSTASH_REDIS_URL and UPSTASH_REDIS_TOKEN must be set");
    }
    _client = new Redis({
        url: env.UPSTASH_REDIS_URL,
        token: env.UPSTASH_REDIS_TOKEN,
        retry: {
            retries: 1,
            backoff: () => 500,
        },
    });
    return _client;
}

// ─── In-memory fallback ───────────────────────────────────────────────────────

interface MemEntry {
    value: string;
    expiresAt: number | null; // epoch ms, null = no expiry
}

const memStore = new Map<string, MemEntry>();

function memGet(key: string): unknown | null {
    const entry = memStore.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
        memStore.delete(key);
        return null;
    }
    // Match Upstash auto-deserialize behaviour: try JSON parse
    try {
        return JSON.parse(entry.value);
    } catch {
        return entry.value;
    }
}

function memSet(key: string, value: string, ttlSeconds?: number): void {
    memStore.set(key, {
        value,
        expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    });
}

function memDel(key: string): void {
    memStore.delete(key);
}

// ─── Availability cache (re-test every 60 s) ─────────────────────────────────

let _lastAvailabilityCheck = 0;
const AVAILABILITY_CACHE_MS = 60_000;

async function isRedisAvailable(): Promise<boolean> {
    const now = Date.now();
    // Use cached result
    if (_redisAvailable !== null && now - _lastAvailabilityCheck < AVAILABILITY_CACHE_MS) {
        return _redisAvailable;
    }
    try {
        await getClient().ping();
        if (_redisAvailable === false) {
            logger.info("Redis connection restored — switching back from in-memory fallback.");
        }
        _redisAvailable = true;
    } catch {
        if (_redisAvailable !== false) {
            logger.warn("Redis unavailable — using in-memory fallback for OAuth state & OTP.");
        }
        _redisAvailable = false;
    }
    _lastAvailabilityCheck = now;
    return _redisAvailable;
}

// ─── Public interface ─────────────────────────────────────────────────────────

export const upstashRedis = {
    async ping(): Promise<string> {
        await getClient().ping();
        return "PONG";
    },

    // NOTE: @upstash/redis auto-deserializes JSON, so the returned value may
    // be an object at runtime even though we stored a JSON string. Return type
    // is `unknown` to reflect this.
    async get(key: string): Promise<unknown | null> {
        if (!(await isRedisAvailable())) {
            return memGet(key);
        }
        try {
            const val = await getClient().get<unknown>(key);
            return val ?? null;
        } catch {
            _redisAvailable = false;
            return memGet(key);
        }
    },

    async set(key: string, value: string): Promise<void> {
        if (!(await isRedisAvailable())) {
            memSet(key, value);
            return;
        }
        try {
            await getClient().set(key, value);
        } catch {
            _redisAvailable = false;
            memSet(key, value);
        }
    },

    async setex(key: string, ttlSeconds: number, value: string): Promise<void> {
        if (!(await isRedisAvailable())) {
            memSet(key, value, ttlSeconds);
            return;
        }
        try {
            await getClient().set(key, value, { ex: ttlSeconds });
        } catch {
            _redisAvailable = false;
            memSet(key, value, ttlSeconds);
        }
    },

    async del(key: string): Promise<void> {
        if (!(await isRedisAvailable())) {
            memDel(key);
            return;
        }
        try {
            await getClient().del(key);
        } catch {
            _redisAvailable = false;
            memDel(key);
        }
    },
};

/** Ping check for /health endpoint */
export async function pingRedisHttp(): Promise<boolean> {
    try {
        const result = await upstashRedis.ping();
        return result === "PONG";
    } catch (err) {
        logger.warn("Upstash Redis ping failed", { error: (err as Error).message });
        return false;
    }
}

/**
 * In-memory store — replaces Redis for OTP and OAuth state storage.
 *
 * Uses a plain Map with TTL support. Entries are automatically expired
 * on get/cleanup. A periodic sweep removes stale entries every 5 minutes.
 *
 * ⚠️  Single-process only — suitable for local dev and single-instance deployments.
 *     For multi-instance production, swap this with a shared store (DB, Memcached, etc).
 */
import { logger } from "./logger";

interface StoreEntry {
    value: string;
    expiresAt: number | null; // epoch ms, null = no expiry
}

const store = new Map<string, StoreEntry>();

// ─── Sweep expired keys every 5 minutes ──────────────────────────────────────
setInterval(() => {
    const now = Date.now();
    let swept = 0;
    for (const [key, entry] of store.entries()) {
        if (entry.expiresAt !== null && now > entry.expiresAt) {
            store.delete(key);
            swept++;
        }
    }
    if (swept > 0) {
        logger.debug(`In-memory store: swept ${swept} expired entries`);
    }
}, 5 * 60 * 1000).unref(); // .unref() so it doesn't keep the process alive

// ─── Public API (mirrors the Redis interface used across the codebase) ─────────

export const memoryStore = {
    /** Set a key that expires after ttlSeconds. */
    setex(key: string, ttlSeconds: number, value: string): void {
        store.set(key, {
            value,
            expiresAt: Date.now() + ttlSeconds * 1000,
        });
    },

    /** Set a key with no expiry. */
    set(key: string, value: string): void {
        store.set(key, { value, expiresAt: null });
    },

    /** Get a key. Returns null if missing or expired. */
    get(key: string): string | null {
        const entry = store.get(key);
        if (!entry) return null;
        if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
            store.delete(key);
            return null;
        }
        return entry.value;
    },

    /** Delete a key. */
    del(key: string): void {
        store.delete(key);
    },

    /** Returns current store size (for debugging). */
    size(): number {
        return store.size;
    },
};

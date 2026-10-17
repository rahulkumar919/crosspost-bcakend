/**
 * Instagram Webhook Handler
 *
 * GET  /webhooks/instagram  — Meta hub challenge verification
 * POST /webhooks/instagram  — Receive events (messages, comments)
 *
 * Security:
 *   - GET  : validates hub.verify_token against INSTAGRAM_WEBHOOK_SECRET
 *   - POST : validates X-Hub-Signature-256 HMAC-SHA256 computed over the RAW
 *            request body bytes using INSTAGRAM_APP_SECRET (= Meta App Secret).
 *            We use the raw buffer captured by the express.json `verify`
 *            callback to match exactly what Meta signed — not a re-serialised
 *            JSON string, which would differ in whitespace / key order.
 *
 * Flow:
 *   Raw payload → HMAC verify → normalize → idempotency → AutomationEngine
 */
import { Router, Request, Response } from "express";
import crypto from "crypto";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import { prisma } from "../config/db";
import { processEvent } from "../automation/AutomationEngine";
import { normalizeInstagramPayload } from "../automation/events/normalizeInstagram";

const router = Router();

// ─── GET — Webhook Verification ───────────────────────────────────────────────

router.get("/", (req: Request, res: Response): void => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (!env.INSTAGRAM_WEBHOOK_SECRET) {
        logger.error("Instagram webhook: INSTAGRAM_WEBHOOK_SECRET is not set — cannot verify");
        res.status(500).json({ error: "Webhook secret not configured" });
        return;
    }

    if (mode === "subscribe" && token === env.INSTAGRAM_WEBHOOK_SECRET) {
        logger.info("Instagram webhook verified successfully");
        res.status(200).send(challenge);
        return;
    }

    logger.warn("Instagram webhook verification failed", {
        mode,
        tokenProvided: !!token,
    });
    res.status(403).json({ error: "Webhook verification failed" });
});

// ─── POST — Event Receiver ────────────────────────────────────────────────────

router.post("/", async (req: Request, res: Response): Promise<void> => {
    // Always respond 200 immediately — Meta retries if we return non-2xx or time out.
    res.status(200).json({ received: true });

    // ── Signature verification ────────────────────────────────────────────────
    const signature = req.headers["x-hub-signature-256"] as string | undefined;

    if (!verifySignature(req.rawBody, signature)) {
        logger.warn("Instagram webhook: invalid or missing HMAC signature — dropping event", {
            hasRawBody: !!req.rawBody,
            hasSignature: !!signature,
        });
        return;
    }

    const rawBody = req.body as {
        object?: string;
        entry?: Array<{ id: string }>;
    };

    try {
        // Reject non-Instagram objects (defensive)
        if (rawBody.object && rawBody.object !== "instagram") {
            logger.debug("Instagram webhook: unexpected object type", { object: rawBody.object });
            return;
        }

        // Load all connected Instagram accounts so we can route each entry
        // to the correct user by matching entry.id (= the account's IGID).
        const igAccounts = await prisma.connectedAccount.findMany({
            where: { platform: "INSTAGRAM", status: "CONNECTED" },
            select: { id: true, user_id: true, platform_account_id: true },
        });

        if (igAccounts.length === 0) {
            logger.debug("Instagram webhook: no connected Instagram accounts — nothing to route");
            return;
        }

        const entries = rawBody.entry ?? [];

        for (const entry of entries) {
            const igid = entry.id;
            const account = igAccounts.find((a) => a.platform_account_id === igid);

            if (!account) {
                logger.debug("Instagram webhook: no connected account matched IGID", {
                    igid: igid?.slice(0, 12) + "…",
                });
                continue;
            }

            const events = normalizeInstagramPayload(rawBody, account.id, account.user_id);

            for (const event of events) {
                // Fire-and-forget — respond 200 first, process asynchronously.
                // setImmediate ensures the response has been flushed before we do DB work.
                setImmediate(() => {
                    processEvent(event).catch((err: Error) => {
                        logger.error("Instagram webhook: AutomationEngine error", {
                            error: err.message,
                            externalMessageId: event.externalMessageId,
                        });
                    });
                });
            }
        }
    } catch (err) {
        logger.error("Instagram webhook: unhandled processing error", {
            error: err instanceof Error ? err.message : String(err),
        });
    }
});

// ─── HMAC Signature Verification ─────────────────────────────────────────────

/**
 * Verifies X-Hub-Signature-256 from Meta using the raw request body buffer.
 *
 * Meta computes:  sha256=HMAC_SHA256(APP_SECRET, rawBody)
 *
 * Rules:
 *  - Must use the raw bytes, NOT JSON.stringify(parsedBody) — those differ.
 *  - Length check before timingSafeEqual to avoid Buffer size mismatch crash.
 *  - In development with no secret configured, allow through with a warning.
 */
function verifySignature(rawBody: Buffer | undefined, signature: string | undefined): boolean {
    const secret = env.INSTAGRAM_APP_SECRET || env.INSTAGRAM_CLIENT_SECRET;

    if (!secret) {
        // No secret set — skip in dev, reject in prod
        if (env.NODE_ENV === "production") {
            logger.error("Instagram webhook: INSTAGRAM_APP_SECRET not set — rejecting all POST events in production");
            return false;
        }
        logger.warn("Instagram webhook: INSTAGRAM_APP_SECRET not set — signature check skipped in development");
        return true;
    }

    if (!signature || !rawBody) {
        logger.warn("Instagram webhook: missing signature or raw body");
        return false;
    }

    if (!signature.startsWith("sha256=")) {
        logger.warn("Instagram webhook: signature missing sha256= prefix");
        return false;
    }

    const expected = "sha256=" + crypto
        .createHmac("sha256", secret)
        .update(rawBody)          // ← raw bytes, not JSON.stringify
        .digest("hex");

    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);

    // Length check prevents crash from timingSafeEqual on mismatched sizes
    if (sigBuf.length !== expBuf.length) {
        logger.warn("Instagram webhook: signature length mismatch");
        return false;
    }

    return crypto.timingSafeEqual(sigBuf, expBuf);
}

export default router;

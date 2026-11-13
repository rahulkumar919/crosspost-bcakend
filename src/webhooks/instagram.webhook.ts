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
import { normalizeInstagramEntry, type IGWebhookEntry } from "../automation/events/normalizeInstagram";

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
    logger.info("webhook_received", {
        stage: "webhook_received",
        headers: {
            signature: req.headers["x-hub-signature-256"] ? "present" : "missing",
            contentType: req.headers["content-type"],
        },
    });

    // ── Signature verification ────────────────────────────────────────────────
    const signature = req.headers["x-hub-signature-256"] as string | undefined;

    if (!verifySignature(req.rawBody, signature)) {
        logger.warn("signature_failed", {
            stage: "signature_failed",
            hasRawBody: !!req.rawBody,
            hasSignature: !!signature,
        });
        res.status(401).json({ error: "Invalid signature" });
        return;
    }

    logger.info("signature_ok", { stage: "signature_ok" });

    // Respond 200 quickly once verified
    res.status(200).json({ received: true });

    const rawBody = req.body as {
        object?: string;
        entry?: IGWebhookEntry[];
    };

    try {
        // Reject non-Instagram objects (defensive)
        if (rawBody.object && rawBody.object !== "instagram") {
            logger.debug("Instagram webhook: unexpected object type", { object: rawBody.object });
            return;
        }

        const entries = rawBody.entry ?? [];

        // Load all connected Instagram accounts so we can route each entry
        // to the correct user by matching entry.id (= the account's IGID).
        const igAccounts = await prisma.connectedAccount.findMany({
            where: { platform: "INSTAGRAM", status: "CONNECTED" },
            select: { id: true, user_id: true, platform_account_id: true },
        });

        if (igAccounts.length === 0) {
            logger.warn("account_not_found", {
                stage: "account_not_found",
                reason: "no connected Instagram accounts in DB",
            });
            return;
        }

        for (const entry of entries) {
            const igid = entry.id;

            // Match by platform_account_id, or fallback if only 1 account exists
            const account = igAccounts.find((a) => a.platform_account_id === igid) ||
                (igAccounts.length === 1 ? igAccounts[0] : null);

            logger.info("account_match_check", {
                stage: account ? "account_matched" : "account_not_found",
                entryId: igid,
                matchedAccountId: account?.id,
                matchedPlatformAccountId: account?.platform_account_id,
                storedAccountIds: igAccounts.map(a => a.platform_account_id),
            });

            if (!account) {
                logger.warn("account_not_found", {
                    stage: "account_not_found",
                    igid,
                    availableAccounts: igAccounts.map(a => ({ id: a.id, platform_account_id: a.platform_account_id })),
                });
                continue;
            }

            // Pass the single matched entry — prevents cross-account event misattribution
            const events = normalizeInstagramEntry(entry, account.id, account.user_id);
            logger.info("event_parsed", {
                stage: "event_parsed",
                count: events.length,
                events: events.map(e => ({
                    isComment: e.isComment,
                    messageType: e.messageType,
                    externalMessageId: e.externalMessageId,
                    commentId: e.commentId,
                    senderId: e.externalUserId,
                })),
            });

            for (const event of events) {
                // Execute inline / next-tick without delay
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
 * Checks both INSTAGRAM_APP_SECRET and INSTAGRAM_CLIENT_SECRET.
 */
function verifySignature(rawBody: Buffer | undefined, signature: string | undefined): boolean {
    const secrets = [env.INSTAGRAM_APP_SECRET, env.INSTAGRAM_CLIENT_SECRET].filter(Boolean);

    if (secrets.length === 0) {
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

    const sigBuf = Buffer.from(signature);

    for (const secret of secrets) {
        const expected = "sha256=" + crypto
            .createHmac("sha256", secret)
            .update(rawBody)
            .digest("hex");

        const expBuf = Buffer.from(expected);

        if (sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf)) {
            return true;
        }
    }

    logger.warn("Instagram webhook: HMAC signature mismatch with all configured secrets");
    return false;
}

export default router;

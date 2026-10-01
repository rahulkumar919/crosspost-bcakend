/**
 * Instagram Webhook Handler
 *
 * GET  /webhooks/instagram  — Meta hub challenge verification
 * POST /webhooks/instagram  — Receive events (messages, comments)
 *
 * Security:
 *   - GET: validates hub.verify_token against INSTAGRAM_WEBHOOK_SECRET
 *   - POST: validates X-Hub-Signature-256 HMAC with INSTAGRAM_APP_SECRET
 *
 * Flow:
 *   Raw payload → signature verify → normalize → idempotency → AutomationEngine
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

    if (mode === "subscribe" && token === env.INSTAGRAM_WEBHOOK_SECRET) {
        logger.info("Instagram webhook verified successfully");
        res.status(200).send(challenge);
        return;
    }

    logger.warn("Instagram webhook verification failed", {
        mode,
        tokenMatch: token === env.INSTAGRAM_WEBHOOK_SECRET,
    });
    res.status(403).json({ error: "Webhook verification failed" });
});

// ─── POST — Event Receiver ────────────────────────────────────────────────────

router.post("/", async (req: Request, res: Response): Promise<void> => {
    // Always respond 200 immediately — Meta retries if we take too long
    res.status(200).json({ received: true });

    // Verify HMAC signature
    const signature = req.headers["x-hub-signature-256"] as string;
    if (!verifySignature(req.body, signature)) {
        logger.warn("Instagram webhook: invalid signature — dropping event");
        return;
    }

    const rawBody = req.body;

    try {
        // Find all users who have Instagram connected
        // We need to map the IGID in the payload to a ConnectedAccount
        const igAccounts = await prisma.connectedAccount.findMany({
            where: { platform: "INSTAGRAM", status: "CONNECTED" },
            select: { id: true, user_id: true, platform_account_id: true },
        });

        if (igAccounts.length === 0) return;

        // Route to the correct account by matching entry.id (IGID)
        const entries = (rawBody as { entry?: Array<{ id: string }> })?.entry ?? [];

        for (const entry of entries) {
            const igid = entry.id;
            const account = igAccounts.find((a) => a.platform_account_id === igid);

            if (!account) {
                logger.debug("Instagram webhook: no account found for IGID", { igid });
                continue;
            }

            const events = normalizeInstagramPayload(rawBody, account.id, account.user_id);

            for (const event of events) {
                // Process each event asynchronously — don't await (non-blocking)
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
        logger.error("Instagram webhook: unhandled error", {
            error: err instanceof Error ? err.message : String(err),
        });
    }
});

// ─── Signature Verification ───────────────────────────────────────────────────

function verifySignature(body: unknown, signature: string): boolean {
    const secret = env.INSTAGRAM_APP_SECRET || env.INSTAGRAM_CLIENT_SECRET;
    if (!secret) {
        logger.warn("Instagram webhook: no APP_SECRET configured — skipping signature verification in dev");
        return env.NODE_ENV !== "production"; // allow in dev, block in prod
    }
    if (!signature) return false;

    const expected = "sha256=" + crypto
        .createHmac("sha256", secret)
        .update(JSON.stringify(body))
        .digest("hex");

    return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expected)
    );
}

export default router;

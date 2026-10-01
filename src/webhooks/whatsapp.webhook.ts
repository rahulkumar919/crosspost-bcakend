/**
 * WhatsApp Webhook Handler
 *
 * GET  /webhooks/whatsapp  — Meta hub challenge verification
 * POST /webhooks/whatsapp  — Receive inbound WhatsApp messages
 *
 * Security:
 *   - GET: validates hub.verify_token against WHATSAPP_VERIFY_TOKEN
 *   - POST: validates X-Hub-Signature-256 HMAC with WHATSAPP_APP_SECRET
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
import { normalizeWhatsAppPayload } from "../automation/events/normalizeWhatsApp";

const router = Router();

// ─── GET — Webhook Verification ───────────────────────────────────────────────

router.get("/", (req: Request, res: Response): void => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === env.WHATSAPP_VERIFY_TOKEN) {
        logger.info("WhatsApp webhook verified successfully");
        res.status(200).send(challenge);
        return;
    }

    logger.warn("WhatsApp webhook verification failed", {
        mode,
        tokenMatch: token === env.WHATSAPP_VERIFY_TOKEN,
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
        logger.warn("WhatsApp webhook: invalid signature — dropping event");
        return;
    }

    const rawBody = req.body;

    try {
        // Extract phone_number_id from the payload to match to a WhatsAppAccount
        const entries = (rawBody as { entry?: Array<{ changes?: Array<{ value?: { metadata?: { phone_number_id?: string } } }> }> })?.entry ?? [];

        for (const entry of entries) {
            for (const change of entry.changes ?? []) {
                const phoneNumberId = change.value?.metadata?.phone_number_id;
                if (!phoneNumberId) continue;

                // Find the WhatsApp account by phone_number_id
                const waAccount = await prisma.whatsAppAccount.findFirst({
                    where: { phone_number_id: phoneNumberId, status: "CONNECTED" },
                    select: { id: true, user_id: true },
                });

                if (!waAccount) {
                    logger.debug("WhatsApp webhook: no account found for phone_number_id", { phoneNumberId });
                    continue;
                }

                const events = normalizeWhatsAppPayload(rawBody, waAccount.id, waAccount.user_id);

                for (const event of events) {
                    // Process each event asynchronously — don't block webhook response
                    setImmediate(() => {
                        processEvent(event).catch((err: Error) => {
                            logger.error("WhatsApp webhook: AutomationEngine error", {
                                error: err.message,
                                externalMessageId: event.externalMessageId,
                            });
                        });
                    });
                }
            }
        }
    } catch (err) {
        logger.error("WhatsApp webhook: unhandled error", {
            error: err instanceof Error ? err.message : String(err),
        });
    }
});

// ─── Signature Verification ───────────────────────────────────────────────────

function verifySignature(body: unknown, signature: string): boolean {
    const secret = env.WHATSAPP_APP_SECRET;
    if (!secret) {
        logger.warn("WhatsApp webhook: no APP_SECRET configured — skipping verification in dev");
        return env.NODE_ENV !== "production";
    }
    if (!signature) return false;

    const expected = "sha256=" + crypto
        .createHmac("sha256", secret)
        .update(JSON.stringify(body))
        .digest("hex");

    try {
        return crypto.timingSafeEqual(
            Buffer.from(signature),
            Buffer.from(expected)
        );
    } catch {
        return false;
    }
}

export default router;

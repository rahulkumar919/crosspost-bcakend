/**
 * WhatsApp Cloud API Adapter
 *
 * Sends messages via the Meta WhatsApp Business Cloud API.
 *
 * Endpoint: POST https://graph.facebook.com/v21.0/{phone-number-id}/messages
 *
 * Supports:
 *   - Text messages (within 24h conversation window)
 *   - Text with embedded URL (no fake buttons)
 *   - Interactive reply buttons (up to 3 options)
 *
 * ⚠️  CONVERSATION WINDOW:
 *     Free-form messages can only be sent within 24 hours of the user's last message.
 *     Outside this window, only pre-approved Message Templates can be sent.
 *     This adapter enforces that rule.
 *
 * References:
 *   https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages
 */
import axios from "axios";
import { WhatsAppAccount } from "@prisma/client";
import { decrypt } from "../lib/encryption";
import { logger } from "../lib/logger";
import { AppError } from "../middleware/error-handler.middleware";

const WA_API_BASE = "https://graph.facebook.com/v21.0";

// ─── Send Text Message ────────────────────────────────────────────────────────

/**
 * Send a plain text WhatsApp message.
 *
 * @param account - WhatsAppAccount record (access_token is AES-256 encrypted)
 * @param to      - Recipient phone number in E.164 format (e.g. 919876543210)
 * @param text    - Message text
 */
export async function sendWhatsAppMessage(
    account: WhatsAppAccount,
    to: string,
    text: string
): Promise<void> {
    const accessToken = decrypt(account.access_token);
    const phoneNumberId = account.phone_number_id;

    try {
        await axios.post(
            `${WA_API_BASE}/${phoneNumberId}/messages`,
            {
                messaging_product: "whatsapp",
                recipient_type: "individual",
                to,
                type: "text",
                text: {
                    preview_url: false,
                    body: text.slice(0, 4096), // WA text limit
                },
            },
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": "application/json",
                },
                timeout: 15_000,
            }
        );

        logger.info("WhatsApp message sent", {
            accountId: account.id,
            phoneNumberId,
            to: to.slice(0, 4) + "***",
        });
    } catch (err: unknown) {
        handleWhatsAppError(err, account.id, "sendWhatsAppMessage");
    }
}

// ─── Send Interactive Buttons ─────────────────────────────────────────────────

export interface WhatsAppButton {
    id: string;    // max 256 chars
    title: string; // max 20 chars
}

/**
 * Send a WhatsApp message with up to 3 reply buttons.
 * Only supported within the 24-hour conversation window.
 */
export async function sendWhatsAppInteractive(
    account: WhatsAppAccount,
    to: string,
    bodyText: string,
    buttons: WhatsAppButton[]
): Promise<void> {
    if (buttons.length === 0 || buttons.length > 3) {
        throw new Error("WhatsApp interactive messages require 1–3 buttons");
    }

    const accessToken = decrypt(account.access_token);
    const phoneNumberId = account.phone_number_id;

    const buttonPayload = buttons.map((b) => ({
        type: "reply",
        reply: {
            id: b.id.slice(0, 256),
            title: b.title.slice(0, 20),
        },
    }));

    try {
        await axios.post(
            `${WA_API_BASE}/${phoneNumberId}/messages`,
            {
                messaging_product: "whatsapp",
                recipient_type: "individual",
                to,
                type: "interactive",
                interactive: {
                    type: "button",
                    body: { text: bodyText.slice(0, 1024) },
                    action: { buttons: buttonPayload },
                },
            },
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": "application/json",
                },
                timeout: 15_000,
            }
        );

        logger.info("WhatsApp interactive message sent", { accountId: account.id, to: to.slice(0, 4) + "***" });
    } catch (err: unknown) {
        handleWhatsAppError(err, account.id, "sendWhatsAppInteractive");
    }
}

// ─── Error Handler ────────────────────────────────────────────────────────────

function handleWhatsAppError(err: unknown, accountId: string, fn: string): never {
    const axErr = err as { response?: { status?: number; data?: unknown }; message?: string };
    const status = axErr.response?.status;
    const detail = axErr.response?.data;

    logger.error(`WhatsApp adapter error [${fn}]`, {
        status,
        detail: JSON.stringify(detail),
        accountId,
    });

    if (status === 401) {
        throw new AppError(
            "WhatsApp access token expired. Please reconnect your WhatsApp account.",
            401,
            "WA_TOKEN_EXPIRED"
        );
    }
    if (status === 400) {
        // Check for conversation window error
        const errCode = (detail as { error?: { code?: number } })?.error?.code;
        if (errCode === 131047 || errCode === 130429) {
            throw new AppError(
                "WhatsApp 24-hour conversation window has expired. Only template messages can be sent now.",
                400,
                "WA_WINDOW_EXPIRED"
            );
        }
    }
    if (status === 429) {
        throw new AppError(
            "WhatsApp rate limit reached. Please try again later.",
            429,
            "WA_RATE_LIMITED"
        );
    }
    throw new AppError(
        `WhatsApp message failed: ${axErr.message ?? "Unknown error"}`,
        502,
        "WA_SEND_FAILED"
    );
}

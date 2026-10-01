/**
 * WhatsApp Cloud API webhook payload normalizer.
 *
 * Converts Meta's raw WhatsApp Business webhook payload into NormalizedMessageEvent[].
 *
 * References:
 *   https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 *   API version: v21.0
 */
import type { NormalizedMessageEvent } from "./NormalizedEvent";
import { logger } from "../../lib/logger";

interface WAWebhookEntry {
    id: string; // WABA ID
    changes: WAChange[];
}

interface WAChange {
    value: WAChangeValue;
    field: string;
}

interface WAChangeValue {
    messaging_product: string;
    metadata: {
        display_phone_number: string;
        phone_number_id: string;
    };
    contacts?: Array<{
        profile: { name: string };
        wa_id: string;
    }>;
    messages?: WAMessage[];
    statuses?: WAStatus[];
}

interface WAMessage {
    from: string; // sender phone number
    id: string;   // message ID (wamid)
    timestamp: string;
    type: string; // text | image | video | audio | document | sticker | location | interactive | unknown
    text?: { body: string };
    image?: { caption?: string; mime_type: string; sha256: string; id: string };
    video?: { caption?: string; mime_type: string; sha256: string; id: string };
    audio?: { mime_type: string; sha256: string; id: string; voice?: boolean };
    document?: { caption?: string; filename?: string; mime_type: string; id: string };
    sticker?: { mime_type: string; sha256: string; id: string; animated: boolean };
    interactive?: {
        type: "button_reply" | "list_reply";
        button_reply?: { id: string; title: string };
        list_reply?: { id: string; title: string; description: string };
    };
    context?: { from: string; id: string }; // replied-to message
}

interface WAStatus {
    id: string;
    status: "sent" | "delivered" | "read" | "failed";
    timestamp: string;
    recipient_id: string;
}

export function normalizeWhatsAppPayload(
    rawBody: unknown,
    accountId: string,
    userId: string
): NormalizedMessageEvent[] {
    const events: NormalizedMessageEvent[] = [];

    try {
        const body = rawBody as { object?: string; entry?: WAWebhookEntry[] };
        if (body?.object !== "whatsapp_business_account") return events;
        if (!body?.entry) return events;

        for (const entry of body.entry) {
            for (const change of entry.changes) {
                if (change.field !== "messages") continue;

                const val = change.value;


                // Build contact name map: wa_id → name
                const contactNames: Record<string, string> = {};
                for (const c of val.contacts ?? []) {
                    contactNames[c.wa_id] = c.profile?.name ?? c.wa_id;
                }

                // Process inbound messages
                for (const msg of val.messages ?? []) {
                    const senderPhone = msg.from;
                    const msgId = msg.id;
                    const ts = parseInt(msg.timestamp, 10) * 1000;

                    let messageText = "";
                    let messageType: NormalizedMessageEvent["messageType"] = "text";

                    switch (msg.type) {
                        case "text":
                            messageText = msg.text?.body ?? "";
                            messageType = "text";
                            break;
                        case "image":
                            messageText = msg.image?.caption ?? "[Image]";
                            messageType = "image";
                            break;
                        case "video":
                            messageText = msg.video?.caption ?? "[Video]";
                            messageType = "video";
                            break;
                        case "audio":
                            messageText = "[Voice message]";
                            messageType = "audio";
                            break;
                        case "document":
                            messageText = msg.document?.caption ?? msg.document?.filename ?? "[Document]";
                            messageType = "document";
                            break;
                        case "sticker":
                            messageText = "[Sticker]";
                            messageType = "sticker";
                            break;
                        case "interactive":
                            // User clicked a button — treat button title as message text
                            messageText =
                                msg.interactive?.button_reply?.title ??
                                msg.interactive?.list_reply?.title ??
                                "[Interactive]";
                            messageType = "text";
                            break;
                        default:
                            messageText = `[${msg.type}]`;
                            messageType = "unsupported";
                    }

                    events.push({
                        channel: "WHATSAPP",
                        accountId,
                        userId,
                        externalUserId: senderPhone,
                        externalConversationId: senderPhone, // WA conversation = phone number
                        externalMessageId: msgId,
                        messageText,
                        messageType,
                        isEcho: false, // WhatsApp doesn't echo inbound in messages array
                        isComment: false,
                        senderName: contactNames[senderPhone],
                        timestamp: ts,
                        raw: msg,
                    });
                }
            }
        }
    } catch (err) {
        logger.error("Failed to normalize WhatsApp webhook payload", {
            error: err instanceof Error ? err.message : String(err),
        });
    }

    return events;
}

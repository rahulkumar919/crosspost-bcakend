/**
 * Instagram webhook payload normalizer.
 *
 * Converts Meta's raw Instagram webhook payload into NormalizedMessageEvent[].
 * One webhook delivery can contain multiple events.
 *
 * Handles:
 *   - messages (DMs)
 *   - messaging_seen
 *   - comments (on posts/reels)
 *
 * References:
 *   https://developers.facebook.com/docs/messenger-platform/webhooks
 *   https://developers.facebook.com/docs/instagram-api/guides/webhooks
 */
import type { NormalizedMessageEvent } from "./NormalizedEvent";
import { logger } from "../../lib/logger";

interface IGWebhookEntry {
    id: string; // Instagram Business Account ID (IGID)
    time: number;
    messaging?: IGMessagingEvent[];
    changes?: IGChangeEvent[];
}

interface IGMessagingEvent {
    sender: { id: string };
    recipient: { id: string };
    timestamp: number;
    message?: {
        mid: string;
        text?: string;
        is_echo?: boolean;
        attachments?: Array<{ type: string; payload: { url?: string } }>;
    };
    read?: { watermark: number };
}

interface IGChangeEvent {
    field: string;
    value: {
        id?: string;
        text?: string;
        from?: { id: string; username?: string };
        media?: { id: string };
        parent_id?: string;
        timestamp?: number;
        item?: string;
        verb?: string;
        comment_id?: string;
    };
}

export function normalizeInstagramPayload(
    rawBody: unknown,
    accountId: string,
    userId: string
): NormalizedMessageEvent[] {
    const events: NormalizedMessageEvent[] = [];

    try {
        const body = rawBody as { object?: string; entry?: IGWebhookEntry[] };
        if (!body?.entry) return events;

        for (const entry of body.entry) {
            const igUserId = entry.id; // This account's IGID

            // ── DM / messaging events ──────────────────────────────────────
            for (const msg of entry.messaging ?? []) {
                if (!msg.message) continue; // skip read receipts

                const isEcho = msg.message.is_echo ?? false;
                const text = msg.message.text ?? "";
                const mid = msg.message.mid ?? "";

                let messageType: NormalizedMessageEvent["messageType"] = "text";
                const attachment = msg.message.attachments?.[0];
                if (attachment) {
                    const t = attachment.type as string;
                    if (t === "image") messageType = "image";
                    else if (t === "video") messageType = "video";
                    else if (t === "audio") messageType = "audio";
                    else messageType = "unsupported";
                }

                events.push({
                    channel: "INSTAGRAM",
                    accountId,
                    userId,
                    externalUserId: msg.sender.id,
                    externalConversationId: msg.sender.id, // IG thread = sender PSID
                    externalMessageId: mid,
                    messageText: text,
                    messageType,
                    isEcho,
                    isComment: false,
                    timestamp: msg.timestamp ?? Date.now(),
                    raw: msg,
                });
            }

            // ── Comment events ─────────────────────────────────────────────
            for (const change of entry.changes ?? []) {
                if (change.field !== "comments") continue;
                const val = change.value;
                if (val.verb !== "add") continue; // only new comments

                const commentId = val.comment_id ?? val.id ?? "";
                const fromId = val.from?.id ?? "";
                const text = val.text ?? "";
                const mediaId = val.media?.id ?? "";

                // Skip our own comments (echo prevention)
                if (fromId === igUserId) continue;

                events.push({
                    channel: "INSTAGRAM",
                    accountId,
                    userId,
                    externalUserId: fromId,
                    externalConversationId: fromId,
                    externalMessageId: commentId,
                    messageText: text,
                    messageType: "text",
                    isEcho: false,
                    isComment: true,
                    commentId,
                    postId: mediaId,
                    senderName: val.from?.username,
                    timestamp: (val.timestamp ?? Math.floor(Date.now() / 1000)) * 1000,
                    raw: val,
                });
            }
        }
    } catch (err) {
        logger.error("Failed to normalize Instagram webhook payload", {
            error: err instanceof Error ? err.message : String(err),
        });
    }

    return events;
}

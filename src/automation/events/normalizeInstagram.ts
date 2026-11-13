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

export type { IGWebhookEntry };

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

/**
 * Normalize a single Instagram webhook entry into NormalizedMessageEvents.
 *
 * Accepts ONE entry (not the full payload) so multi-entry deliveries
 * are attributed to the correct account without cross-contamination.
 */
export function normalizeInstagramEntry(
    entry: IGWebhookEntry,
    accountId: string,
    userId: string
): NormalizedMessageEvent[] {
    const events: NormalizedMessageEvent[] = [];

    try {
        const igUserId = entry.id; // This account's IGID

        // ── DM / messaging events ──────────────────────────────────────
        for (const msg of entry.messaging ?? []) {
            if (!msg.message) continue; // skip read receipts, deliveries, reactions, postbacks

            const isEcho = msg.message.is_echo ?? false;
            if (isEcho) continue; // skip echoes

            const senderId = msg.sender?.id ?? "";
            if (!senderId || senderId === igUserId) continue; // skip empty or messages sent by the account itself

            const text = msg.message.text ?? "";
            const mid = msg.message.mid ?? "";
            if (!mid) continue; // must have a message ID

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
                externalConversationId: msg.sender.id,
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
            // Accept both "comments" and "live_comments" webhook fields
            if (change.field !== "comments" && change.field !== "live_comments") continue;
            const val = change.value;
            // Meta does NOT send a 'verb' in Instagram comments payloads.
            // Only skip if verb is explicitly provided and not "add" (e.g. edit/delete).
            if (val.verb && val.verb !== "add") continue;

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
    } catch (err) {
        logger.error("Failed to normalize Instagram webhook entry", {
            error: err instanceof Error ? err.message : String(err),
        });
    }

    return events;
}

/**
 * @deprecated Use normalizeInstagramEntry per entry instead.
 * Kept for backwards compatibility — only safe with single-entry payloads.
 */
export function normalizeInstagramPayload(
    rawBody: unknown,
    accountId: string,
    userId: string
): NormalizedMessageEvent[] {
    const body = rawBody as { entry?: IGWebhookEntry[] };
    if (!body?.entry?.length) return [];
    // With a single entry this is safe; multi-entry payloads should use
    // normalizeInstagramEntry per matched entry (see instagram.webhook.ts).
    return normalizeInstagramEntry(body.entry[0], accountId, userId);
}

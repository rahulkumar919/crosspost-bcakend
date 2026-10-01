/**
 * NormalizedEvent — common internal event format.
 *
 * All platform adapters (Instagram, WhatsApp) convert their
 * raw webhook payloads into this structure before passing to the
 * AutomationEngine. The engine is channel-agnostic.
 */

export type NormalizedMessageType =
    | "text"
    | "image"
    | "video"
    | "audio"
    | "document"
    | "sticker"
    | "location"
    | "unsupported";

export interface NormalizedMessageEvent {
    /** Source channel */
    channel: "INSTAGRAM" | "WHATSAPP";

    /** ConnectedAccount.id (Instagram) or WhatsAppAccount.id (WhatsApp) */
    accountId: string;

    /** CrossPost AI user (workspace owner) */
    userId: string;

    /** Platform user identifier — Instagram PSID or WhatsApp phone number */
    externalUserId: string;

    /** Conversation identifier — Instagram thread ID or WhatsApp phone */
    externalConversationId: string;

    /** Platform's message ID — used for idempotency deduplication */
    externalMessageId: string;

    /** Extracted text content of the message */
    messageText: string;

    /** Message media type */
    messageType: NormalizedMessageType;

    /**
     * true = this is our OWN outbound message echoed back by the platform.
     * The engine MUST skip these to prevent bot-reply loops.
     */
    isEcho: boolean;

    /** true = this is a comment on a post, false = direct message */
    isComment: boolean;

    /** Instagram comment ID (set when isComment === true) */
    commentId?: string;

    /** Instagram post/media ID (set when isComment === true) */
    postId?: string;

    /** Platform user display name — for creating conversation records */
    senderName?: string;

    /** Profile picture URL */
    senderPicture?: string;

    /** Unix timestamp (ms) */
    timestamp: number;

    /** Original raw payload — stored for debugging only, never logged with tokens */
    raw?: unknown;
}

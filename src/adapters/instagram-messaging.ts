/**
 * Instagram Messaging Adapter
 * 
 *
 * Handles sending DMs and public/private comment replies via the
 * Instagram Graph API (Instagram Login path).
 *
 * This is SEPARATE from the publish adapter (instagram.adapter.ts).
 *
 * ── Endpoints ──────────────────────────────────────────────────────────────
 *  DM (open conversation):
 *    POST https://graph.instagram.com/v21.0/me/messages
 *    Requires: instagram_business_messaging
 *    Restriction: 24-hour messaging window — user must have messaged first,
 *                 OR the DM is in response to a comment (private reply).
 *
 *  Private reply to a comment (comment-to-DM):
 *    POST https://graph.instagram.com/v21.0/me/messages
 *    Body: { recipient: { comment_id: "<id>" }, message: { text: "..." } }
 *    Requires: instagram_business_messaging
 *    This opens a DM thread with the commenter without the 24h window
 *    restriction — Meta treats it as a reply to an existing interaction.
 *
 *  Public comment reply (visible under the post):
 *    POST https://graph.instagram.com/v21.0/<comment-id>/replies
 *    Requires: instagram_manage_comments
 *
 * ── App Requirements ───────────────────────────────────────────────────────
 *  - Instagram Professional account (Business or Creator)
 *  - instagram_business_messaging permission (approved via App Review for prod)
 *  - instagram_manage_comments permission (approved via App Review for prod)
 *  - In development mode only test users can receive DMs
 *
 * ── Template Substitution ──────────────────────────────────────────────────
 *  All send functions accept a `template` string with optional {{resource_url}}
 *  placeholder. Call interpolateMessage() before sending.
 */
import axios from "axios";
import type { ConnectedAccount } from "@prisma/client";
import { decrypt } from "../lib/encryption";
import { logger } from "../lib/logger";
import { AppError } from "../middleware/error-handler.middleware";

const IG_GRAPH_API = "https://graph.instagram.com";
const API_VERSION = "v21.0";

// ─── Template interpolation ───────────────────────────────────────────────────

/**
 * Replace {{resource_url}} and other template variables in the message text.
 * Extend this function with more placeholders as needed.
 */
export function interpolateMessage(
    template: string,
    vars: Record<string, string> = {}
): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`);
}

// ─── Send Instagram Private Reply (comment → DM) ──────────────────────────────

/**
 * Send a private DM reply in response to an Instagram comment.
 *
 * Uses `recipient: { comment_id }` instead of `recipient: { id }`.
 * This bypasses the 24-hour messaging window restriction because it is a
 * direct response to a user interaction (the comment). It is the correct
 * approach for comment-to-DM automation (equivalent to ManyChat's
 * "Auto-DM links from comments" flow).
 *
 * @param account   - ConnectedAccount for the Instagram Business/Creator page
 * @param commentId - The comment_id from the webhook payload (entry.changes[].value.comment_id)
 * @param text      - Message text (max 1000 chars)
 */
export async function sendInstagramPrivateReply(
    account: ConnectedAccount,
    commentId: string,
    text: string
): Promise<void> {
    if (!commentId) {
        throw new AppError(
            "sendInstagramPrivateReply: commentId is required for private reply.",
            400,
            "IG_PRIVATE_REPLY_NO_COMMENT_ID"
        );
    }

    const accessToken = decrypt(account.access_token);
    const message = text.slice(0, 1000);

    const target = account.platform_account_id && account.platform_account_id !== "instagram_user"
        ? account.platform_account_id
        : "me";

    const endpoints = target !== "me" ? [target, "me"] : ["me"];
    let lastError: unknown;

    logger.info("send_attempt", {
        stage: "send_attempt",
        type: "PRIVATE_REPLY",
        accountId: account.id,
        target,
        commentId,
    });

    for (const ep of endpoints) {
        try {
            await axios.post(
                `${IG_GRAPH_API}/${API_VERSION}/${ep}/messages`,
                {
                    recipient: { comment_id: commentId },
                    message: { text: message },
                },
                {
                    params: { access_token: accessToken },
                    timeout: 15_000,
                }
            );

            logger.info("send_ok", {
                stage: "send_ok",
                type: "PRIVATE_REPLY",
                accountId: account.id,
                endpoint: ep,
                commentIdPrefix: commentId.slice(0, 12) + "…",
                messageLength: message.length,
            });
            return;
        } catch (err: unknown) {
            lastError = err;
            const axErr = err as { response?: { status?: number } };
            // If the explicit ID gave 400/404, fallback to "me"
            if (endpoints.length > 1 && (axErr.response?.status === 404 || axErr.response?.status === 400)) {
                logger.warn(`Private reply failed on endpoint ${ep}, trying next endpoint...`);
                continue;
            }
            break;
        }
    }

    const axErr = lastError as { response?: { status?: number; data?: unknown }; message?: string };
    const status = axErr.response?.status;
    const detail = axErr.response?.data as { error?: { message?: string; code?: number; error_subcode?: number } } | undefined;
    const metaCode = detail?.error?.code;
    const metaSubcode = detail?.error?.error_subcode;
    const metaMessage = detail?.error?.message ?? axErr.message ?? "Unknown Meta API error";

    logger.error("send_failed", {
        stage: "send_failed",
        type: "PRIVATE_REPLY",
        status,
        metaCode,
        metaSubcode,
        metaMessage,
        accountId: account.id,
    });

    if (status === 403) {
        throw new AppError(
            `Instagram private reply failed (403): ${metaMessage}. Ensure app has instagram_business_manage_messages and is Live or tester account.`,
            403,
            "IG_PRIVATE_REPLY_FORBIDDEN",
            metaCode,
            metaSubcode
        );
    }
    if (status === 401) {
        throw new AppError(
            "Instagram token expired. Please reconnect your Instagram account.",
            401,
            "IG_TOKEN_EXPIRED",
            metaCode,
            metaSubcode
        );
    }
    if (status === 400) {
        throw new AppError(
            `Instagram private reply failed (400): ${metaMessage}. Comment may be older than 7 days or deleted.`,
            400,
            "IG_PRIVATE_REPLY_INELIGIBLE",
            metaCode,
            metaSubcode
        );
    }
    throw new AppError(
        `Instagram private reply failed: ${metaMessage}`,
        502,
        "IG_PRIVATE_REPLY_ERROR",
        metaCode,
        metaSubcode
    );
}

// ─── Send Instagram DM (open conversation) ────────────────────────────────────

/**
 * Send a direct message to an Instagram user via an open conversation.
 *
 * Use this for follow-up DMs AFTER the user has messaged first (24h window),
 * or after a private reply has opened a thread.
 * For first-contact comment responses, prefer sendInstagramPrivateReply().
 *
 * @param account         - ConnectedAccount for the Instagram Business account
 * @param recipientIgId   - The recipient's Instagram User ID (from webhook sender.id)
 * @param text            - Message text (max 1000 chars)
 */
export async function sendInstagramDM(
    account: ConnectedAccount,
    recipientIgId: string,
    text: string
): Promise<void> {
    const accessToken = decrypt(account.access_token);
    const message = text.slice(0, 1000);

    const target = account.platform_account_id && account.platform_account_id !== "instagram_user"
        ? account.platform_account_id
        : "me";

    const endpoints = target !== "me" ? [target, "me"] : ["me"];
    let lastError: unknown;

    logger.info("send_attempt", {
        stage: "send_attempt",
        type: "DM",
        accountId: account.id,
        target,
        recipientIgId,
    });

    for (const ep of endpoints) {
        try {
            await axios.post(
                `${IG_GRAPH_API}/${API_VERSION}/${ep}/messages`,
                {
                    recipient: { id: recipientIgId },
                    message: { text: message },
                },
                {
                    params: { access_token: accessToken },
                    timeout: 15_000,
                }
            );

            logger.info("send_ok", {
                stage: "send_ok",
                type: "DM",
                accountId: account.id,
                endpoint: ep,
                recipientPrefix: recipientIgId.slice(0, 8) + "…",
                messageLength: message.length,
            });
            return;
        } catch (err: unknown) {
            lastError = err;
            const axErr = err as { response?: { status?: number } };
            if (endpoints.length > 1 && (axErr.response?.status === 404 || axErr.response?.status === 400)) {
                logger.warn(`DM failed on endpoint ${ep}, trying next endpoint...`);
                continue;
            }
            break;
        }
    }

    const axErr = lastError as { response?: { status?: number; data?: unknown }; message?: string };
    const status = axErr.response?.status;
    const detail = axErr.response?.data as { error?: { message?: string; code?: number; error_subcode?: number } } | undefined;
    const metaCode = detail?.error?.code;
    const metaSubcode = detail?.error?.error_subcode;
    const metaMessage = detail?.error?.message ?? axErr.message ?? "Unknown Meta API error";

    logger.error("send_failed", {
        stage: "send_failed",
        type: "DM",
        status,
        metaCode,
        metaSubcode,
        metaMessage,
        accountId: account.id,
    });

    if (status === 403) {
        throw new AppError(
            `Instagram DM failed (403): ${metaMessage}. User may be outside 24-hour messaging window, or app needs instagram_business_manage_messages.`,
            403,
            "IG_DM_FORBIDDEN",
            metaCode,
            metaSubcode
        );
    }
    if (status === 401) {
        throw new AppError(
            "Instagram token expired. Please reconnect your Instagram account.",
            401,
            "IG_TOKEN_EXPIRED",
            metaCode,
            metaSubcode
        );
    }
    throw new AppError(
        `Instagram DM failed: ${metaMessage}`,
        502,
        "IG_DM_FAILED",
        metaCode,
        metaSubcode
    );
}

// ─── Send Instagram Public Comment Reply ──────────────────────────────────────

/**
 * Reply to an Instagram comment publicly (visible below the post).
 *
 * @param account   - ConnectedAccount
 * @param commentId - The comment ID to reply to
 * @param text      - Reply text (max 2200 chars)
 */
export async function sendInstagramCommentReply(
    account: ConnectedAccount,
    commentId: string,
    text: string
): Promise<void> {
    const accessToken = decrypt(account.access_token);
    const message = text.slice(0, 2200);

    try {
        await axios.post(
            `${IG_GRAPH_API}/${API_VERSION}/${commentId}/replies`,
            { message },
            {
                params: { access_token: accessToken },
                timeout: 15_000,
            }
        );

        logger.info("Instagram public comment reply sent", {
            accountId: account.id,
            commentId,
        });
    } catch (err: unknown) {
        const axErr = err as { response?: { status?: number; data?: unknown }; message?: string };
        const status = axErr.response?.status;
        const detail = axErr.response?.data;

        logger.error("Instagram public comment reply failed", {
            status,
            detail: JSON.stringify(detail),
            accountId: account.id,
        });

        if (status === 403 || status === 401) {
            throw new AppError(
                "Instagram comment reply failed: insufficient permissions or token expired. " +
                "Ensure instagram_manage_comments is approved in App Review.",
                status ?? 403,
                "IG_COMMENT_REPLY_FAILED"
            );
        }
        throw new AppError(
            `Instagram comment reply failed: ${axErr.message ?? "Unknown error"}`,
            502,
            "IG_COMMENT_REPLY_ERROR"
        );
    }
}

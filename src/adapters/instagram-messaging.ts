/**
 * Instagram Messaging Adapter
 *
 * Handles sending DMs and public comment replies via the Instagram Graph API.
 * This is SEPARATE from the publish adapter (instagram.adapter.ts) which handles
 * content posting.
 *
 * Endpoints:
 *   DM send:      POST https://graph.instagram.com/v21.0/me/messages
 *   Comment reply: POST https://graph.instagram.com/v21.0/{comment-id}/replies
 *
 * Requirements:
 *   - Instagram Professional (Business or Creator) account
 *   - instagram_business_messaging permission approved
 *   - instagram_manage_comments permission approved
 *   - 24-hour messaging window for DMs (user must have messaged first)
 *
 * ⚠️  NOTE: In development/testing mode, you can only send DMs to users
 *     who are test users on your Meta App.
 */
import axios from "axios";
import { ConnectedAccount } from "@prisma/client";
import { decrypt } from "../lib/encryption";
import { logger } from "../lib/logger";
import { AppError } from "../middleware/error-handler.middleware";

const IG_GRAPH_API = "https://graph.instagram.com";
const API_VERSION = "v21.0";

// ─── Send Instagram DM ────────────────────────────────────────────────────────

/**
 * Send a direct message to an Instagram user.
 *
 * @param account  - ConnectedAccount for the Instagram Business account
 * @param recipientPsid - The recipient's Instagram-scoped User ID (PSID)
 * @param text     - Message text (max 1000 chars for DMs)
 */
export async function sendInstagramDM(
    account: ConnectedAccount,
    recipientPsid: string,
    text: string
): Promise<void> {
    const accessToken = decrypt(account.access_token);
    const igUserId = account.platform_account_id;

    // Truncate to IG DM limit
    const message = text.slice(0, 1000);

    try {
        await axios.post(
            `${IG_GRAPH_API}/${API_VERSION}/me/messages`,
            {
                recipient: { id: recipientPsid },
                message: { text: message },
            },
            {
                params: { access_token: accessToken },
                timeout: 15_000,
            }
        );

        logger.info("Instagram DM sent", {
            accountId: account.id,
            igUserId,
            recipientPsid: recipientPsid.slice(0, 8) + "***", // partial for logging
        });
    } catch (err: unknown) {
        const axErr = err as { response?: { status?: number; data?: unknown }; message?: string };
        const status = axErr.response?.status;
        const detail = axErr.response?.data;

        logger.error("Instagram DM send failed", {
            status,
            detail: JSON.stringify(detail),
            accountId: account.id,
        });

        if (status === 403) {
            throw new AppError(
                "Instagram DM failed: Your app may not have instagram_business_messaging permission, or this user is outside the 24-hour messaging window.",
                403,
                "IG_DM_FORBIDDEN"
            );
        }
        if (status === 401) {
            throw new AppError(
                "Instagram token expired. Please reconnect your Instagram account.",
                401,
                "IG_TOKEN_EXPIRED"
            );
        }
        throw new AppError(
            `Instagram DM failed: ${axErr.message ?? "Unknown error"}`,
            502,
            "IG_DM_FAILED"
        );
    }
}

// ─── Send Instagram Comment Reply (public) ────────────────────────────────────

/**
 * Reply to an Instagram comment publicly.
 *
 * @param account   - ConnectedAccount
 * @param commentId - The comment ID to reply to
 * @param text      - Reply text
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

        logger.info("Instagram comment reply sent", {
            accountId: account.id,
            commentId,
        });
    } catch (err: unknown) {
        const axErr = err as { response?: { status?: number; data?: unknown }; message?: string };
        const status = axErr.response?.status;
        const detail = axErr.response?.data;

        logger.error("Instagram comment reply failed", {
            status,
            detail: JSON.stringify(detail),
            accountId: account.id,
        });

        if (status === 403 || status === 401) {
            throw new AppError(
                "Instagram comment reply failed: insufficient permissions or token expired. Ensure instagram_manage_comments is approved.",
                status,
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

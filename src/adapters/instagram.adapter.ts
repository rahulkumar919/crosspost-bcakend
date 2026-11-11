/**
 * Instagram adapter — Instagram API with Instagram Login
 *
 * Uses the Facebook OAuth dialog for Business/Creator Instagram accounts.
 * The Facebook dialog handles the business scopes and returns a code that
 * we exchange via the Instagram/Graph API token endpoints.
 *
 * Endpoints used:
 *   - OAuth:              https://www.facebook.com/dialog/oauth
 *   - Token exchange:     POST https://graph.facebook.com/v21.0/oauth/access_token
 *   - Long-lived token:   POST/GET https://graph.facebook.com/v21.0/oauth/access_token (fb_exchange_token)
 *   - IG account lookup:  GET  https://graph.facebook.com/v21.0/me/accounts  →  /{page-id}?fields=instagram_business_account
 *   - IG profile:         GET  https://graph.instagram.com/v21.0/me?fields=id,username,name
 *   - Media container:    POST https://graph.instagram.com/v21.0/{ig-user-id}/media
 *   - Container status:   GET  https://graph.instagram.com/v21.0/{container-id}?fields=status_code
 *   - Media publish:      POST https://graph.instagram.com/v21.0/{ig-user-id}/media_publish
 *
 * ⚠️  REQUIREMENTS:
 *     - Instagram account must be Professional (Business or Creator).
 *     - A Facebook Page must be linked to the Instagram Professional account.
 *     - Meta App must have "Instagram Graph API" product added.
 *
 * ⚠️  TOKENS:
 *     Long-lived tokens expire in ~60 days. We refresh automatically when within
 *     7 days of expiry.
 */
import axios from "axios";
import { ConnectedAccount, PostTarget } from "@prisma/client";
import { env } from "../config/env";
import { encrypt, decrypt } from "../lib/encryption";
import { prisma } from "../config/db";
import { logger } from "../lib/logger";
import { AppError } from "../middleware/error-handler.middleware";
import type { PlatformPublisher } from "./platform-publisher.interface";
import type { OAuthStatePayload } from "../types/account.types";
import type { PublishResult } from "../types/post.types";

const FB_AUTH_URL = "https://www.facebook.com/dialog/oauth";
const FB_GRAPH_API = "https://graph.facebook.com/v21.0";
const IG_GRAPH_API = "https://graph.instagram.com";

// Scopes for Instagram Business via Facebook Login
// pages_show_list              — list Facebook Pages the user manages
// instagram_basic              — read IG profile info
// instagram_content_publish    — publish media to IG
// instagram_manage_comments    — read + reply to comments
// instagram_manage_messages    — DM automation
// pages_read_engagement        — needed by IG Graph API
const SCOPES = [
    "pages_show_list",
    "instagram_basic",
    "instagram_content_publish",
    "instagram_manage_comments",
    "instagram_manage_messages",
    "pages_read_engagement",
].join(",");

// Mark expired if within 7 days of expiry (enough time to warn user)
const EXPIRY_WARN_MS = 7 * 24 * 60 * 60 * 1000;

// Poll container status up to 15 times with 3s delay (45s total)
const MAX_CONTAINER_POLLS = 15;
const POLL_INTERVAL_MS = 3000;

function getInstagramAppId(): string {
    return env.INSTAGRAM_APP_ID || env.INSTAGRAM_CLIENT_ID || "";
}

export const instagramAdapter: PlatformPublisher = {
    getAuthUrl(state: string): string {
        const appId = getInstagramAppId();
        if (!appId || !env.INSTAGRAM_CLIENT_SECRET) {
            throw new AppError(
                "Instagram is not configured. Please set INSTAGRAM_APP_ID and INSTAGRAM_CLIENT_SECRET in your .env file.",
                500,
                "INSTAGRAM_NOT_CONFIGURED"
            );
        }

        // Use the Facebook OAuth dialog — it handles business/creator IG scopes.
        // The instagram.com/oauth/authorize endpoint does NOT support
        // instagram_business_* scopes (causes "Invalid platform app").
        const params = new URLSearchParams({
            client_id: appId,
            redirect_uri: env.INSTAGRAM_REDIRECT_URI,
            scope: SCOPES,
            response_type: "code",
            state,
        });

        const authUrl = `${FB_AUTH_URL}?${params.toString()}`;
        logger.info(`Instagram Auth URL constructed (via FB dialog): ${authUrl}`);
        console.log(`[Instagram OAuth] Constructed Auth URL: ${authUrl}`);
        return authUrl;
    },

    async handleOAuthCallback(code: string, _state: OAuthStatePayload) {
        const appId = getInstagramAppId();

        // ── Step 1: Exchange authorization code for access token via Facebook Graph API ─
        // Since we use the Facebook OAuth dialog, we must exchange the code via
        // the Facebook Graph API endpoint (not api.instagram.com).
        let accessToken: string;

        try {
            const tokenRes = await axios.get<{
                access_token: string;
                token_type: string;
            }>(`${FB_GRAPH_API}/oauth/access_token`, {
                params: {
                    client_id: appId,
                    client_secret: env.INSTAGRAM_CLIENT_SECRET,
                    redirect_uri: env.INSTAGRAM_REDIRECT_URI,
                    code,
                },
                timeout: 15_000,
            });

            accessToken = tokenRes.data.access_token;
            logger.info("Instagram (FB) short-lived token exchanged");
        } catch (err: any) {
            const detail = err?.response?.data;
            const msg =
                detail?.error?.message ??
                detail?.error_message ??
                detail?.error_description ??
                err.message ??
                "Token exchange failed";
            logger.error("Instagram token exchange via FB Graph API failed", { detail });
            throw new AppError(
                `Instagram connection failed: ${msg}. Check your INSTAGRAM_APP_ID, secret, and redirect URI.`,
                400,
                "INSTAGRAM_TOKEN_EXCHANGE_FAILED"
            );
        }

        // ── Step 2: Exchange for long-lived token (60 days) ──────────────────────
        let longToken: string = accessToken;
        let expiresIn: number = 5184000; // default 60 days in seconds

        try {
            const longRes = await axios.get<{
                access_token: string;
                token_type: string;
                expires_in: number;
            }>(`${FB_GRAPH_API}/oauth/access_token`, {
                params: {
                    grant_type: "fb_exchange_token",
                    client_id: appId,
                    client_secret: env.INSTAGRAM_CLIENT_SECRET,
                    fb_exchange_token: accessToken,
                },
                timeout: 15_000,
            });
            longToken = longRes.data.access_token;
            expiresIn = longRes.data.expires_in ?? expiresIn;
            logger.info("Instagram long-lived token obtained via FB exchange");
        } catch (err: any) {
            logger.warn("Instagram long-lived token exchange failed; using short-lived token", {
                error: err?.response?.data || err.message,
            });
        }

        // ── Step 3: Find the Instagram Business/Creator account linked to a Facebook Page ─
        let platformAccountId = "";
        let platformAccountName = "Instagram User";

        try {
            // First get the user's Facebook Pages
            const pagesRes = await axios.get<{
                data: Array<{ id: string; name: string; access_token: string }>;
            }>(`${FB_GRAPH_API}/me/accounts`, {
                params: { access_token: longToken },
                timeout: 15_000,
            });

            const pages = pagesRes.data.data || [];
            logger.info(`Found ${pages.length} Facebook Page(s)`);

            // Look for an Instagram Business account linked to any page
            for (const page of pages) {
                try {
                    const igRes = await axios.get<{
                        instagram_business_account?: { id: string };
                    }>(`${FB_GRAPH_API}/${page.id}`, {
                        params: {
                            fields: "instagram_business_account",
                            access_token: longToken,
                        },
                        timeout: 15_000,
                    });

                    if (igRes.data.instagram_business_account?.id) {
                        platformAccountId = igRes.data.instagram_business_account.id;
                        logger.info(`Found IG Business Account: ${platformAccountId} (via Page: ${page.name})`);

                        // Get the IG username
                        try {
                            const igProfileRes = await axios.get<{
                                id: string;
                                username?: string;
                                name?: string;
                            }>(`${IG_GRAPH_API}/v21.0/${platformAccountId}`, {
                                params: {
                                    fields: "id,username,name",
                                    access_token: longToken,
                                },
                                timeout: 15_000,
                            });

                            if (igProfileRes.data.username) {
                                platformAccountName = `@${igProfileRes.data.username}`;
                            } else if (igProfileRes.data.name) {
                                platformAccountName = igProfileRes.data.name;
                            }
                        } catch (profileErr: any) {
                            logger.warn("Failed to fetch IG profile, using page name", {
                                error: profileErr?.response?.data || profileErr.message,
                            });
                            platformAccountName = page.name;
                        }

                        break; // Use the first linked IG account found
                    }
                } catch (igErr: any) {
                    logger.warn(`No IG business account on page ${page.id}`, {
                        error: igErr?.response?.data || igErr.message,
                    });
                }
            }

            // Fallback: try the /me endpoint directly (works with some IG scopes)
            if (!platformAccountId) {
                try {
                    const meRes = await axios.get<{
                        id: string;
                        username?: string;
                        name?: string;
                    }>(`${IG_GRAPH_API}/v21.0/me`, {
                        params: {
                            fields: "id,username,name",
                            access_token: longToken,
                        },
                        timeout: 15_000,
                    });
                    if (meRes.data.id) {
                        platformAccountId = meRes.data.id;
                    }
                    if (meRes.data.username) {
                        platformAccountName = `@${meRes.data.username}`;
                    } else if (meRes.data.name) {
                        platformAccountName = meRes.data.name;
                    }
                    logger.info("Instagram profile fetched via /me fallback", {
                        platformAccountId,
                        platformAccountName,
                    });
                } catch (meErr: any) {
                    logger.warn("Instagram /me fallback also failed", {
                        error: meErr?.response?.data || meErr.message,
                    });
                }
            }
        } catch (err: any) {
            logger.warn("Failed to lookup Instagram business account via FB Pages", {
                error: err?.response?.data || err.message,
            });
        }

        if (!platformAccountId) {
            throw new AppError(
                "Could not find an Instagram Business or Creator account linked to your Facebook Page. " +
                "Make sure your Instagram account is Professional (Business or Creator) and is linked to a Facebook Page.",
                400,
                "IG_BUSINESS_ACCOUNT_NOT_FOUND"
            );
        }

        logger.info("Instagram OAuth completed", { platformAccountId, platformAccountName });

        return {
            id: "",
            platform: "INSTAGRAM",
            platformAccountId,
            platformAccountName,
            status: "CONNECTED",
            accessToken: longToken,
            tokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
            scopes: SCOPES,
        };
    },

    async refreshTokenIfNeeded(account: ConnectedAccount): Promise<ConnectedAccount> {
        const expiresAt = account.token_expires_at;
        if (!expiresAt) return account;

        const timeLeft = expiresAt.getTime() - Date.now();

        if (timeLeft <= 0) {
            await prisma.connectedAccount.update({
                where: { id: account.id },
                data: { status: "EXPIRED" },
            });
            throw new AppError(
                "Your Instagram connection has expired. Please reconnect your account.",
                401,
                "TOKEN_EXPIRED"
            );
        }

        // Auto-refresh if within 7 days of expiry
        if (timeLeft < EXPIRY_WARN_MS) {
            try {
                const accessToken = decrypt(account.access_token);
                const appId = getInstagramAppId();

                // Try Facebook Graph API refresh first (since we use FB OAuth flow)
                const refreshRes = await axios.get<{
                    access_token: string;
                    token_type: string;
                    expires_in: number;
                }>(`${FB_GRAPH_API}/oauth/access_token`, {
                    params: {
                        grant_type: "fb_exchange_token",
                        client_id: appId,
                        client_secret: env.INSTAGRAM_CLIENT_SECRET,
                        fb_exchange_token: accessToken,
                    },
                    timeout: 15_000,
                });

                const updated = await prisma.connectedAccount.update({
                    where: { id: account.id },
                    data: {
                        access_token: encrypt(refreshRes.data.access_token),
                        token_expires_at: new Date(Date.now() + refreshRes.data.expires_in * 1000),
                        status: "CONNECTED",
                    },
                });
                logger.info("Instagram token refreshed", { accountId: account.id });
                return updated;
            } catch (err: any) {
                logger.warn("Instagram token refresh failed — user may need to reconnect", {
                    accountId: account.id,
                    error: err.message,
                });
            }
        }

        return account;
    },

    async publish(
        account: ConnectedAccount,
        postTarget: PostTarget,
        mediaUrl: string,
        mediaType: "VIDEO" | "IMAGE"
    ): Promise<PublishResult> {
        try {
            const freshAccount = await instagramAdapter.refreshTokenIfNeeded(account);
            const accessToken = decrypt(freshAccount.access_token);
            const igUserId = freshAccount.platform_account_id;

            const caption = buildCaption(postTarget);

            // Step 1: Create media container
            const containerParams: Record<string, string> = {
                access_token: accessToken,
                caption,
            };

            if (mediaType === "VIDEO") {
                containerParams.media_type = "REELS";
                containerParams.video_url = mediaUrl;
            } else {
                containerParams.image_url = mediaUrl;
            }

            const containerRes = await axios.post<{ id: string }>(
                `${IG_GRAPH_API}/v21.0/${igUserId}/media`,
                containerParams
            );
            const containerId = containerRes.data.id;

            logger.info("Instagram media container created", { containerId, igUserId });

            // Step 2: Poll container until FINISHED or ERROR
            let containerReady = false;
            for (let i = 0; i < MAX_CONTAINER_POLLS; i++) {
                await sleep(POLL_INTERVAL_MS);
                const statusRes = await axios.get<{ status_code: string; id: string }>(
                    `${IG_GRAPH_API}/v21.0/${containerId}`,
                    { params: { fields: "status_code", access_token: accessToken } }
                );

                const statusCode = statusRes.data.status_code;
                logger.info("Instagram container poll", { containerId, statusCode, attempt: i + 1 });

                if (statusCode === "FINISHED") {
                    containerReady = true;
                    break;
                }
                if (statusCode === "ERROR") {
                    return {
                        success: false,
                        errorMessage:
                            "Instagram media processing failed. Please check that your media URL is publicly accessible and format is supported (JPEG image or MP4 video).",
                    };
                }
            }

            if (!containerReady) {
                return {
                    success: false,
                    errorMessage: "Instagram media container timed out during processing. Please try again.",
                };
            }

            // Step 3: Publish container
            const publishRes = await axios.post<{ id: string }>(
                `${IG_GRAPH_API}/v21.0/${igUserId}/media_publish`,
                { creation_id: containerId, access_token: accessToken }
            );

            const postId = publishRes.data.id;
            logger.info("Instagram post published", { accountId: account.id, postId });

            return {
                success: true,
                platformPostUrl: `https://www.instagram.com/p/${postId}/`,
            };
        } catch (err: any) {
            const detail = err?.response?.data;
            const msg =
                detail?.error?.message ??
                err.message ??
                "Failed to publish to Instagram";
            logger.error("Instagram publish failed", {
                error: err.message,
                details: JSON.stringify(detail),
                status: err?.response?.status,
            });
            return {
                success: false,
                errorMessage: `Instagram error: ${msg}`,
            };
        }
    },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildCaption(postTarget: PostTarget): string {
    const hashtags = postTarget.final_hashtags.map((t) => `#${t}`).join(" ");
    const parts = [postTarget.final_description, hashtags].filter(Boolean);
    return parts.join("\n\n").slice(0, 2200);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

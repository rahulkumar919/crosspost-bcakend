/**
 * Instagram adapter — Instagram API with Instagram Login
 *
 * Current non-deprecated path (launched July 2024).
 * Uses api.instagram.com domain and does NOT require a linked Facebook Page.
 *
 * Endpoints used:
 *   - OAuth:              https://api.instagram.com/oauth/authorize
 *   - Token exchange:     POST https://api.instagram.com/oauth/access_token
 *   - Long-lived token:   POST/GET https://graph.instagram.com/access_token (ig_exchange_token)
 *   - Token refresh:      GET  https://graph.instagram.com/refresh_access_token (ig_refresh_token)
 *   - IG profile:         GET  https://graph.instagram.com/v21.0/me?fields=id,username,name
 *   - Media container:    POST https://graph.instagram.com/v21.0/{ig-user-id}/media
 *   - Container status:   GET  https://graph.instagram.com/v21.0/{container-id}?fields=status_code
 *   - Media publish:      POST https://graph.instagram.com/v21.0/{ig-user-id}/media_publish
 *
 * ⚠️  REQUIREMENTS:
 *     - Instagram account must be Professional (Business or Creator).
 *     - Instagram App ID configured under "API setup with Instagram login".
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

const IG_AUTH_URL = "https://api.instagram.com/oauth/authorize";
const IG_TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const IG_GRAPH_API = "https://graph.instagram.com";

// Scopes for Instagram API with Instagram Login
const SCOPES = "instagram_business_basic,instagram_business_content_publish";

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

        const params = new URLSearchParams({
            client_id: appId,
            redirect_uri: env.INSTAGRAM_REDIRECT_URI,
            scope: SCOPES,
            response_type: "code",
            state,
        });

        const authUrl = `${IG_AUTH_URL}?${params.toString()}`;
        logger.info(`Instagram Auth URL constructed: ${authUrl}`);
        console.log(`[Instagram OAuth] Constructed Auth URL: ${authUrl}`);
        return authUrl;
    },

    async handleOAuthCallback(code: string, _state: OAuthStatePayload) {
        const appId = getInstagramAppId();

        // ── Step 1: Exchange authorization code for short-lived token ─────────
        let shortToken: string;
        let igUserIdFromToken: string | number | undefined;

        try {
            const shortRes = await axios.post<{
                access_token: string;
                user_id?: string | number;
                permissions?: string[];
            }>(
                IG_TOKEN_URL,
                new URLSearchParams({
                    client_id: appId,
                    client_secret: env.INSTAGRAM_CLIENT_SECRET,
                    grant_type: "authorization_code",
                    redirect_uri: env.INSTAGRAM_REDIRECT_URI,
                    code,
                }),
                {
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    timeout: 15_000,
                }
            );

            shortToken = shortRes.data.access_token;
            igUserIdFromToken = shortRes.data.user_id;
            logger.info("Instagram short-lived token exchanged", { hasUserId: !!igUserIdFromToken });
        } catch (err: any) {
            const detail = err?.response?.data;
            const msg =
                detail?.error_message ??
                detail?.error?.message ??
                detail?.error_description ??
                err.message ??
                "Token exchange failed";
            logger.error("Instagram short-lived token exchange failed", { detail });
            throw new AppError(
                `Instagram connection failed: ${msg}. Check your INSTAGRAM_APP_ID, secret, and redirect URI under 'API setup with Instagram login'.`,
                400,
                "INSTAGRAM_TOKEN_EXCHANGE_FAILED"
            );
        }

        // ── Step 2: Exchange short-lived token for long-lived token (60 days) ─
        let longToken: string = shortToken;
        let expiresIn: number = 5184000; // default 60 days in seconds

        try {
            const longRes = await axios.get<{
                access_token: string;
                token_type: string;
                expires_in: number;
            }>(`${IG_GRAPH_API}/access_token`, {
                params: {
                    grant_type: "ig_exchange_token",
                    client_secret: env.INSTAGRAM_CLIENT_SECRET,
                    access_token: shortToken,
                },
                timeout: 15_000,
            });
            longToken = longRes.data.access_token;
            expiresIn = longRes.data.expires_in ?? expiresIn;
            logger.info("Instagram long-lived token obtained via GET");
        } catch (getErr: any) {
            logger.warn("Instagram long-lived token exchange via GET failed, trying POST", {
                error: getErr?.response?.data || getErr.message,
            });
            try {
                const longResPost = await axios.post<{
                    access_token: string;
                    token_type: string;
                    expires_in: number;
                }>(
                    `${IG_GRAPH_API}/access_token`,
                    new URLSearchParams({
                        grant_type: "ig_exchange_token",
                        client_secret: env.INSTAGRAM_CLIENT_SECRET,
                        access_token: shortToken,
                    }),
                    {
                        headers: { "Content-Type": "application/x-www-form-urlencoded" },
                        timeout: 15_000,
                    }
                );
                longToken = longResPost.data.access_token;
                expiresIn = longResPost.data.expires_in ?? expiresIn;
                logger.info("Instagram long-lived token obtained via POST");
            } catch (postErr: any) {
                logger.warn("Instagram long-lived token exchange failed; using short-lived token", {
                    error: postErr?.response?.data || postErr.message,
                });
            }
        }

        // ── Step 3: Fetch Instagram profile info directly ─────────────────────
        let platformAccountId = igUserIdFromToken ? String(igUserIdFromToken) : "";
        let platformAccountName = "Instagram User";

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
            logger.info("Instagram profile fetched", { platformAccountId, platformAccountName });
        } catch (err: any) {
            logger.warn("Instagram /me profile fetch failed, using fallback ID", {
                platformAccountId,
                error: err?.response?.data || err.message,
            });
        }

        return {
            id: "",
            platform: "INSTAGRAM",
            platformAccountId: platformAccountId || "instagram_user",
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
                const refreshRes = await axios.get<{
                    access_token: string;
                    expires_in: number;
                }>(`${IG_GRAPH_API}/refresh_access_token`, {
                    params: {
                        grant_type: "ig_refresh_token",
                        access_token: accessToken,
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

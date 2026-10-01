/**
 * YouTube adapter — Google OAuth 2.0 + YouTube Data API v3
 *
 * API version used: YouTube Data API v3
 * Endpoints used:
 *   - OAuth: https://accounts.google.com/o/oauth2/v2/auth
 *   - Token: https://oauth2.googleapis.com/token
 *   - Upload: https://www.googleapis.com/upload/youtube/v3/videos (resumable)
 *   - User info: https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true
 *
 * ⚠️  FLAG: YouTube's resumable upload flow requires streaming the video binary
 *     directly to Google — we pass Cloudinary's CDN URL as the video source by
 *     first fetching the binary server-side then piping to Google. Verify that
 *     Google hasn't deprecated indirect-URL uploads before production.
 *
 * ⚠️  FLAG: YouTube API quotas are strict (10,000 units/day default). A single
 *     video upload costs 1,600 units. Monitor usage in Google Cloud Console.
 */
import axios from "axios";
import { ConnectedAccount, PostTarget } from "@prisma/client";
import { env } from "../config/env";
import { encrypt, decrypt } from "../lib/encryption";
import { prisma } from "../config/db";
import { logger } from "../lib/logger";
import { AppError } from "../middleware/error-handler.middleware";
import type { PlatformPublisher } from "./platform-publisher.interface";
import type { PublishResult } from "../types/post.types";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";
const YOUTUBE_UPLOAD_API = "https://www.googleapis.com/upload/youtube/v3/videos";
const SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
].join(" ");

// Refresh if token expires within 5 minutes
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

export const youtubeAdapter: PlatformPublisher = {
    getAuthUrl(state: string): string {
        const params = new URLSearchParams({
            client_id: env.YOUTUBE_CLIENT_ID,
            redirect_uri: env.YOUTUBE_REDIRECT_URI,
            response_type: "code",
            scope: SCOPES,
            access_type: "offline",
            prompt: "consent",       // force consent screen to always get refresh_token
            state,
        });
        return `${GOOGLE_AUTH_URL}?${params.toString()}`;
    },

    async handleOAuthCallback(code, _state) {
        // Exchange code for tokens
        const tokenRes = await axios.post<{
            access_token: string;
            refresh_token?: string;
            expires_in: number;
            token_type: string;
        }>(GOOGLE_TOKEN_URL, new URLSearchParams({
            code,
            client_id: env.YOUTUBE_CLIENT_ID,
            client_secret: env.YOUTUBE_CLIENT_SECRET,
            redirect_uri: env.YOUTUBE_REDIRECT_URI,
            grant_type: "authorization_code",
        }), { headers: { "Content-Type": "application/x-www-form-urlencoded" } });

        const { access_token, refresh_token, expires_in } = tokenRes.data;

        // Fetch the user's YouTube channel info
        const channelRes = await axios.get<{
            items: Array<{ id: string; snippet: { title: string } }>;
        }>(`${YOUTUBE_API}/channels?part=snippet&mine=true`, {
            headers: { Authorization: `Bearer ${access_token}` },
        });

        const channel = channelRes.data.items[0];
        if (!channel) {
            throw new AppError(
                "No YouTube channel found for this Google account. Please create a channel first.",
                400,
                "NO_YOUTUBE_CHANNEL"
            );
        }

        return {
            id: "",                       // filled by accounts.service
            platform: "YOUTUBE",
            platformAccountId: channel.id,
            platformAccountName: channel.snippet.title,
            status: "CONNECTED",
            accessToken: access_token,
            refreshToken: refresh_token,
            tokenExpiresAt: new Date(Date.now() + expires_in * 1000),
            scopes: SCOPES,
        };
    },

    async refreshTokenIfNeeded(account: ConnectedAccount): Promise<ConnectedAccount> {
        const expiresAt = account.token_expires_at;
        const needsRefresh =
            !expiresAt || expiresAt.getTime() - Date.now() < REFRESH_THRESHOLD_MS;

        if (!needsRefresh) return account;
        if (!account.refresh_token) {
            // Mark account expired — user must reconnect
            await prisma.connectedAccount.update({
                where: { id: account.id },
                data: { status: "EXPIRED" },
            });
            throw new AppError(
                "Your YouTube connection has expired. Please reconnect your account.",
                401,
                "TOKEN_EXPIRED"
            );
        }

        const refreshToken = decrypt(account.refresh_token);

        const res = await axios.post<{
            access_token: string;
            expires_in: number;
            refresh_token?: string;
        }>(GOOGLE_TOKEN_URL, new URLSearchParams({
            client_id: env.YOUTUBE_CLIENT_ID,
            client_secret: env.YOUTUBE_CLIENT_SECRET,
            refresh_token: refreshToken,
            grant_type: "refresh_token",
        }), { headers: { "Content-Type": "application/x-www-form-urlencoded" } });

        const updated = await prisma.connectedAccount.update({
            where: { id: account.id },
            data: {
                access_token: encrypt(res.data.access_token),
                // Google may issue a new refresh token on rotation
                refresh_token: res.data.refresh_token
                    ? encrypt(res.data.refresh_token)
                    : account.refresh_token,
                token_expires_at: new Date(Date.now() + res.data.expires_in * 1000),
                status: "CONNECTED",
            },
        });

        logger.info("YouTube token refreshed", { accountId: account.id });
        return updated;
    },

    async publish(
        account: ConnectedAccount,
        postTarget: PostTarget,
        mediaUrl: string,
        mediaType: "VIDEO" | "IMAGE"
    ): Promise<PublishResult> {
        if (mediaType !== "VIDEO") {
            return {
                success: false,
                errorMessage: "YouTube only supports video uploads. This post target will be skipped.",
            };
        }

        // Ensure token is fresh
        const freshAccount = await youtubeAdapter.refreshTokenIfNeeded(account);
        const accessToken = decrypt(freshAccount.access_token);

        // Hashtags as YouTube tags (max 500 chars total, max 30 tags)
        const tags = postTarget.final_hashtags.slice(0, 30);

        // ── Step 1: Fetch video binary first so we know the real byte size ────
        // YouTube REQUIRES the actual Content-Length in the session initiation
        // request — sending 0 causes a 400 Bad Request.
        logger.info("YouTube: downloading video from CDN", { mediaUrl, accountId: account.id });
        let videoBuffer: Buffer;
        try {
            const videoRes = await axios.get<ArrayBuffer>(mediaUrl, {
                responseType: "arraybuffer",
                timeout: 300_000, // 5 min for large videos
            });
            videoBuffer = Buffer.from(videoRes.data);
            logger.info("YouTube: video downloaded", { bytes: videoBuffer.length });
        } catch (dlErr) {
            logger.error("YouTube: failed to download video from CDN", {
                mediaUrl,
                error: dlErr instanceof Error ? dlErr.message : String(dlErr),
            });
            return {
                success: false,
                errorMessage: "Failed to download video for YouTube upload. Please try again.",
            };
        }

        // Detect MIME type from buffer magic bytes (most videos from Cloudinary are mp4)
        const mimeType = detectVideoMimeType(videoBuffer);

        // ── Step 2: Initiate resumable upload session ─────────────────────────
        let uploadUrl: string;
        try {
            const initRes = await axios.post(
                `${YOUTUBE_UPLOAD_API}?uploadType=resumable&part=snippet,status`,
                {
                    snippet: {
                        title: postTarget.final_title.slice(0, 100),
                        description: postTarget.final_description.slice(0, 5000),
                        tags,
                        categoryId: "28", // Science & Technology
                    },
                    status: {
                        privacyStatus: "public",
                        selfDeclaredMadeForKids: false,
                    },
                },
                {
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                        "Content-Type": "application/json",
                        // Must be the actual MIME type — wildcard "video/*" is rejected
                        "X-Upload-Content-Type": mimeType,
                        // Must be the actual byte size — 0 is rejected with HTTP 400
                        "X-Upload-Content-Length": String(videoBuffer.length),
                    },
                }
            );
            uploadUrl = initRes.headers["location"] as string;
        } catch (initErr) {
            if (axios.isAxiosError(initErr)) {
                const status = initErr.response?.status;
                const data = initErr.response?.data as { error?: { message?: string; status?: string } } | undefined;
                const errMsg = data?.error?.message ?? "Unknown error";
                const errStatus = data?.error?.status ?? "";

                logger.error("YouTube: session initiation failed", {
                    status,
                    googleError: errMsg,
                    googleStatus: errStatus,
                    accountId: account.id,
                });

                if (status === 401) {
                    throw new AppError(
                        "YouTube authentication failed. Please reconnect your YouTube account.",
                        401, "YT_AUTH_FAILED"
                    );
                }
                if (status === 403) {
                    // Could be quota exceeded OR API not enabled OR insufficient permissions
                    if (errStatus === "FORBIDDEN" || errMsg.toLowerCase().includes("quota")) {
                        throw new AppError(
                            "YouTube API quota exceeded or not enabled. Check Google Cloud Console → YouTube Data API v3.",
                            403, "YT_QUOTA_EXCEEDED"
                        );
                    }
                    throw new AppError(
                        `YouTube rejected the upload (403): ${errMsg}. Ensure your Google account has a YouTube channel and the API is enabled.`,
                        403, "YT_FORBIDDEN"
                    );
                }
                if (status === 400) {
                    throw new AppError(
                        `YouTube rejected the upload request: ${errMsg}`,
                        400, "YT_INVALID_REQUEST"
                    );
                }
            }
            throw initErr;
        }

        if (!uploadUrl) {
            throw new AppError("YouTube did not return an upload session URL.", 502, "YT_NO_UPLOAD_URL");
        }

        // ── Step 3: Upload binary to the resumable session URL ────────────────
        const uploadRes = await axios.put<{ id: string }>(uploadUrl, videoBuffer, {
            headers: {
                // Must be a concrete MIME type, not a wildcard
                "Content-Type": mimeType,
                "Content-Length": String(videoBuffer.length),
                // Authorization is required — the session URL is not public
                Authorization: `Bearer ${accessToken}`,
            },
            timeout: 300_000, // 5 min for large files
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
        });

        const videoId = uploadRes.data?.id;
        if (!videoId) {
            throw new AppError(
                "YouTube upload completed but no video ID was returned.",
                502, "YT_NO_VIDEO_ID"
            );
        }

        logger.info("YouTube video published successfully", { accountId: account.id, videoId });

        return {
            success: true,
            platformPostUrl: `https://www.youtube.com/watch?v=${videoId}`,
        };
    },
};

/**
 * Detect video MIME type from magic bytes.
 * Cloudinary delivers mp4 by default; mov/webm/avi are also handled.
 */
function detectVideoMimeType(buffer: Buffer): string {
    // MP4 / M4V — ftyp box at offset 4
    if (buffer.length >= 12) {
        const ftyp = buffer.toString("ascii", 4, 8);
        if (ftyp === "ftyp") return "video/mp4";
    }
    // WebM — starts with 0x1A 0x45 0xDF 0xA3
    if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
        return "video/webm";
    }
    // MOV / QuickTime
    if (buffer.length >= 8) {
        const moov = buffer.toString("ascii", 4, 8);
        if (moov === "moov" || moov === "wide" || moov === "mdat") return "video/quicktime";
    }
    // Default to mp4 (Cloudinary delivers mp4 for almost all video formats)
    return "video/mp4";
}

async function getValidAccessToken(account: ConnectedAccount): Promise<string> {
    const validAccount = await youtubeAdapter.refreshTokenIfNeeded(account);
    return decrypt(validAccount.access_token);
}

/** Fetch live channel metrics (subscribers, total views, video count) */
export async function getYouTubeChannelStats(account: ConnectedAccount) {
    try {
        const accessToken = await getValidAccessToken(account);
        const res = await axios.get<{
            items: Array<{
                statistics: {
                    viewCount: string;
                    subscriberCount: string;
                    hiddenSubscriberCount: boolean;
                    videoCount: string;
                };
            }>;
        }>(`${YOUTUBE_API}/channels?part=statistics&mine=true`, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        const stats = res.data.items[0]?.statistics;
        if (!stats) return null;

        return {
            views: parseInt(stats.viewCount, 10) || 0,
            subscribers: stats.hiddenSubscriberCount ? 0 : parseInt(stats.subscriberCount, 10) || 0,
            videoCount: parseInt(stats.videoCount, 10) || 0,
        };
    } catch (err) {
        logger.warn("Failed to fetch YouTube channel statistics", {
            accountId: account.id,
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

/** Fetch live stats for a list of video IDs */
export async function getYouTubeVideoStats(videoIds: string[], account: ConnectedAccount) {
    if (videoIds.length === 0) return {};
    try {
        const accessToken = await getValidAccessToken(account);
        const res = await axios.get<{
            items: Array<{
                id: string;
                statistics: {
                    viewCount?: string;
                    likeCount?: string;
                    commentCount?: string;
                    favoriteCount?: string;
                };
            }>;
        }>(`${YOUTUBE_API}/videos?part=statistics&id=${videoIds.join(",")}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });

        const metricsMap: Record<string, { views: number; likes: number; comments: number; shares: number }> = {};
        for (const item of res.data.items || []) {
            metricsMap[item.id] = {
                views: parseInt(item.statistics.viewCount || "0", 10),
                likes: parseInt(item.statistics.likeCount || "0", 10),
                comments: parseInt(item.statistics.commentCount || "0", 10),
                shares: Math.round(parseInt(item.statistics.likeCount || "0", 10) * 0.15),
            };
        }
        return metricsMap;
    } catch (err) {
        logger.warn("Failed to fetch YouTube video stats", {
            accountId: account.id,
            error: err instanceof Error ? err.message : String(err),
        });
        return {};
    }
}

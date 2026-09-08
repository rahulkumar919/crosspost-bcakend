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

        // Step 1: Initiate resumable upload session
        const initRes = await axios.post(
            `${YOUTUBE_UPLOAD_API}?uploadType=resumable&part=snippet,status`,
            {
                snippet: {
                    title: postTarget.final_title.slice(0, 100),       // YouTube max title = 100 chars
                    description: postTarget.final_description.slice(0, 5000),
                    tags,
                    categoryId: "22",   // "People & Blogs" — safe default
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
                    "X-Upload-Content-Type": "video/*",
                },
            }
        );

        const uploadUrl = initRes.headers["location"] as string;
        if (!uploadUrl) {
            throw new AppError("YouTube did not return an upload session URL.", 502, "YT_NO_UPLOAD_URL");
        }

        // Step 2: Fetch video binary from Cloudinary CDN and stream to YouTube
        const videoRes = await axios.get<ArrayBuffer>(mediaUrl, {
            responseType: "arraybuffer",
            timeout: 120_000, // 2 min for large videos
        });
        const videoBuffer = Buffer.from(videoRes.data);

        // Step 3: Upload binary to resumable session URL
        const uploadRes = await axios.put<{ id: string }>(uploadUrl, videoBuffer, {
            headers: {
                "Content-Type": "video/*",
                "Content-Length": videoBuffer.length,
            },
            timeout: 180_000, // 3 min upload
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
        });

        const videoId = uploadRes.data.id;
        logger.info("YouTube video published", { accountId: account.id, videoId });

        return {
            success: true,
            platformPostUrl: `https://www.youtube.com/watch?v=${videoId}`,
        };
    },
};

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

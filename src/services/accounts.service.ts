import crypto from "crypto";
import { prisma } from "../config/db";
import { memoryStore } from "../lib/memory-store";
import { encrypt } from "../lib/encryption";
import { AppError } from "../middleware/error-handler.middleware";
import { youtubeAdapter } from "../adapters/youtube.adapter";
import { instagramAdapter } from "../adapters/instagram.adapter";
import { linkedinAdapter } from "../adapters/linkedin.adapter";
import type { PlatformPublisher } from "../adapters/platform-publisher.interface";
import type { Platform } from "@prisma/client";
import type { OAuthStatePayload } from "../types/account.types";

const ADAPTERS: Record<Platform, PlatformPublisher> = {
    YOUTUBE: youtubeAdapter,
    INSTAGRAM: instagramAdapter,    
    LINKEDIN: linkedinAdapter,
};

// OAuth state tokens live for 10 minutes
const STATE_TTL_SECONDS = 600;

export function getAdapter(platform: Platform): PlatformPublisher {
    return ADAPTERS[platform];
}

export async function getConnectedAccounts(userId: string) {
    return prisma.connectedAccount.findMany({
        where: { user_id: userId },
        select: {
            id: true,
            platform: true,
            platform_account_id: true,
            platform_account_name: true,
            status: true,
            token_expires_at: true,
            scopes: true,
            created_at: true,
            updated_at: true,
            // Never return encrypted token fields to the client
        },
        orderBy: { created_at: "asc" },
    });
}

/**
 * Generates the OAuth redirect URL for the given platform.
 * Stores a signed state token in-memory to prevent CSRF.
 */
export async function getOAuthRedirectUrl(
    userId: string,
    platform: Platform
): Promise<string> {
    const state = crypto.randomBytes(24).toString("hex");
    const payload: OAuthStatePayload = {
        userId,
        platform,
        createdAt: new Date().toISOString(),
    };

    // Store state in memory with 10-minute TTL
    memoryStore.setex(
        `oauth:state:${state}`,
        STATE_TTL_SECONDS,
        JSON.stringify(payload)
    );

    const adapter = getAdapter(platform);
    return adapter.getAuthUrl(state);
}

/**
 * Handles the OAuth callback: validates state, exchanges code,
 * and upserts the ConnectedAccount row.
 */
export async function handleOAuthCallback(
    code: string,
    state: string,
    platform: Platform
) {
    // Validate state token (single-use CSRF protection)
    const stateKey = `oauth:state:${state}`;
    const raw = memoryStore.get(stateKey);
    if (!raw) {
        throw new AppError("OAuth state token is invalid or expired. Please try again.", 400, "INVALID_OAUTH_STATE");
    }

    // Delete immediately — single use
    memoryStore.del(stateKey);

    const payload: OAuthStatePayload = JSON.parse(raw);

    if (payload.platform !== platform) {
        throw new AppError("OAuth state platform mismatch.", 400, "OAUTH_PLATFORM_MISMATCH");
    }

    const adapter = getAdapter(platform);
    const result = await adapter.handleOAuthCallback(code, payload);

    // Upsert ConnectedAccount (one per platform per user)
    const account = await prisma.connectedAccount.upsert({
        where: {
            user_id_platform: { user_id: payload.userId, platform },
        },
        update: {
            access_token: encrypt(result.accessToken),
            refresh_token: result.refreshToken ? encrypt(result.refreshToken) : null,
            token_expires_at: result.tokenExpiresAt ?? null,
            platform_account_id: result.platformAccountId,
            platform_account_name: result.platformAccountName,
            status: "CONNECTED",
            scopes: result.scopes ?? null,
            updated_at: new Date(),
        },
        create: {
            user_id: payload.userId,
            platform,
            access_token: encrypt(result.accessToken),
            refresh_token: result.refreshToken ? encrypt(result.refreshToken) : null,
            token_expires_at: result.tokenExpiresAt ?? null,
            platform_account_id: result.platformAccountId,
            platform_account_name: result.platformAccountName,
            status: "CONNECTED",
            scopes: result.scopes ?? null,
        },
        select: {
            id: true,
            platform: true,
            platform_account_id: true,
            platform_account_name: true,
            status: true,
            created_at: true,
        },
    });

    return account;
}

export async function disconnectAccount(
    userId: string,
    platform: Platform
): Promise<void> {
    const account = await prisma.connectedAccount.findUnique({
        where: { user_id_platform: { user_id: userId, platform } },
    });

    if (!account) {
        throw new AppError("Account not found.", 404, "ACCOUNT_NOT_FOUND");
    }

    await prisma.connectedAccount.delete({
        where: { id: account.id },
    });
}

// ─── Instagram media listing ──────────────────────────────────────────────────

export interface InstagramMediaItem {
    id: string;
    media_type: "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM";
    media_url?: string;
    thumbnail_url?: string;
    permalink: string;
    caption?: string;
    timestamp: string;
    like_count?: number;
    comments_count?: number;
}

export interface InstagramMediaPage {
    items: InstagramMediaItem[];
    next_cursor: string | null;  // opaque cursor for next page, null = no more pages
}

/** Instagram Graph API fields requested for every media item */
const IG_MEDIA_FIELDS =
    "id,media_type,media_url,thumbnail_url,permalink,caption,timestamp,like_count,comments_count";

/** Resolve and refresh the Instagram connected account for a given user. */
async function resolveIgAccount(userId: string) {
    const account = await prisma.connectedAccount.findUnique({
        where: { user_id_platform: { user_id: userId, platform: "INSTAGRAM" } },
    });
    if (!account || account.status !== "CONNECTED") {
        throw new AppError("Instagram account not connected.", 400, "IG_NOT_CONNECTED");
    }
    const { instagramAdapter } = await import("../adapters/instagram.adapter");
    return instagramAdapter.refreshTokenIfNeeded(account);
}

/**
 * Fetch a paginated list of the user's Instagram posts/reels.
 *
 * @param userId  - CrossPost AI user id
 * @param limit   - items per page (max 50)
 * @param cursor  - opaque after-cursor from a previous response; omit for first page
 */
export async function getInstagramMedia(
    userId: string,
    limit = 20,
    cursor?: string
): Promise<InstagramMediaPage> {
    const freshAccount = await resolveIgAccount(userId);

    const { decrypt } = await import("../lib/encryption");
    const accessToken = decrypt(freshAccount.access_token);
    const igUserId = freshAccount.platform_account_id;

    const { default: axios } = await import("axios");

    const params: Record<string, string | number> = {
        fields: IG_MEDIA_FIELDS,
        limit: Math.min(limit, 50),
        access_token: accessToken,
    };
    if (cursor) params.after = cursor;

    const res = await axios.get<{
        data: Array<{
            id: string;
            media_type: string;
            media_url?: string;
            thumbnail_url?: string;
            permalink: string;
            caption?: string;
            timestamp: string;
            like_count?: number;
            comments_count?: number;
        }>;
        paging?: {
            cursors?: { after?: string };
            next?: string;
        };
    }>(`https://graph.instagram.com/v21.0/${igUserId}/media`, {
        params,
        timeout: 15_000,
    });

    const items: InstagramMediaItem[] = (res.data.data ?? []).map((item) => ({
        id: item.id,
        media_type: item.media_type as InstagramMediaItem["media_type"],
        media_url: item.media_url,
        // Videos return thumbnail_url separately; images use media_url as thumb
        thumbnail_url: item.thumbnail_url ?? item.media_url,
        permalink: item.permalink,
        caption: item.caption,
        timestamp: item.timestamp,
        like_count: item.like_count,
        comments_count: item.comments_count,
    }));

    // Extract next-page cursor from Meta's paging envelope
    const next_cursor = res.data.paging?.cursors?.after ?? null;
    // If there's no `paging.next` URL, we're on the last page even if cursor exists
    const hasMore = !!res.data.paging?.next;

    return { items, next_cursor: hasMore ? next_cursor : null };
}

/**
 * Fetch the details for a single Instagram media item.
 * Used by AutomationCard to display a thumbnail for an automation that targets
 * a specific post/reel.
 *
 * Ownership: verifies the account belongs to userId before fetching.
 */
export async function getInstagramMediaById(
    userId: string,
    mediaId: string
): Promise<InstagramMediaItem> {
    const freshAccount = await resolveIgAccount(userId);

    const { decrypt } = await import("../lib/encryption");
    const accessToken = decrypt(freshAccount.access_token);

    const { default: axios } = await import("axios");

    const res = await axios.get<{
        id: string;
        media_type: string;
        media_url?: string;
        thumbnail_url?: string;
        permalink: string;
        caption?: string;
        timestamp: string;
        like_count?: number;
        comments_count?: number;
    }>(`https://graph.instagram.com/v21.0/${mediaId}`, {
        params: {
            fields: IG_MEDIA_FIELDS,
            access_token: accessToken,
        },
        timeout: 15_000,
    });

    return {
        id: res.data.id,
        media_type: res.data.media_type as InstagramMediaItem["media_type"],
        media_url: res.data.media_url,
        thumbnail_url: res.data.thumbnail_url ?? res.data.media_url,
        permalink: res.data.permalink,
        caption: res.data.caption,
        timestamp: res.data.timestamp,
        like_count: res.data.like_count,
        comments_count: res.data.comments_count,
    };
}

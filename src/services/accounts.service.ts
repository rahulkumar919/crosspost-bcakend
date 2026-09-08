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

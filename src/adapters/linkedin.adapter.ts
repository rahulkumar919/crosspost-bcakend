/**
 * LinkedIn adapter — LinkedIn OAuth 2.0 + REST Posts API
 *
 * API version used: LinkedIn REST API (Posts API — 202401)
 * Endpoints used:
 *   - OAuth:              https://www.linkedin.com/oauth/v2/authorization
 *   - Token:              https://www.linkedin.com/oauth/v2/accessToken
 *   - Profile (legacy):   GET https://api.linkedin.com/v2/me
 *   - Profile (OIDC):     GET https://api.linkedin.com/v2/userinfo
 *   - Image init upload:  POST https://api.linkedin.com/rest/images?action=initializeUpload
 *   - Video init upload:  POST https://api.linkedin.com/rest/videos?action=initializeUpload
 *   - Video finalize:     POST https://api.linkedin.com/rest/videos?action=finalizeUpload
 *   - Video status poll:  GET  https://api.linkedin.com/rest/videos/{id}
 *   - Create post:        POST https://api.linkedin.com/rest/posts
 *
 * ⚠️  SCOPES:
 *     Standard LinkedIn Apps support: r_liteprofile, r_emailaddress, w_member_social
 *     OIDC scopes (openid, profile, email) require the "Sign In with LinkedIn using
 *     OpenID Connect" product — causes "Bummer, something went wrong" if missing.
 *     We request standard scopes and try OIDC /userinfo first, then fallback to /v2/me.
 *
 * ⚠️  TOKEN EXPIRY:
 *     LinkedIn access tokens expire in ~60 days. Standard OAuth apps do NOT
 *     support server-side token refresh (requires partner-level access).
 *     We mark tokens EXPIRED and ask the user to reconnect.
 *
 * ⚠️  DEPRECATED APIs:
 *     The UGC Posts API (/v2/ugcPosts) and Assets API (/v2/assets) are deprecated.
 *     This adapter uses the newer /rest/posts + /rest/videos + /rest/images APIs
 *     with the LinkedIn-Version header (202401).
 *
 * ⚠️  VIDEO UPLOAD:
 *     Video upload is multi-step (initialize → chunked upload → finalize → poll).
 *     Chunk eTags from each PUT response must be collected and passed to finalizeUpload.
 *
 * ⚠️  POST ID:
 *     The post ID is returned in the "x-restli-id" response header, not the body.
 */
import axios from "axios";
import { ConnectedAccount, PostTarget } from "@prisma/client";
import { env } from "../config/env";
import { decrypt } from "../lib/encryption";
import { prisma } from "../config/db";
import { logger } from "../lib/logger";
import { AppError } from "../middleware/error-handler.middleware";
import type { PlatformPublisher } from "./platform-publisher.interface";
import type { OAuthStatePayload } from "../types/account.types";
import type { PublishResult } from "../types/post.types";

const LI_AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization";
const LI_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const LI_API_V2 = "https://api.linkedin.com/v2";
const LI_REST = "https://api.linkedin.com/rest";
function getLinkedInVersion(): string {
    if (env.LINKEDIN_VERSION) {
        return env.LINKEDIN_VERSION;
    }
    const d = new Date();
    // LinkedIn versions are YYYYMM and stay active for 12 months.
    // Use previous month to ensure the version is released and active.
    d.setMonth(d.getMonth() - 1);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    return `${year}${month}`;
}

// ─── OAuth Scopes ────────────────────────────────────────────────────────────
//
// Modern LinkedIn (2023+) uses OIDC scopes via the
// "Sign In with LinkedIn using OpenID Connect" product:
//   openid  → userinfo endpoint (/v2/userinfo)
//   profile → name, picture
//   email   → email address
//   w_member_social → create posts
//
// The OLD scopes r_liteprofile / r_emailaddress are DEPRECATED for new apps.
// Requesting them causes "Bummer, something went wrong" on the consent page.
//
// ✅ To add the OIDC product to your LinkedIn app:
//   1. Go to https://www.linkedin.com/developers/apps
//   2. Select your app → Products tab
//   3. Click Request Access on "Sign In with LinkedIn using OpenID Connect"
//   4. Click Request Access on "Share on LinkedIn"
const SCOPES = ["openid", "profile", "email", "w_member_social"].join(" ");

// Mark expired if within 3 days
const EXPIRY_WARN_MS = 3 * 24 * 60 * 60 * 1000;

// ─── Helper: Build standard REST API headers ──────────────────────────────────

function buildHeaders(accessToken: string): Record<string, string> {
    return {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "LinkedIn-Version": getLinkedInVersion(),
        "X-Restli-Protocol-Version": "2.0.0",
    };
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export const linkedinAdapter: PlatformPublisher = {
    getAuthUrl(state: string): string {
        if (!env.LINKEDIN_CLIENT_ID || !env.LINKEDIN_CLIENT_SECRET) {
            throw new AppError(
                "LinkedIn is not configured. Please set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET in your .env file.",
                500,
                "LINKEDIN_NOT_CONFIGURED"
            );
        }
        const params = new URLSearchParams({
            response_type: "code",
            client_id: env.LINKEDIN_CLIENT_ID,
            redirect_uri: env.LINKEDIN_REDIRECT_URI,
            state,
            scope: SCOPES,
        });
        return `${LI_AUTH_URL}?${params.toString()}`;
    },

    async handleOAuthCallback(code: string, _state: OAuthStatePayload) {
        // ── Step 1: Exchange authorization code for access token ───────────────
        let tokenData: { access_token: string; expires_in: number; scope: string };
        try {
            const tokenRes = await axios.post<{
                access_token: string;
                expires_in: number;
                scope: string;
            }>(
                LI_TOKEN_URL,
                new URLSearchParams({
                    grant_type: "authorization_code",
                    code,
                    redirect_uri: env.LINKEDIN_REDIRECT_URI,
                    client_id: env.LINKEDIN_CLIENT_ID,
                    client_secret: env.LINKEDIN_CLIENT_SECRET,
                }),
                { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
            );
            tokenData = tokenRes.data;
        } catch (err: any) {
            const detail = err?.response?.data;
            const msg =
                detail?.error_description ??
                detail?.error ??
                err.message ??
                "Token exchange failed";
            logger.error("LinkedIn token exchange failed", { detail });

            if (detail?.error === "invalid_client" || msg?.includes("Client authentication failed")) {
                throw new AppError(
                    "LinkedIn connection failed: Client authentication failed. Your LINKEDIN_CLIENT_SECRET in backend .env is invalid or does not match your LinkedIn Developer Portal app credentials. Please copy the Primary Client Secret from LinkedIn Developer Portal -> Auth tab, paste it into LINKEDIN_CLIENT_SECRET in crosspost-ai-backend/.env, and restart the backend server.",
                    400,
                    "LINKEDIN_INVALID_CLIENT"
                );
            }

            throw new AppError(
                `LinkedIn connection failed: ${msg}`,
                400,
                "LINKEDIN_TOKEN_EXCHANGE_FAILED"
            );
        }

        const { access_token, expires_in, scope: grantedScopes } = tokenData;
        logger.info("LinkedIn token exchanged successfully", { grantedScopes });

        // ── Step 2: Fetch profile — try id_token JWT first, then OIDC, then legacy ─
        // Profile fetch is non-fatal: if it fails, we still connect the account.
        let platformAccountId = "";
        let platformAccountName = "LinkedIn User";

        // Try decoding id_token (LinkedIn includes standard OIDC id_token in token response)
        const rawIdToken = (tokenData as any).id_token;
        if (rawIdToken && typeof rawIdToken === "string") {
            try {
                const parts = rawIdToken.split(".");
                if (parts.length === 3) {
                    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
                    if (payload.sub) platformAccountId = payload.sub;
                    if (payload.name) platformAccountName = payload.name;
                    logger.info("LinkedIn identity extracted directly from id_token JWT", { platformAccountId, platformAccountName });
                }
            } catch (jwtErr: any) {
                logger.warn("Failed to parse LinkedIn id_token JWT", { error: jwtErr?.message });
            }
        }

        // Try OIDC /userinfo if id_token didn't provide full info
        if (!platformAccountId || platformAccountName === "LinkedIn User") {
            try {
                const profileRes = await axios.get<{
                    sub: string;
                    name: string;
                    given_name?: string;
                    family_name?: string;
                    email?: string;
                }>(`${LI_API_V2}/userinfo`, {
                    headers: { Authorization: `Bearer ${access_token}` },
                    timeout: 10_000,
                });
                if (profileRes.data.sub) platformAccountId = profileRes.data.sub;
                if (profileRes.data.name) {
                    platformAccountName = profileRes.data.name;
                } else if (profileRes.data.given_name || profileRes.data.family_name) {
                    platformAccountName = [profileRes.data.given_name, profileRes.data.family_name].filter(Boolean).join(" ");
                }
                logger.info("LinkedIn profile fetched via OIDC /userinfo", { platformAccountId, platformAccountName });
            } catch (oidcErr: any) {
            logger.warn("LinkedIn OIDC userinfo failed, trying legacy /v2/me", {
                status: oidcErr?.response?.status,
                error: oidcErr?.response?.data ?? oidcErr.message,
            });

            // Try legacy /v2/me (works with r_liteprofile — deprecated but may still work)
            try {
                const meRes = await axios.get<{
                    id: string;
                    localizedFirstName: string;
                    localizedLastName: string;
                }>(`${LI_API_V2}/me`, {
                    headers: { Authorization: `Bearer ${access_token}` },
                    timeout: 10_000,
                });
                platformAccountId = meRes.data.id;
                platformAccountName = `${meRes.data.localizedFirstName} ${meRes.data.localizedLastName}`.trim() || "LinkedIn User";
                logger.info("LinkedIn profile fetched via legacy /v2/me", { platformAccountId });
            } catch (legacyErr: any) {
                // Both failed — still connect but with placeholder name
                // The token is valid even if profile fetch failed
                logger.warn("LinkedIn profile fetch failed (both OIDC and legacy). Connecting with placeholder.", {
                    status: legacyErr?.response?.status,
                    error: legacyErr?.response?.data ?? legacyErr.message,
                });
                // Use a hash of access_token as a stable ID if we can't get the real one
                platformAccountId = `li_${Buffer.from(access_token.slice(-20)).toString("hex").slice(0, 16)}`;
                platformAccountName = "LinkedIn Account";
            }
        }
    }

        return {
            id: "",
            platform: "LINKEDIN",
            platformAccountId,
            platformAccountName,
            status: "CONNECTED",

            accessToken: access_token,
            tokenExpiresAt: new Date(Date.now() + expires_in * 1000),
            scopes: grantedScopes || SCOPES,
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
                "Your LinkedIn connection has expired. Please reconnect your account to continue posting.",
                401,
                "TOKEN_EXPIRED"
            );
        }

        if (timeLeft < EXPIRY_WARN_MS) {
            logger.warn("LinkedIn token expiring soon — user should reconnect", {
                accountId: account.id,
                expiresAt: expiresAt.toISOString(),
            });
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
            const freshAccount = await linkedinAdapter.refreshTokenIfNeeded(account);
            const accessToken = decrypt(freshAccount.access_token);
            const authorUrn = `urn:li:person:${freshAccount.platform_account_id}`;
            const headers = buildHeaders(accessToken);

            logger.info("Starting LinkedIn publish", {
                accountId: account.id,
                authorUrn,
                mediaType,
            });

            // ── Step 1: Fetch media binary from Cloudinary ──────────────────
            const mediaRes = await axios.get<ArrayBuffer>(mediaUrl, {
                responseType: "arraybuffer",
                timeout: 120_000,
            });
            const mediaBuffer = Buffer.from(mediaRes.data);
            const fileSizeBytes = mediaBuffer.length;

            logger.info("Media fetched", { fileSizeBytes, mediaType });

            // ── Step 2: Upload media (image or video) ───────────────────────
            let mediaUrn: string;

            if (mediaType === "IMAGE") {
                mediaUrn = await uploadImage(mediaBuffer, authorUrn, headers);
            } else {
                mediaUrn = await uploadVideo(mediaBuffer, fileSizeBytes, authorUrn, headers);
            }

            logger.info("LinkedIn media uploaded", { mediaUrn, mediaType });

            // ── Step 3: Create the post ─────────────────────────────────────
            const caption = buildCaption(postTarget);

            const postBody = {
                author: authorUrn,
                commentary: caption,
                visibility: "PUBLIC",
                distribution: {
                    feedDistribution: "MAIN_FEED",
                    targetEntities: [],
                    thirdPartyDistributionChannels: [],
                },
                content: {
                    media: {
                        id: mediaUrn,
                    },
                },
                lifecycleState: "PUBLISHED",
                isReshareDisabledByAuthor: false,
            };

            const postRes = await axios.post(`${LI_REST}/posts`, postBody, { headers });

            // Post ID comes in x-restli-id header for REST API
            const postId: string =
                postRes.headers["x-restli-id"] ??
                postRes.data?.id ??
                postRes.data?.value?.id ??
                "";

            logger.info("LinkedIn post published successfully", {
                accountId: account.id,
                postId,
            });

            return {
                success: true,
                platformPostUrl: postId
                    ? `https://www.linkedin.com/feed/update/${encodeURIComponent(postId)}/`
                    : "https://www.linkedin.com/feed/",
            };
        } catch (err: any) {
            const errorDetails = err?.response?.data;
            logger.error("LinkedIn publish failed", {
                error: err.message,
                details: JSON.stringify(errorDetails),
                status: err?.response?.status,
            });
            const detailMsg =
                errorDetails?.message ??
                errorDetails?.errorDetailType ??
                errorDetails?.[0]?.message ??
                err.message ??
                "Failed to publish to LinkedIn";
            return {
                success: false,
                errorMessage: `LinkedIn error: ${detailMsg}`,
            };
        }
    },
};

// ─── Image Upload ─────────────────────────────────────────────────────────────

async function uploadImage(
    buffer: Buffer,
    owner: string,
    headers: Record<string, string>
): Promise<string> {
    // Initialize upload
    const initRes = await axios.post<{
        value: {
            image: string;
            uploadUrl: string;
        };
    }>(
        `${LI_REST}/images?action=initializeUpload`,
        { initializeUploadRequest: { owner } },
        { headers }
    );

    const { image: imageUrn, uploadUrl } = initRes.data.value;

    // Upload binary
    await axios.put(uploadUrl, buffer, {
        headers: { "Content-Type": "application/octet-stream" },
        timeout: 120_000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
    });

    return imageUrn;
}

// ─── Video Upload ─────────────────────────────────────────────────────────────

interface UploadInstruction {
    uploadUrl: string;
    firstByte: number;
    lastByte: number;
}

async function uploadVideo(
    buffer: Buffer,
    fileSizeBytes: number,
    owner: string,
    headers: Record<string, string>
): Promise<string> {
    // Step A: Initialize upload
    const initRes = await axios.post<{
        value: {
            video: string;
            uploadToken: string;
            uploadInstructions: UploadInstruction[];
        };
    }>(
        `${LI_REST}/videos?action=initializeUpload`,
        {
            initializeUploadRequest: {
                owner,
                fileSizeBytes,
                uploadCaptions: false,
                uploadThumbnail: false,
            },
        },
        { headers }
    );

    const { video: videoUrn, uploadToken, uploadInstructions } = initRes.data.value;

    logger.info("LinkedIn video upload initialized", {
        videoUrn,
        chunks: uploadInstructions.length,
    });

    // Step B: Upload each chunk and collect eTags
    const uploadedPartIds: string[] = [];

    for (let i = 0; i < uploadInstructions.length; i++) {
        const instruction = uploadInstructions[i];
        const chunk = buffer.slice(instruction.firstByte, instruction.lastByte + 1);

        const putRes = await axios.put(instruction.uploadUrl, chunk, {
            headers: { "Content-Type": "application/octet-stream" },
            timeout: 180_000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
        });

        // ETag is required for finalizeUpload
        const eTag: string =
            putRes.headers["etag"] ??
            putRes.headers["ETag"] ??
            `part-${i + 1}`;

        uploadedPartIds.push(eTag.replace(/"/g, "")); // strip quotes if present

        logger.info(`LinkedIn video chunk ${i + 1}/${uploadInstructions.length} uploaded`, {
            eTag: uploadedPartIds[i],
        });
    }

    // Step C: Finalize upload
    await axios.post(
        `${LI_REST}/videos?action=finalizeUpload`,
        {
            finalizeUploadRequest: {
                video: videoUrn,
                uploadToken,
                uploadedPartIds,
            },
        },
        { headers }
    );

    logger.info("LinkedIn video finalized, waiting for processing...", { videoUrn });

    // Step D: Poll until AVAILABLE
    await pollVideoStatus(videoUrn, headers);

    return videoUrn;
}

// ─── Video Status Polling ─────────────────────────────────────────────────────

async function pollVideoStatus(
    videoUrn: string,
    headers: Record<string, string>,
    maxWaitMs = 120_000
): Promise<void> {
    const startTime = Date.now();
    const encodedUrn = encodeURIComponent(videoUrn);
    const checkUrl = `${LI_REST}/videos/${encodedUrn}`;

    while (Date.now() - startTime < maxWaitMs) {
        try {
            const res = await axios.get<{ status?: string; id?: string }>(checkUrl, { headers });
            const status = res.data?.status;
            logger.info("LinkedIn video status poll", { videoUrn, status });

            if (status === "AVAILABLE") return;

            if (status === "PROCESSING_FAILED" || status === "DELETED") {
                throw new Error(`LinkedIn video processing failed with status: ${status}`);
            }
        } catch (err: any) {
            if (
                err.message?.includes("processing failed") ||
                err.message?.includes("DELETED")
            ) {
                throw err;
            }
            logger.warn("LinkedIn video status poll retry", { error: err.message });
        }

        await sleep(4000);
    }

    throw new Error("LinkedIn video processing timed out after 2 minutes.");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildCaption(postTarget: PostTarget): string {
    const hashtags = postTarget.final_hashtags.map((t) => `#${t}`).join(" ");
    return [postTarget.final_description, hashtags]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, 3000); // LinkedIn commentary max
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

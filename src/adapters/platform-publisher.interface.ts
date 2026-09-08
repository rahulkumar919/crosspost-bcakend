import type { ConnectedAccount, PostTarget } from "@prisma/client";
import type { ConnectedAccountResult, OAuthStatePayload } from "../types/account.types";
import type { PublishResult } from "../types/post.types";

export interface PlatformPublisher {
    /** Returns the OAuth authorization URL to redirect the user to */
    getAuthUrl(state: string): string;

    /**
     * Exchanges the OAuth code for tokens, fetches the platform user profile,
     * and returns the data needed to upsert a ConnectedAccount row.
     */
    handleOAuthCallback(
        code: string,
        state: OAuthStatePayload
    ): Promise<ConnectedAccountResult & {
        accessToken: string;
        refreshToken?: string;
        tokenExpiresAt?: Date;
        scopes?: string;
    }>;

    /**
     * Checks if the token is close to expiry and refreshes it.
     * Returns the (possibly updated) account.
     * Must update the DB row if tokens were refreshed.
     */
    refreshTokenIfNeeded(account: ConnectedAccount): Promise<ConnectedAccount>;

    /**
     * Publishes the content to the platform.
     * Called from the BullMQ worker — must be idempotent-safe on retry.
     */
    publish(
        account: ConnectedAccount,
        postTarget: PostTarget,
        mediaUrl: string,
        mediaType: "VIDEO" | "IMAGE"
    ): Promise<PublishResult>;
}

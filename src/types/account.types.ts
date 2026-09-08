import { Platform, AccountStatus } from "@prisma/client";

export { Platform, AccountStatus };

export interface ConnectedAccountResult {
    id: string;
    platform: Platform;
    platformAccountId: string;
    platformAccountName: string;
    status: AccountStatus;
}

export interface OAuthStatePayload {
    userId: string;
    platform: Platform;
    /** ISO timestamp — used to expire the state token after 10 minutes */
    createdAt: string;
}

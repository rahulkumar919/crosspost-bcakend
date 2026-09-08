import { Platform, PublishStatus, PostStatus, MediaType } from "@prisma/client";

export { Platform, PublishStatus, PostStatus, MediaType };

export interface PublishResult {
    success: boolean;
    platformPostUrl?: string;
    /** User-safe error message */
    errorMessage?: string;
}

export interface PostTargetInput {
    platform: Platform;
    finalTitle: string;
    finalDescription: string;
    finalHashtags: string[];
}

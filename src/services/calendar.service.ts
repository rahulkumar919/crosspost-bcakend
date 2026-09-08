import { prisma } from "../config/db";
import { AppError } from "../middleware/error-handler.middleware";
import type { Platform, MediaType, PublishStatus } from "@prisma/client";

export interface ScheduleTargetInput {
    platform: Platform;
    finalTitle?: string;
    finalDescription?: string;
    finalHashtags?: string[];
    scheduledAt?: string | Date;
}

export interface SchedulePostInput {
    userId: string;
    mediaUrl: string;
    mediaType: MediaType;
    cloudinaryId: string;
    rawCaption?: string;
    aiTitle?: string;
    aiDescription?: string;
    aiHashtags?: string[];
    scheduledAt: string | Date;
    targets: ScheduleTargetInput[];
}

export interface UpdateScheduleInput {
    aiTitle?: string;
    rawCaption?: string;
    scheduledAt?: string | Date;
    targets?: {
        platform: Platform;
        finalTitle?: string;
        finalDescription?: string;
        finalHashtags?: string[];
        scheduledAt?: string | Date;
    }[];
}

export async function getCalendarEvents(
    userId: string,
    filters: {
        start?: string;
        end?: string;
        platform?: string;
        status?: string;
    } = {}
) {
    const startDate = filters.start ? new Date(filters.start) : new Date(Date.now() - 30 * 86400000);
    const endDate = filters.end ? new Date(filters.end) : new Date(Date.now() + 60 * 86400000);

    const targetWhere: Record<string, unknown> = {};
    if (filters.platform && filters.platform !== "ALL") {
        targetWhere.platform = filters.platform.toUpperCase() as Platform;
    }
    if (filters.status && filters.status !== "ALL") {
        targetWhere.publish_status = filters.status.toUpperCase() as PublishStatus;
    }

    const posts = await prisma.post.findMany({
        where: {
            user_id: userId,
            OR: [
                {
                    scheduled_at: {
                        gte: startDate,
                        lte: endDate,
                    },
                },
                {
                    created_at: {
                        gte: startDate,
                        lte: endDate,
                    },
                },
            ],
        },
        orderBy: [{ scheduled_at: "asc" }, { created_at: "desc" }],
        include: {
            targets: {
                where: Object.keys(targetWhere).length > 0 ? targetWhere : undefined,
            },
        },
    });

    // Flatten into unified events list
    const events = posts.map((post) => {
        const effectiveDate = post.scheduled_at || post.created_at;
        const isScheduled = !!post.scheduled_at && new Date(post.scheduled_at).getTime() > Date.now();
        const allPublished = post.targets.length > 0 && post.targets.every((t) => t.publish_status === "PUBLISHED");
        const anyFailed = post.targets.some((t) => t.publish_status === "FAILED");
        const anyQueued = post.targets.some((t) => t.publish_status === "QUEUED" || t.publish_status === "UPLOADING");

        let overallStatus = "DRAFT";
        if (allPublished) overallStatus = "PUBLISHED";
        else if (anyFailed) overallStatus = "FAILED";
        else if (anyQueued) overallStatus = "PUBLISHING";
        else if (isScheduled) overallStatus = "SCHEDULED";
        else if (post.targets.some((t) => t.publish_status === "PUBLISHED")) overallStatus = "PARTIALLY_DELIVERED";

        return {
            id: post.id,
            postId: post.id,
            title: post.ai_title || post.raw_caption || "Untitled Post",
            rawCaption: post.raw_caption,
            mediaUrl: post.media_url,
            mediaType: post.media_type,
            scheduledAt: post.scheduled_at,
            createdAt: post.created_at,
            effectiveDate,
            status: overallStatus,
            targets: post.targets.map((t) => ({
                id: t.id,
                platform: t.platform,
                title: t.final_title,
                description: t.final_description,
                hashtags: t.final_hashtags,
                status: t.publish_status,
                scheduledAt: t.scheduled_at || post.scheduled_at,
                publishedAt: t.published_at,
                platformPostUrl: t.platform_post_url,
                errorMessage: t.error_message,
                retryCount: t.retry_count,
            })),
        };
    });

    return events;
}

export async function getUpcomingPosts(userId: string, limit = 15) {
    const now = new Date();

    const posts = await prisma.post.findMany({
        where: {
            user_id: userId,
            scheduled_at: {
                gte: now,
            },
        },
        orderBy: { scheduled_at: "asc" },
        take: limit,
        include: {
            targets: true,
        },
    });

    return posts.map((post) => ({
        id: post.id,
        title: post.ai_title || post.raw_caption || "Untitled Post",
        mediaUrl: post.media_url,
        mediaType: post.media_type,
        rawCaption: post.raw_caption,
        scheduledAt: post.scheduled_at!,
        createdAt: post.created_at,
        targets: post.targets.map((t) => ({
            id: t.id,
            platform: t.platform,
            scheduledAt: t.scheduled_at || post.scheduled_at,
            status: t.publish_status,
        })),
    }));
}

export async function schedulePost(input: SchedulePostInput) {
    if (!input.targets.length) {
        throw new AppError("At least one target platform required.", 400, "NO_TARGETS");
    }

    const scheduledDate = new Date(input.scheduledAt);
    if (isNaN(scheduledDate.getTime())) {
        throw new AppError("Invalid scheduled date/time.", 400, "INVALID_DATE");
    }

    const defaultTitle = (input.aiTitle || input.rawCaption || "Scheduled Video 🚀").trim().slice(0, 80);
    const defaultDesc = (input.aiDescription || input.rawCaption || "Check out this post! Scheduled via CrossPost AI").trim();

    const post = await prisma.post.create({
        data: {
            user_id: input.userId,
            media_url: input.mediaUrl,
            media_type: input.mediaType,
            cloudinary_id: input.cloudinaryId,
            raw_caption: input.rawCaption ?? null,
            ai_title: input.aiTitle ?? defaultTitle,
            ai_description: input.aiDescription ?? defaultDesc,
            ai_hashtags: input.aiHashtags ?? [],
            status: "DRAFT",
            scheduled_at: scheduledDate,
            targets: {
                create: input.targets.map((t) => {
                    const targetSchedDate = t.scheduledAt ? new Date(t.scheduledAt) : scheduledDate;
                    return {
                        platform: t.platform,
                        final_title: t.finalTitle?.trim() || defaultTitle,
                        final_description: t.finalDescription?.trim() || defaultDesc,
                        final_hashtags: t.finalHashtags || [],
                        publish_status: "PENDING",
                        scheduled_at: targetSchedDate,
                    };
                }),
            },
        },
        include: { targets: true },
    });

    return post;
}

export async function updateSchedule(
    userId: string,
    postId: string,
    input: UpdateScheduleInput
) {
    const post = await prisma.post.findFirst({
        where: { id: postId, user_id: userId },
        include: { targets: true },
    });

    if (!post) {
        throw new AppError("Scheduled post not found.", 404, "POST_NOT_FOUND");
    }

    const updateData: Record<string, unknown> = {};

    if (input.aiTitle !== undefined) updateData.ai_title = input.aiTitle;
    if (input.rawCaption !== undefined) updateData.raw_caption = input.rawCaption;
    if (input.scheduledAt !== undefined) {
        updateData.scheduled_at = new Date(input.scheduledAt);
    }

    const updated = await prisma.post.update({
        where: { id: postId },
        data: updateData,
        include: { targets: true },
    });

    // Update target scheduled times or content if provided
    if (input.targets && input.targets.length > 0) {
        for (const tInput of input.targets) {
            const existingTarget = updated.targets.find((t) => t.platform === tInput.platform);
            if (existingTarget) {
                await prisma.postTarget.update({
                    where: { id: existingTarget.id },
                    data: {
                        final_title: tInput.finalTitle ?? existingTarget.final_title,
                        final_description: tInput.finalDescription ?? existingTarget.final_description,
                        final_hashtags: tInput.finalHashtags ?? existingTarget.final_hashtags,
                        scheduled_at: tInput.scheduledAt ? new Date(tInput.scheduledAt) : updateData.scheduled_at as Date ?? existingTarget.scheduled_at,
                    },
                });
            }
        }
    }

    return prisma.post.findUnique({
        where: { id: postId },
        include: { targets: true },
    });
}

export async function cancelSchedule(userId: string, postId: string) {
    const post = await prisma.post.findFirst({
        where: { id: postId, user_id: userId },
    });

    if (!post) {
        throw new AppError("Scheduled post not found.", 404, "POST_NOT_FOUND");
    }

    await prisma.postTarget.deleteMany({ where: { post_id: postId } });
    await prisma.post.delete({ where: { id: postId } });

    return { success: true };
}

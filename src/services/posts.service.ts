import { prisma } from "../config/db";
import { AppError } from "../middleware/error-handler.middleware";
import { enqueuePublishJob } from "../queue/publish.queue";
import type { Platform, MediaType } from "@prisma/client";
import type { PostTargetInput } from "../types/post.types";

interface CreatePostInput {
    userId: string;
    mediaUrl: string;
    mediaType: MediaType;
    cloudinaryId: string;
    rawCaption?: string;
    aiTitle?: string;
    aiDescription?: string;
    aiHashtags?: string[];
    targets: PostTargetInput[];
}

export async function createPost(input: CreatePostInput) {
    if (!input.targets.length) {
        throw new AppError("At least one platform target is required.", 400, "NO_TARGETS");
    }

    const post = await prisma.post.create({
        data: {
            user_id: input.userId,
            media_url: input.mediaUrl,
            media_type: input.mediaType,
            cloudinary_id: input.cloudinaryId,
            raw_caption: input.rawCaption ?? null,
            ai_title: input.aiTitle ?? null,
            ai_description: input.aiDescription ?? null,
            ai_hashtags: input.aiHashtags ?? [],
            status: "DRAFT",
            targets: {
                create: input.targets.map((t) => ({
                    platform: t.platform,
                    final_title: t.finalTitle,
                    final_description: t.finalDescription,
                    final_hashtags: t.finalHashtags,
                    publish_status: "PENDING",
                })),
            },
        },
        include: { targets: true },
    });

    return post;
}

export async function getPost(postId: string, userId: string) {
    const post = await prisma.post.findFirst({
        where: { id: postId, user_id: userId },
        include: { targets: true },
    });

    if (!post) {
        throw new AppError("Post not found.", 404, "POST_NOT_FOUND");
    }

    return post;
}

export async function listPosts(
    userId: string,
    options: {
        page?: number;
        limit?: number;
        status?: string;
        platform?: string;
        search?: string;
    } = {}
) {
    const page = Math.max(1, options.page ?? 1);
    const limit = Math.min(100, Math.max(1, options.limit ?? 20));
    const skip = (page - 1) * limit;

    // Build WHERE clause
    const where: Record<string, unknown> = { user_id: userId };

    if (options.status && options.status !== "ALL") {
        where.status = options.status.toUpperCase();
    }

    // Search in ai_title or raw_caption
    if (options.search && options.search.trim()) {
        where.OR = [
            { ai_title: { contains: options.search, mode: "insensitive" } },
            { raw_caption: { contains: options.search, mode: "insensitive" } },
        ];
    }

    // Filter by platform — narrow via target
    const targetWhere: Record<string, unknown> = {};
    if (options.platform && options.platform !== "ALL") {
        targetWhere.platform = options.platform.toUpperCase();
    }

    const [posts, total] = await Promise.all([
        prisma.post.findMany({
            where,
            orderBy: { created_at: "desc" },
            skip,
            take: limit,
            select: {
                id: true,
                status: true,
                media_url: true,
                media_type: true,
                ai_title: true,
                raw_caption: true,
                created_at: true,
                updated_at: true,
                targets: {
                    where: Object.keys(targetWhere).length ? targetWhere : undefined,
                    select: {
                        id: true,
                        platform: true,
                        publish_status: true,
                        platform_post_url: true,
                        error_message: true,
                        retry_count: true,
                        published_at: true,
                        final_title: true,
                    },
                },
            },
        }),
        prisma.post.count({ where }),
    ]);

    // Filter out posts that have no matching targets when platform filter is active
    const filtered = options.platform && options.platform !== "ALL"
        ? posts.filter((p) => p.targets.length > 0)
        : posts;

    return {
        posts: filtered,
        pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
            hasMore: page * limit < total,
        },
    };
}

export async function publishPost(postId: string, userId: string) {
    const post = await prisma.post.findFirst({
        where: { id: postId, user_id: userId },
        include: { targets: true },
    });

    if (!post) throw new AppError("Post not found.", 404, "POST_NOT_FOUND");

    if (post.status === "PUBLISHING") {
        throw new AppError("This post is already being published.", 409, "ALREADY_PUBLISHING");
    }

    const pendingTargets = post.targets.filter(
        (t) => t.publish_status === "PENDING" || t.publish_status === "FAILED"
    );

    if (!pendingTargets.length) {
        throw new AppError(
            "No publishable targets found (all are already published or queued).",
            409,
            "NO_PUBLISHABLE_TARGETS"
        );
    }

    // Mark post as PUBLISHING
    await prisma.post.update({
        where: { id: postId },
        data: { status: "PUBLISHING" },
    });

    // Enqueue one job per PostTarget — never one job for the whole post
    for (const target of pendingTargets) {
        await prisma.postTarget.update({
            where: { id: target.id },
            data: { publish_status: "QUEUED" },
        });

        await enqueuePublishJob({
            postId,
            postTargetId: target.id,
            userId,
            platform: target.platform,
        });
    }

    return { queued: pendingTargets.length };
}

export async function getPostStatus(postId: string, userId: string) {
    const post = await prisma.post.findFirst({
        where: { id: postId, user_id: userId },
        select: {
            id: true,
            status: true,
            media_url: true,
            media_type: true,
            ai_title: true,
            created_at: true,
            updated_at: true,
            targets: {
                select: {
                    id: true,
                    platform: true,
                    publish_status: true,
                    platform_post_url: true,
                    error_message: true,
                    retry_count: true,
                    published_at: true,
                },
            },
        },
    });

    if (!post) throw new AppError("Post not found.", 404, "POST_NOT_FOUND");

    return post;
}

export async function retryPlatform(
    postId: string,
    userId: string,
    platform: Platform
) {
    const post = await prisma.post.findFirst({
        where: { id: postId, user_id: userId },
        include: { targets: { where: { platform } } },
    });

    if (!post) throw new AppError("Post not found.", 404, "POST_NOT_FOUND");

    const target = post.targets[0];
    if (!target) throw new AppError("Platform target not found.", 404, "TARGET_NOT_FOUND");

    if (target.publish_status !== "FAILED") {
        throw new AppError(
            "Only failed targets can be retried.",
            409,
            "TARGET_NOT_FAILED"
        );
    }

    await prisma.postTarget.update({
        where: { id: target.id },
        data: { publish_status: "QUEUED", error_message: null, retry_count: 0 },
    });

    await enqueuePublishJob({
        postId,
        postTargetId: target.id,
        userId,
        platform,
    });

    return { queued: true };
}

export async function deletePost(postId: string, userId: string) {
    const post = await prisma.post.findFirst({
        where: { id: postId, user_id: userId },
    });

    if (!post) throw new AppError("Post not found.", 404, "POST_NOT_FOUND");

    await prisma.postTarget.deleteMany({ where: { post_id: postId } });
    await prisma.post.delete({ where: { id: postId } });

    return { success: true };
}

import { Request, Response, NextFunction } from "express";
import * as postsService from "../services/posts.service";
import { AppError } from "../middleware/error-handler.middleware";
import {
    validateYouTubeContent,
    validateInstagramContent,
    validateLinkedInContent,
} from "../lib/platform-validators";
import { logger } from "../lib/logger";
import type { Platform, MediaType } from "@prisma/client";
import type { PostTargetInput } from "../types/post.types";

function parsePlatform(raw: string): Platform {
    const p = raw.toUpperCase() as Platform;
    if (!["YOUTUBE", "INSTAGRAM", "LINKEDIN"].includes(p)) {
        throw new AppError(`Unsupported platform: ${raw}`, 400, "INVALID_PLATFORM");
    }
    return p;
}

/**
 * Validates and sanitizes per-platform content before persisting.
 * Hard errors (e.g. YouTube title > 100 chars) block the request.
 * Soft errors (truncation, hashtag count) are auto-applied with a warning.
 */
function validateAndSanitizeTargets(targets: PostTargetInput[], defaultTitle = "New Post", defaultDesc = "Published via CrossPost AI"): PostTargetInput[] {
    const sanitized: PostTargetInput[] = [];

    for (const target of targets) {
        const platform = target.platform;
        const titleToValidate = (target.finalTitle || "").trim() || defaultTitle;
        const descToValidate = (target.finalDescription || "").trim() || defaultDesc;
        const hashtagsToValidate = Array.isArray(target.finalHashtags) ? target.finalHashtags : [];

        let result;

        switch (platform) {
            case "YOUTUBE":
                result = validateYouTubeContent(
                    titleToValidate,
                    descToValidate,
                    hashtagsToValidate
                );
                break;
            case "INSTAGRAM":
                result = validateInstagramContent(
                    titleToValidate,
                    descToValidate,
                    hashtagsToValidate
                );
                break;
            case "LINKEDIN":
                result = validateLinkedInContent(
                    titleToValidate,
                    descToValidate,
                    hashtagsToValidate
                );
                break;
            default:
                sanitized.push(target);
                continue;
        }

        // Hard errors block the entire request
        if (!result.valid) {
            const hardErrors = result.errors.filter((e) => e.hard);
            const msg = hardErrors.map((e) => `[${platform}] ${e.message}`).join("; ");
            throw new AppError(msg, 400, "PLATFORM_VALIDATION_ERROR");
        }

        // Log soft errors (auto-sanitized)
        const softErrors = result.errors.filter((e) => !e.hard);
        if (softErrors.length > 0) {
            logger.warn("Platform content auto-sanitized", {
                platform,
                issues: softErrors.map((e) => e.message),
            });
        }

        sanitized.push({
            platform: target.platform,
            finalTitle: result.sanitized.title,
            finalDescription: result.sanitized.description,
            finalHashtags: result.sanitized.hashtags,
        });
    }

    return sanitized;
}

export async function createPost(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    try {
        const {
            mediaUrl,
            mediaType,
            cloudinaryId,
            rawCaption,
            aiTitle,
            aiDescription,
            aiHashtags,
            targets,
        } = req.body as {
            mediaUrl: string;
            mediaType: string;
            cloudinaryId: string;
            rawCaption?: string;
            aiTitle?: string;
            aiDescription?: string;
            aiHashtags?: string[];
            targets: PostTargetInput[];
        };

        const defaultTitle = (aiTitle || rawCaption || "Trending Video 🔥").trim().slice(0, 80);
        const defaultDesc = (aiDescription || rawCaption || "Check out this post! Published via CrossPost AI").trim();

        // Validate + sanitize per-platform content before saving
        const sanitizedTargets = validateAndSanitizeTargets(targets, defaultTitle, defaultDesc);

        const post = await postsService.createPost({
            userId: req.user!.id,
            mediaUrl,
            mediaType: mediaType.toUpperCase() as MediaType,
            cloudinaryId,
            rawCaption,
            aiTitle,
            aiDescription,
            aiHashtags,
            targets: sanitizedTargets,
        });

        res.status(201).json(post);
    } catch (err) {
        next(err);
    }
}

export async function listPosts(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    try {
        const { page, limit, status, platform, search } = req.query as {
            page?: string;
            limit?: string;
            status?: string;
            platform?: string;
            search?: string;
        };

        const result = await postsService.listPosts(req.user!.id, {
            page: page ? parseInt(page, 10) : undefined,
            limit: limit ? parseInt(limit, 10) : undefined,
            status,
            platform,
            search,
        });

        res.json(result);
    } catch (err) {
        next(err);
    }
}

export async function getPost(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    try {
        const post = await postsService.getPost(req.params.id, req.user!.id);
        res.json(post);
    } catch (err) {
        next(err);
    }
}

export async function publishPost(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    try {
        const result = await postsService.publishPost(req.params.id, req.user!.id);
        res.json(result);
    } catch (err) {
        next(err);
    }
}

export async function getPostStatus(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    try {
        const status = await postsService.getPostStatus(req.params.id, req.user!.id);
        res.json(status);
    } catch (err) {
        next(err);
    }
}

export async function retryPlatform(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    try {
        const platform = parsePlatform(req.params.platform);
        const result = await postsService.retryPlatform(
            req.params.id,
            req.user!.id,
            platform
        );
        res.json(result);
    } catch (err) {
        next(err);
    }
}

export async function deletePost(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    try {
        const result = await postsService.deletePost(req.params.id, req.user!.id);
        res.json(result);
    } catch (err) {
        next(err);
    }
}

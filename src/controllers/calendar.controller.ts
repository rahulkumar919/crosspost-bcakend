import { Request, Response, NextFunction } from "express";
import * as calendarService from "../services/calendar.service";
import type { Platform, MediaType } from "@prisma/client";

export async function getEvents(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    try {
        const { start, end, platform, status } = req.query as {
            start?: string;
            end?: string;
            platform?: string;
            status?: string;
        };

        const events = await calendarService.getCalendarEvents(req.user!.id, {
            start,
            end,
            platform,
            status,
        });

        res.json({ events });
    } catch (err) {
        next(err);
    }
}

export async function getUpcoming(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    try {
        const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 15;
        const upcoming = await calendarService.getUpcomingPosts(req.user!.id, limit);
        res.json({ upcoming });
    } catch (err) {
        next(err);
    }
}

export async function schedulePost(
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
            scheduledAt,
            targets,
        } = req.body as {
            mediaUrl: string;
            mediaType: string;
            cloudinaryId: string;
            rawCaption?: string;
            aiTitle?: string;
            aiDescription?: string;
            aiHashtags?: string[];
            scheduledAt: string;
            targets: {
                platform: Platform;
                finalTitle?: string;
                finalDescription?: string;
                finalHashtags?: string[];
                scheduledAt?: string;
            }[];
        };

        const post = await calendarService.schedulePost({
            userId: req.user!.id,
            mediaUrl,
            mediaType: mediaType.toUpperCase() as MediaType,
            cloudinaryId,
            rawCaption,
            aiTitle,
            aiDescription,
            aiHashtags,
            scheduledAt,
            targets,
        });

        res.status(201).json(post);
    } catch (err) {
        next(err);
    }
}

export async function updateSchedule(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    try {
        const updated = await calendarService.updateSchedule(
            req.user!.id,
            req.params.id,
            req.body
        );
        res.json(updated);
    } catch (err) {
        next(err);
    }
}

export async function cancelSchedule(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    try {
        const result = await calendarService.cancelSchedule(
            req.user!.id,
            req.params.id
        );
        res.json(result);
    } catch (err) {
        next(err);
    }
}

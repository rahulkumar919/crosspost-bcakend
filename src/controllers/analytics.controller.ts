import { Request, Response, NextFunction } from "express";
import * as analyticsService from "../services/analytics.service";

export async function getOverview(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    try {
        const userId = req.user!.id;
        const range = (req.query.range as string) || "30d";
        const data = await analyticsService.getOverview(userId, range);
        res.json(data);
    } catch (err) {
        next(err);
    }
}

export async function getPosts(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    try {
        const userId = req.user!.id;
        const range = (req.query.range as string) || "all";
        const data = await analyticsService.getPostAnalytics(userId, range);
        res.json(data);
    } catch (err) {
        next(err);
    }
}

export async function syncData(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    try {
        const userId = req.user!.id;
        const range = (req.query.range as string) || "30d";
        const data = await analyticsService.getOverview(userId, range);
        res.json({ success: true, message: "Analytics synced successfully", data });
    } catch (err) {
        next(err);
    }
}

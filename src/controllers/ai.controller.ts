import { Request, Response, NextFunction } from "express";
import * as aiService from "../services/ai.service";

export async function generate(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    try {
        const { rawCaption, mediaType, platforms } = req.body as {
            rawCaption: string;
            mediaType: string;
            platforms: string[];
        };
        const result = await aiService.generateContent(rawCaption, mediaType, platforms);
        res.json(result);
    } catch (err) {
        next(err);
    }
}

export async function enhance(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    try {
        const { title, description, hashtags, platforms } = req.body as {
            title: string;
            description: string;
            hashtags: string[];
            platforms: string[];
        };
        const result = await aiService.enhanceContent(title, description, hashtags, platforms);
        res.json(result);
    } catch (err) {
        next(err);
    }
}

import { Request, Response, NextFunction } from "express";
import * as mediaService from "../services/media.service";

export async function upload(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    try {
        if (!req.file) {
            res.status(400).json({ error: "No file uploaded." });
            return;
        }

        const result = await mediaService.uploadMedia(
            req.file.buffer,
            req.file.mimetype,
            req.file.originalname
        );

        res.status(201).json(result);
    } catch (err) {
        next(err);
    }
}

import { Request, Response, NextFunction } from "express";
import { validationResult } from "express-validator";

/**
 * Run after express-validator chains.
 * Returns 422 with all field errors if any validation failed.
 */
export function validateRequest(req: Request, res: Response, next: NextFunction): void {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        res.status(422).json({
            error: "Validation failed",
            details: errors.array().map((e) => ({
                field: e.type === "field" ? e.path : undefined,
                message: e.msg,
            })),
        });
        return;
    }
    next();
}

import { Router } from "express";
import { body } from "express-validator";
import { requireAuth } from "../middleware/auth.middleware";
import { aiLimiter } from "../middleware/rate-limit.middleware";
import { validateRequest } from "../middleware/validate.middleware";
import * as aiController from "../controllers/ai.controller";

const router = Router();

// POST /ai/generate
router.post(
    "/generate",
    requireAuth,
    aiLimiter,
    [
        body("rawCaption").optional().isString().trim().isLength({ max: 500 }),
        body("mediaType").isIn(["video", "image"]).withMessage("mediaType must be 'video' or 'image'"),
        body("platforms")
            .isArray({ min: 1 })
            .withMessage("platforms must be a non-empty array"),
        body("platforms.*")
            .isIn(["youtube", "instagram", "linkedin"])
            .withMessage("Invalid platform"),
    ],
    validateRequest,
    aiController.generate
);

// POST /ai/enhance
router.post(
    "/enhance",
    requireAuth,
    aiLimiter,
    [
        body("title").isString().trim().isLength({ min: 1, max: 200 }).withMessage("title required"),
        body("description").isString().trim().isLength({ min: 1, max: 5000 }).withMessage("description required"),
        body("hashtags").isArray().withMessage("hashtags must be an array"),
        body("hashtags.*").isString().trim(),
        body("platforms").isArray({ min: 1 }).withMessage("platforms must be a non-empty array"),
        body("platforms.*").isIn(["youtube", "instagram", "linkedin"]),
    ],
    validateRequest,
    aiController.enhance
);

export default router;

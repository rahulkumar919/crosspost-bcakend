import { Router } from "express";
import { body, query } from "express-validator";
import { requireAuth } from "../middleware/auth.middleware";
import { validateRequest } from "../middleware/validate.middleware";
import * as postsController from "../controllers/posts.controller";

const router = Router();

// GET /posts — list all posts for user (with pagination + filter)
router.get(
    "/",
    requireAuth,
    [
        query("page").optional().isInt({ min: 1 }),
        query("limit").optional().isInt({ min: 1, max: 100 }),
        query("status").optional().isString(),
        query("platform").optional().isString(),
        query("search").optional().isString().trim(),
    ],
    validateRequest,
    postsController.listPosts
);

// POST /posts — create a new draft post
router.post(
    "/",
    requireAuth,
    [
        body("mediaUrl").isURL().withMessage("mediaUrl must be a valid URL"),
        body("mediaType")
            .isIn(["video", "image", "VIDEO", "IMAGE"])
            .withMessage("mediaType must be 'video' or 'image'"),
        body("cloudinaryId").isString().trim().notEmpty(),
        body("rawCaption").optional().isString().trim().isLength({ max: 500 }),
        body("aiTitle").optional().isString().trim().isLength({ max: 200 }),
        body("aiDescription").optional().isString().trim().isLength({ max: 5000 }),
        body("aiHashtags").optional().isArray(),
        body("targets").isArray({ min: 1 }).withMessage("At least one target required"),
        body("targets.*.platform")
            .isIn(["YOUTUBE", "INSTAGRAM", "LINKEDIN"])
            .withMessage("Invalid platform"),
        body("targets.*.finalTitle").optional().isString().trim(),
        body("targets.*.finalDescription").optional().isString().trim(),
        body("targets.*.finalHashtags").optional().isArray(),
    ],
    validateRequest,
    postsController.createPost
);

// GET /posts/:id — get post with all targets
router.get("/:id", requireAuth, postsController.getPost);

// POST /posts/:id/publish — trigger publishing (enqueues BullMQ jobs)
router.post("/:id/publish", requireAuth, postsController.publishPost);

// GET /posts/:id/status — lightweight status poll (frontend polls this)
router.get("/:id/status", requireAuth, postsController.getPostStatus);

// POST /posts/:id/retry/:platform — retry a single failed platform
router.post("/:id/retry/:platform", requireAuth, postsController.retryPlatform);

// DELETE /posts/:id — delete a post
router.delete("/:id", requireAuth, postsController.deletePost);

export default router;

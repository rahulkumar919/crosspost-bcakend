import { Router } from "express";
import { body, query } from "express-validator";
import { requireAuth } from "../middleware/auth.middleware";
import { validateRequest } from "../middleware/validate.middleware";
import * as calendarController from "../controllers/calendar.controller";

const router = Router();

// GET /calendar/events — fetch calendar events
router.get(
    "/events",
    requireAuth,
    [
        query("start").optional().isISO8601(),
        query("end").optional().isISO8601(),
        query("platform").optional().isString(),
        query("status").optional().isString(),
    ],
    validateRequest,
    calendarController.getEvents
);

// GET /calendar/upcoming — fetch upcoming scheduled posts
router.get("/upcoming", requireAuth, calendarController.getUpcoming);

// POST /calendar/schedule — schedule a new post
router.post(
    "/schedule",
    requireAuth,
    [
        body("mediaUrl").isURL().withMessage("Valid mediaUrl required"),
        body("mediaType").isIn(["video", "image", "VIDEO", "IMAGE"]).withMessage("mediaType must be video or image"),
        body("cloudinaryId").isString().notEmpty(),
        body("scheduledAt").isISO8601().withMessage("Valid scheduledAt date required"),
        body("targets").isArray({ min: 1 }).withMessage("At least one target platform required"),
    ],
    validateRequest,
    calendarController.schedulePost
);

// PATCH /calendar/schedule/:id — update/reschedule
router.patch("/schedule/:id", requireAuth, calendarController.updateSchedule);

// DELETE /calendar/schedule/:id — cancel scheduled post
router.delete("/schedule/:id", requireAuth, calendarController.cancelSchedule);

export default router;

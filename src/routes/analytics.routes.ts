import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import * as analyticsController from "../controllers/analytics.controller";

const router = Router();

// GET /analytics/overview?range=7d|30d|90d|all
router.get("/overview", requireAuth, analyticsController.getOverview);

// GET /analytics/posts?range=7d|30d|90d|all
router.get("/posts", requireAuth, analyticsController.getPosts);

// POST /analytics/sync — trigger manual refresh
router.post("/sync", requireAuth, analyticsController.syncData);

export default router;

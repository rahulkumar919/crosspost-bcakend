import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import * as accountsController from "../controllers/accounts.controller";

const router = Router();

// GET  /accounts  — list all connected platforms for the authenticated user
router.get("/", requireAuth, accountsController.getAccounts);

// GET  /accounts/connect/:platform  — redirects user to platform OAuth screen
// Note: requireAuth reads from the Authorization header — the redirect must
// include the JWT (the frontend appends it as ?token= or the user is already
// authenticated and the middleware reads a cookie-based token).
// For OAuth flows the simplest approach is the frontend sends the user to this
// endpoint with the Bearer token in the Authorization header via a fetch + then
// window.location.href = redirectUrl approach — see accounts.service.getOAuthRedirectUrl
router.get("/connect/:platform", requireAuth, accountsController.connectPlatform);

// GET  /accounts/callback/:platform  — OAuth redirect target (called by the platform)
// No auth middleware here — the state token in Redis is the CSRF protection
router.get("/callback/:platform", accountsController.oauthCallback);

// DELETE /accounts/:platform  — disconnect and delete a connected account
router.delete("/:platform", requireAuth, accountsController.disconnectAccount);

export default router;

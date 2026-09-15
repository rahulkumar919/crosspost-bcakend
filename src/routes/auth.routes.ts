import { Router } from "express";
import { body } from "express-validator";
import { validateRequest } from "../middleware/validate.middleware";
import { authLimiter } from "../middleware/rate-limit.middleware";
import { requireAuth } from "../middleware/auth.middleware";
import * as authController from "../controllers/auth.controller";

const router = Router();

// ── Google OAuth upsert — finds or creates user, always returns a JWT ────────
router.post(
    "/google",
    authLimiter,
    [
        body("email").isEmail().normalizeEmail().withMessage("Valid email required"),
        body("name").optional().trim().isLength({ max: 100 }),
    ],
    validateRequest,
    authController.googleUpsert
);

// ── Signup (kept for Google OAuth backend user creation) ─────────────────────
router.post(
    "/signup",
    authLimiter,
    [
        body("email").isEmail().normalizeEmail().withMessage("Valid email required"),
        body("password").isLength({ min: 8 }).withMessage("Password must be at least 8 characters"),
        body("name").optional().trim().isLength({ max: 100 }),
    ],
    validateRequest,
    authController.signup
);

// ── Direct login (used internally by Google OAuth bridge) ─────────────────────
router.post(
    "/login",
    authLimiter,
    [
        body("email").isEmail().normalizeEmail().withMessage("Valid email required"),
        body("password").notEmpty().withMessage("Password required"),
    ],
    validateRequest,
    authController.login
);

// ── OTP flow ─────────────────────────────────────────────────────────────────
// Step 1: validate credentials → send OTP to email
router.post(
    "/send-otp",
    authLimiter,
    [
        body("email").isEmail().normalizeEmail().withMessage("Valid email required"),
        body("password").notEmpty().withMessage("Password required"),
    ],
    validateRequest,
    authController.sendOtp
);

// Step 2: verify OTP → return JWT
router.post(
    "/verify-otp",
    authLimiter,
    [
        body("email").isEmail().normalizeEmail().withMessage("Valid email required"),
        body("otp")
            .isLength({ min: 6, max: 6 })
            .isNumeric()
            .withMessage("OTP must be a 6-digit number"),
    ],
    validateRequest,
    authController.verifyOtp
);

// ── Protected ────────────────────────────────────────────────────────────────
router.get("/me", requireAuth, authController.me);

export default router;

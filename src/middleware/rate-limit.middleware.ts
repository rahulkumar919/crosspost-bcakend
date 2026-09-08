import rateLimit from "express-rate-limit";

/** General API rate limit — 100 requests per minute per IP */
export const generalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." },
});

/** Strict limit for AI endpoints — 10 requests per minute per IP */
export const aiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "AI rate limit reached. Please wait before generating again." },
    keyGenerator: (req) =>
        // Prefer per-user limiting when authenticated, fall back to IP
        (req.user?.id ?? req.ip) as string,
});

/** Auth endpoints — 20 attempts per 15 minutes per IP */
export const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many auth attempts, please try again later." },
});

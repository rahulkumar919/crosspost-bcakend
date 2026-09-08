import express from "express";
import helmet from "helmet";
import cors from "cors";
import { env } from "./config/env";
import { generalLimiter } from "./middleware/rate-limit.middleware";
import { errorHandler } from "./middleware/error-handler.middleware";
import { logger } from "./lib/logger";

// Route imports
import authRoutes from "./routes/auth.routes";
import accountsRoutes from "./routes/accounts.routes";
import mediaRoutes from "./routes/media.routes";
import aiRoutes from "./routes/ai.routes";
import postsRoutes from "./routes/posts.routes";
import analyticsRoutes from "./routes/analytics.routes";
import calendarRoutes from "./routes/calendar.routes";
import healthRoutes from "./routes/health.routes";

const app = express();

// ─── Security headers ────────────────────────────────────────────────────────
app.use(helmet());

// ─── CORS ────────────────────────────────────────────────────────────────────
app.use(
    cors({
        origin: env.FRONTEND_URL,
        credentials: true,
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    })
);

// ─── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// ─── Global rate limit ────────────────────────────────────────────────────────
app.use(generalLimiter);

// ─── Request logging (dev) ────────────────────────────────────────────────────
if (env.NODE_ENV === "development") {
    app.use((req, _res, next) => {
        logger.debug(`${req.method} ${req.path}`);
        next();
    });
}

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use("/health", healthRoutes);
app.use("/auth", authRoutes);
app.use("/accounts", accountsRoutes);
app.use("/media", mediaRoutes);
app.use("/ai", aiRoutes);
app.use("/posts", postsRoutes);
app.use("/analytics", analyticsRoutes);
app.use("/calendar", calendarRoutes);

// ─── 404 ─────────────────────────────────────────────────────────────────────
app.use((_req, res) => {
    res.status(404).json({ error: "Route not found" });
});

// ─── Global error handler (must be last) ─────────────────────────────────────
app.use(errorHandler);

export default app;

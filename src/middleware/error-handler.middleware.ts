import { Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger";
import { OllamaError } from "../lib/ollama-client";
import { AIProviderError } from "../ai-providers/AIError";

/** Shape of every error response sent to the client */
interface ErrorResponse {
    error: string;
    code?: string;
}

/**
 * Global error handler — must be registered LAST in app.ts.
 * Never leaks stack traces, raw provider errors, or token values.
 */
export function errorHandler(
    err: unknown,
    req: Request,
    res: Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _next: NextFunction
): void {
    // Log full detail server-side only
    logger.error("Unhandled error", {
        path: req.path,
        method: req.method,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
    });

    // Map known error types to clean client responses
    if (err instanceof OllamaError) {
        const statusMap: Record<OllamaError["kind"], number> = {
            UNREACHABLE: 503,
            TIMEOUT: 504,
            INVALID_JSON: 502,
            MODEL_ERROR: 502,
        };
        const messageMap: Record<OllamaError["kind"], string> = {
            UNREACHABLE: "AI service is currently unavailable.",
            TIMEOUT: "AI generation timed out. Please try again.",
            INVALID_JSON: "AI returned an unexpected response. Please try again.",
            MODEL_ERROR: "AI model error. Please try again.",
        };
        res.status(statusMap[err.kind]).json({
            error: messageMap[err.kind],
            code: `AI_${err.kind}`,
        } satisfies ErrorResponse);
        return;
    }

    // AIProviderError (Gemini / Mistral failures)
    if (err instanceof AIProviderError) {
        const statusMap: Record<AIProviderError["kind"], number> = {
            UNREACHABLE: 503,
            TIMEOUT: 504,
            INVALID_JSON: 502,
            MODEL_ERROR: 502,
        };
        const messageMap: Record<AIProviderError["kind"], string> = {
            UNREACHABLE: "AI service is currently unavailable. Please try again later.",
            TIMEOUT: "AI generation timed out. Please try again.",
            INVALID_JSON: "AI returned an unexpected response. Please try again.",
            MODEL_ERROR: "AI model error. Please try again.",
        };
        res.status(statusMap[err.kind]).json({
            error: messageMap[err.kind],
            code: `AI_${err.kind}`,
        } satisfies ErrorResponse);
        return;
    }

    if (err instanceof AppError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code } satisfies ErrorResponse);
        return;
    }

    // Axios errors from platform adapters (YouTube, Instagram, LinkedIn)
    if (typeof err === "object" && err !== null && "isAxiosError" in err) {
        const axErr = err as { response?: { status?: number; data?: { error?: { message?: string } } }; message?: string };
        const status = axErr.response?.status;
        if (status === 401 || status === 403) {
            res.status(401).json({ error: "Platform account authentication failed. Please reconnect your account.", code: "PLATFORM_AUTH_FAILED" });
            return;
        }
        if (status === 429) {
            res.status(429).json({ error: "Platform rate limit reached. Please try again later.", code: "RATE_LIMITED" });
            return;
        }
        if (status && status >= 500) {
            res.status(502).json({ error: "Platform service is temporarily unavailable. Please try again.", code: "PLATFORM_UNAVAILABLE" });
            return;
        }
    }

    // Prisma known error codes
    if (isKnownPrismaError(err)) {
        if (err.code === "P2002") {
            res.status(409).json({ error: "A record with this value already exists." });
            return;
        }
        if (err.code === "P2025") {
            res.status(404).json({ error: "Record not found." });
            return;
        }
    }

    // Fallback — generic 500, no internal detail exposed
    res.status(500).json({ error: "An unexpected error occurred. Please try again." });
}

/** Application-level errors with a known status code */
export class AppError extends Error {
    constructor(
        message: string,
        public readonly statusCode: number = 500,
        public readonly code?: string
    ) {
        super(message);
        this.name = "AppError";
    }
}

function isKnownPrismaError(err: unknown): err is { code: string } {
    return (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        typeof (err as { code: unknown }).code === "string"
    );
}

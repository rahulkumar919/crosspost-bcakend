import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ override: true });

const envSchema = z.object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().default(4000),
    FRONTEND_URL: z.string().url(),

    // JWT
    JWT_SECRET: z.string().min(32),
    JWT_EXPIRES_IN: z.string().default("7d"),

    // Encryption
    ENCRYPTION_KEY: z.string().length(64, "ENCRYPTION_KEY must be 64 hex chars (32 bytes)"),

    // Database
    DATABASE_URL: z.string().url(),

    // Redis — no longer required (replaced by in-memory store)
    // These vars are kept optional so existing .env files don't break
    UPSTASH_REDIS_URL: z.string().optional().default(""),
    UPSTASH_REDIS_TOKEN: z.string().optional().default(""),

    // Cloudinary
    CLOUDINARY_CLOUD_NAME: z.string().min(1),
    CLOUDINARY_API_KEY: z.string().min(1),
    CLOUDINARY_API_SECRET: z.string().min(1),

    // AI Provider — switch between local Ollama and hosted Gemini
    AI_PROVIDER: z.enum(["ollama", "gemini"]).default("ollama"),
    GEMINI_API_KEY: z.string().default(""),
    GEMINI_MODEL: z.string().default("gemini-1.5-flash"),

    // Ollama — optional, gracefully degraded if not running
    OLLAMA_BASE_URL: z.string().url().default("http://localhost:11434"),
    OLLAMA_MODEL: z.string().default("llama3.2:latest"),
    OLLAMA_TIMEOUT_MS: z.coerce.number().default(45000),

    // YouTube — optional (platform won't work without it, but server still starts)
    YOUTUBE_CLIENT_ID: z.string().default(""),
    YOUTUBE_CLIENT_SECRET: z.string().default(""),
    YOUTUBE_REDIRECT_URI: z.string().default("http://localhost:4000/accounts/callback/youtube"),

    // Instagram — optional
    INSTAGRAM_APP_ID: z.string().default(""),
    INSTAGRAM_CLIENT_ID: z.string().default(""),
    INSTAGRAM_CLIENT_SECRET: z.string().default(""),
    INSTAGRAM_REDIRECT_URI: z.string().default("http://localhost:4000/accounts/callback/instagram"),

    // LinkedIn — optional
    LINKEDIN_CLIENT_ID: z.string().default(""),
    LINKEDIN_CLIENT_SECRET: z.string().default(""),
    LINKEDIN_REDIRECT_URI: z.string().default("http://localhost:4000/accounts/callback/linkedin"),
    LINKEDIN_VERSION: z.string().default("202608"),

    // Email / OTP (Nodemailer via Gmail)
    SMTP_USER: z.string().default(""),
    SMTP_PASS: z.string().default(""),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
    console.error("❌  Invalid environment variables:\n", parsed.error.flatten().fieldErrors);
    process.exit(1);
}

export const env = parsed.data;

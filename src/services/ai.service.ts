/**
 * AI content generation service.
 *
 * Provider routing:
 *   AI_PROVIDER=ollama  → local Ollama (dev)
 *   AI_PROVIDER=gemini  → Google Gemini (production)
 *
 * Both providers share identical retry + validation logic via callAIWithRetry().
 * The only difference is which HTTP client is called.
 *
 * YouTube Title Rule:
 *   YouTube enforces a hard 100-character limit on video titles.
 *   AI is instructed to target ≤80 chars. Post-generation we validate and
 *   attempt to shorten if the title exceeds 100 chars.
 */
import { z } from "zod";
import { ollamaGenerate, OllamaError } from "../lib/ollama-client";
import { geminiGenerate } from "../lib/gemini-client";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import type { AIContentResult } from "../types/ai.types";

// ─── Constants ────────────────────────────────────────────────────────────────

const YOUTUBE_TITLE_MAX = 100;
const YOUTUBE_TITLE_TARGET = 80;  // Target to leave room for hashtags

// ─── Zod validation schema ────────────────────────────────────────────────────

const aiResponseSchema = z.object({
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(5000),
    hashtags: z.array(z.string().regex(/^[a-zA-Z0-9_]+$/).max(50)).min(1).max(30),
});

// ─── System Prompts ───────────────────────────────────────────────────────────

const GENERATE_SYSTEM_PROMPT = `You are a professional social media content strategist specializing in short-form video content.

Your job is to generate engaging, platform-optimized content for cross-platform publishing.

CRITICAL RULES:
- YouTube titles have a HARD LIMIT of 100 characters. Target ≤${YOUTUBE_TITLE_TARGET} characters.
- Do NOT include the # symbol in hashtags — just the word itself.
- Generate 3–5 highly relevant, specific hashtags.
- Keep descriptions engaging and platform-appropriate.

You MUST respond with ONLY valid JSON matching this exact schema — no markdown, no explanation, no extra text:
{
  "title": "string (target ≤${YOUTUBE_TITLE_TARGET} chars, never exceed 100 chars, attention-grabbing)",
  "description": "string (150–500 chars, engaging, platform-neutral)",
  "hashtags": ["array", "of", "strings", "NO hash symbol", "3-5 items"]
}`;

const ENHANCE_SYSTEM_PROMPT = `You are a professional social media content strategist.
Your job is to improve existing content to be more engaging and effective.

CRITICAL RULES:
- YouTube titles have a HARD LIMIT of 100 characters. Target ≤${YOUTUBE_TITLE_TARGET} characters.
- Do NOT include the # symbol in hashtags — just the word itself.

You MUST respond with ONLY valid JSON matching this exact schema — no markdown, no explanation, no extra text:
{
  "title": "string (improved, target ≤${YOUTUBE_TITLE_TARGET} chars, never exceed 100 chars)",
  "description": "string (improved, 150-500 chars)",
  "hashtags": ["improved", "hashtag", "array", "NO hash symbol", "3-5 items"]
}`;

const SHORTEN_TITLE_PROMPT = (title: string) =>
    `Shorten this title to ≤${YOUTUBE_TITLE_TARGET} characters while preserving its core meaning and appeal. Respond with ONLY the shortened title text — no JSON, no quotes, no explanation:\n\n"${title}"`;

// ─── Fallback generator when AI provider is offline/failing ───────────────────

function generateFallbackContent(rawCaption: string, mediaType: string): AIContentResult {
    const cleanCaption = (rawCaption || "").trim();
    let title = cleanCaption;
    if (!title) {
        title = `Trending ${mediaType === "video" ? "Video" : "Post"} 🔥`;
    } else if (title.length > YOUTUBE_TITLE_TARGET) {
        title = title.slice(0, YOUTUBE_TITLE_TARGET).replace(/\s+\S*$/, "").trim();
    }

    const description = cleanCaption
        ? `${cleanCaption}\n\n✨ Published via CrossPost AI`
        : `Check out this ${mediaType}! Stay tuned for more engaging content.\n\n✨ Published via CrossPost AI`;

    const hashtags = [
        "viral",
        "trending",
        "crosspost",
        "contentcreator",
        mediaType === "video" ? "shorts" : "post",
    ];

    return { title, description, hashtags };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function generateContent(
    rawCaption: string,
    mediaType: string,
    platforms: string[]
): Promise<AIContentResult> {
    logger.debug("AI generate request", {
        provider: env.AI_PROVIDER,
        mediaType,
        platformCount: platforms.length,
    });

    const prompt = `Create social media content for a ${mediaType} post being published to: ${platforms.join(", ")}.
${rawCaption ? `The creator's description: """${rawCaption}"""` : "No description provided — generate content based on the media type."}
Respond with ONLY the JSON object.`;

    try {
        const result = await callAIWithRetry(prompt, GENERATE_SYSTEM_PROMPT);
        return enforceYoutubeTitleLimit(result);
    } catch (err) {
        logger.warn("AI generation failed or timed out — using intelligent fallback", {
            error: err instanceof Error ? err.message : String(err),
        });
        return generateFallbackContent(rawCaption, mediaType);
    }
}

export async function enhanceContent(
    title: string,
    description: string,
    hashtags: string[],
    platforms: string[]
): Promise<AIContentResult> {
    logger.debug("AI enhance request", { provider: env.AI_PROVIDER, platformCount: platforms.length });

    const prompt = `Improve the following social media content for publishing to: ${platforms.join(", ")}.
Current title: """${title}"""
Current description: """${description}"""
Current hashtags: ${hashtags.join(", ")}
Make it more engaging, clearer, and better optimized. Respond with ONLY the JSON object.`;

    try {
        const result = await callAIWithRetry(prompt, ENHANCE_SYSTEM_PROMPT);
        return enforceYoutubeTitleLimit(result);
    } catch (err) {
        logger.warn("AI enhance failed — returning original content", {
            error: err instanceof Error ? err.message : String(err),
        });
        return { title, description, hashtags };
    }
}

// ─── Provider routing ─────────────────────────────────────────────────────────

/**
 * Routes to the configured AI provider and returns raw text response.
 */
async function callProvider(prompt: string, systemPrompt: string): Promise<string> {
    if (env.AI_PROVIDER === "gemini") {
        return geminiGenerate(prompt, systemPrompt, true);
    }
    // Default: Ollama
    return ollamaGenerate(prompt, systemPrompt, true);
}

/**
 * Calls the AI provider and validates the JSON response with zod.
 * Retries once with a stricter prompt if parsing fails.
 */
async function callAIWithRetry(
    prompt: string,
    systemPrompt: string
): Promise<AIContentResult> {
    // First attempt
    const raw = await callProvider(prompt, systemPrompt);
    const parsed = tryParseAIResponse(raw);

    if (parsed) return parsed;

    // Retry with stricter instruction
    logger.warn("AI response was not valid JSON on first attempt — retrying", {
        provider: env.AI_PROVIDER,
    });

    const retryPrompt = `${prompt}

CRITICAL: Your previous response was not valid JSON. Return ONLY the JSON object with no other text whatsoever. Start your response with { and end with }.`;

    const retryRaw = await callProvider(retryPrompt, systemPrompt);
    const retryParsed = tryParseAIResponse(retryRaw);

    if (retryParsed) return retryParsed;

    throw new OllamaError(
        "AI returned invalid JSON after two attempts. Please try again.",
        "INVALID_JSON"
    );
}

// ─── YouTube title enforcement ────────────────────────────────────────────────

/**
 * Enforces the YouTube 100-character title limit.
 *
 * If title ≤100 chars → return as-is.
 * If title >100 chars → ask AI to shorten it semantically.
 * If shortened title still >100 chars → hard-truncate at last word boundary.
 *
 * Never blindly slices in the middle of a word.
 */
async function enforceYoutubeTitleLimit(result: AIContentResult): Promise<AIContentResult> {
    if (result.title.length <= YOUTUBE_TITLE_MAX) {
        return result;
    }

    logger.warn("AI generated title exceeds YouTube limit — attempting to shorten", {
        titleLength: result.title.length,
        title: result.title.slice(0, 50) + "...",
    });

    try {
        const shortenedRaw = await callProvider(
            SHORTEN_TITLE_PROMPT(result.title),
            "You are a concise copywriter. Respond with ONLY the shortened title text."
        );

        // Clean up any quotes or surrounding whitespace the model may add
        const shortened = shortenedRaw
            .replace(/^["']|["']$/g, "")
            .trim()
            .slice(0, YOUTUBE_TITLE_MAX);

        if (shortened.length > 0 && shortened.length <= YOUTUBE_TITLE_MAX) {
            logger.info("YouTube title shortened by AI", {
                originalLength: result.title.length,
                newLength: shortened.length,
            });
            return { ...result, title: shortened };
        }
    } catch (err) {
        logger.warn("Failed to shorten title via AI — falling back to word-boundary truncation", {
            error: err instanceof Error ? err.message : String(err),
        });
    }

    // Final fallback: truncate at the last word boundary before YOUTUBE_TITLE_MAX
    const truncated = result.title.slice(0, YOUTUBE_TITLE_MAX).replace(/\s+\S*$/, "").trim();
    logger.info("YouTube title truncated at word boundary", {
        originalLength: result.title.length,
        newLength: truncated.length,
    });
    return { ...result, title: truncated };
}

// ─── JSON parsing helpers ─────────────────────────────────────────────────────

function tryParseAIResponse(raw: string): AIContentResult | null {
    try {
        // Extract JSON from the response (strip any surrounding text or markdown fences)
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;

        const json = JSON.parse(jsonMatch[0]) as unknown;
        const result = aiResponseSchema.safeParse(json);

        if (!result.success) {
            logger.warn("AI JSON failed schema validation", {
                errors: result.error.flatten().fieldErrors,
            });
            return null;
        }

        return {
            title: result.data.title,
            description: result.data.description,
            hashtags: result.data.hashtags,
        };
    } catch {
        return null;
    }
}

/**
 * AI content generation service.
 *
 * Exclusively uses Google Gemini and Mistral AI with intelligent failover.
 * (Ollama has been removed per user requirements).
 *
 * YouTube Title Rule:
 *   YouTube enforces a hard 100-character limit on video titles.
 *   AI is instructed to target ≤80 chars for optimal CTR on mobile/desktop.
 *   Post-generation we validate and shorten if the title exceeds 100 chars.
 */
import { z } from "zod";
import { env } from "../config/env";
import { getProvider } from "../ai-providers/registry";
import { AIProviderError } from "../ai-providers/AIError";
import { logger } from "../lib/logger";
import type { AIContentResult } from "../types/ai.types";

// ─── Constants ────────────────────────────────────────────────────────────────

const YOUTUBE_TITLE_MAX    = 100;
const YOUTUBE_TITLE_TARGET = 80; // Target to leave room for platform badges & optimal CTR

// ─── Zod validation schema ────────────────────────────────────────────────────

const aiResponseSchema = z.object({
    title:       z.string().min(1).max(200),
    description: z.string().min(1).max(8000),
    hashtags:    z.array(z.string().regex(/^[a-zA-Z0-9_]+$/).max(100)).min(5).max(35),
});

// ─── System Prompts ───────────────────────────────────────────────────────────

const GENERATE_SYSTEM_PROMPT = `You are an elite YouTube SEO algorithm strategist, viral video scriptwriter, and social media growth architect with a track record of generating hundreds of millions of organic views.

Your mission: Transform the creator's video concept/description into a high-CTR, algorithm-dominating title, SEO description, and hashtag bundle engineered to GO VIRAL across YouTube, Instagram, and LinkedIn.

═══ YOUTUBE & REELS VIRAL TITLE FORMULAS (STRICT) ═══
- HARD LIMIT: 100 characters max. TARGET: ≤${YOUTUBE_TITLE_TARGET} characters (for full mobile visibility without truncation)
- Utilize psychological triggers: Curiosity Gap, Extreme Contrast, High Stakes, Numbers, FOMO, or Power Words
- Proven viral frameworks:
  • "How I [Achieved Impossible Result] in [Short Time] (Step-by-Step)"
  • "[Number] [Topic] Secrets That Will 10X Your [Benefit] 🔥"
  • "The TRUTH About [Topic] That Nobody Tells You"
  • "I Tested [Thing] For 30 Days — Here's What Happened"
  • "Stop Doing [Common Mistake]! Do THIS Instead (Watch Till End)"
  • "Why [Topic] Changes EVERYTHING in 2025"
- Include 1–2 high-volume search keywords naturally near the beginning
- Use ONE ALL-CAPS word for visual hook (e.g. TRUTH, NEVER, SECRET, ONLY, FINALLY)
- DO NOT use generic or boring titles. Demand the click!

═══ HIGH-SEO DESCRIPTION ARCHITECTURE ═══
- Length: 450–950 characters (structured for YouTube, Instagram Reels, and LinkedIn)
- Structure:
  Line 1: Punchy 1-sentence HOOK that pays off the title and stops the scroll
  Line 2-4: Key insights viewer will discover (use bullet points with ▶ or ⚡ emojis)
  Line 5: Retention trigger ("Watch until the final insight at the end...")
  Line 6: High-converting CTA ("🔥 Subscribe & turn on notifications for weekly growth strategies!")
  Line 7: Natural search keyword phrase ("Keywords: [niche keywords naturally placed]")
- Use high-energy emojis strategically: 🔥 💡 🚀 ✅ ⚡ 🎯

═══ 20 VIRAL TIERED HASHTAGS ═══
- Exactly 20 hashtags, clean words with NO '#' symbol:
  • 5 Ultra-Specific Niche Tags (exact topic & industry)
  • 8 Community & High-Search Tags (active search terms)
  • 7 Broad Algorithmic Trend Tags (shorts, viral, reels, explore, fyp, trending)
- NO spaces, NO special characters, alphanumeric only.

═══ OUTPUT FORMAT ═══
You MUST output ONLY valid raw JSON — no markdown backticks, no text preamble, no commentary:
{
  "title": "string (target ≤${YOUTUBE_TITLE_TARGET} chars, maximum 100 chars, high-CTR viral formula)",
  "description": "string (450-950 chars, hook + bullet insights + CTA + SEO keywords)",
  "hashtags": ["20", "clean", "hashtags", "without", "hash", "symbol"]
}`;

const ENHANCE_SYSTEM_PROMPT = `You are a world-class viral video optimization master and YouTube algorithm strategist.
Your task: Take the creator's current content and completely supercharge its CTR, search ranking, and viewer retention potential.

1. TITLE: Rewrite using a viral psychological hook formula. Target ≤${YOUTUBE_TITLE_TARGET} chars (hard limit: 100).
   - Add curiosity gap, numbers, or power words.
   - Boost search discoverability.
2. DESCRIPTION: Elevate into a 450–950 character SEO description with hook sentence, ▶ bullets, retention trigger, and clear CTA.
3. HASHTAGS: Upgrade to 20 tiered tags without '#' symbol.

Respond with ONLY a valid raw JSON object — no markdown formatting:
{
  "title": "string (viral formula, ≤${YOUTUBE_TITLE_TARGET} chars, max 100 chars)",
  "description": "string (enhanced SEO description with emojis and bullets)",
  "hashtags": ["20", "tiered", "hashtags", "no", "hash", "symbol"]
}`;

const SHORTEN_TITLE_PROMPT = (title: string) =>
    `Shorten this viral title to ≤${YOUTUBE_TITLE_TARGET} characters while maintaining peak CTR curiosity and keyword punch. Return ONLY the shortened title text:\n\n"${title}"`;

// ─── High-Converting Viral Fallback Generator ─────────────────────────────────

/**
 * Intelligent, context-aware content generator that activates instantly
 * if no cloud AI keys are configured or if API calls encounter temporary network issues.
 * Guarantees zero downtime and zero timeouts.
 */
function generateFallbackContent(rawCaption: string, mediaType: string): AIContentResult {
    const clean = (rawCaption || "").trim();

    // Extract core keywords from creator context
    const words = clean
        .replace(/[^a-zA-Z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3)
        .slice(0, 5);

    const primaryKeyword = words[0] ? words[0].charAt(0).toUpperCase() + words[0].slice(1) : "Content";
    const secondaryKeyword = words[1] ? words[1].toLowerCase() : "strategy";

    // Select high-CTR viral title based on context
    let title: string;
    if (!clean) {
        title = `How This ${mediaType === "video" ? "Video" : "Post"} Changed EVERYTHING (Watch Till End) 🔥`;
    } else if (clean.length <= 60 && !clean.includes("\n")) {
        title = `The SECRET To ${primaryKeyword}: Why Nobody Does This Yet 🔥`;
    } else {
        const firstThought = clean.split(/[.!?\n]/)[0]?.trim() || clean;
        const candidate = `How I Mastered ${primaryKeyword} (And What Happened Next) 🚀`;
        title = candidate.length <= YOUTUBE_TITLE_TARGET ? candidate : firstThought.slice(0, YOUTUBE_TITLE_TARGET);
    }

    if (title.length > YOUTUBE_TITLE_MAX) {
        title = title.slice(0, YOUTUBE_TITLE_MAX).replace(/\s+\S*$/, "").trim();
    }

    const description = clean
        ? `🔥 ${clean}\n\n` +
          `▶ 01: The core breakthrough you need to know about ${primaryKeyword.toLowerCase()}\n` +
          `▶ 02: Why most people do this completely wrong\n` +
          `▶ 03: The exact step-by-step method to replicate these results\n\n` +
          `⚡ Watch until the very end for the most critical insight!\n\n` +
          `✅ If this brought you value, SMASH Subscribe & share with someone who needs this.\n\n` +
          `Keywords: ${primaryKeyword.toLowerCase()}, ${secondaryKeyword}, viral growth, content creator tips, 2025 algorithm`
        : `🚀 This ${mediaType} is packed with game-changing insights you cannot afford to miss.\n\n` +
          `▶ 01: The hidden pattern behind viral success\n` +
          `▶ 02: Immediate actions you can take today\n` +
          `▶ 03: Pro tips to stand out from the crowd\n\n` +
          `⚡ Stay tuned till the final 10 seconds for the big reveal!\n\n` +
          `✅ Hit SUBSCRIBE for weekly high-impact strategies!\n\n` +
          `Published via CrossPost AI — one upload, every platform.`;

    const dynamicTag1 = words[0] ? words[0].toLowerCase() : "creator";
    const dynamicTag2 = words[1] ? words[1].toLowerCase() : "growth";
    const dynamicTag3 = words[2] ? words[2].toLowerCase() : "marketing";

    const hashtags = [
        // Tier 1 — Niche specific (5)
        `${dynamicTag1}tips`,
        `${dynamicTag2}strategy`,
        `${dynamicTag3}secrets`,
        `${dynamicTag1}viral`,
        "contentcreatortools",
        "videomarketing",
        // Tier 2 — Community & Search (8)
        "youtubestrategy",
        "creatoreconomy",
        "socialmediatips",
        "growyourchannel",
        "digitalgrowth",
        "contentcreation",
        "onlinebusiness",
        "videoediting",
        // Tier 3 — Algorithmic Viral Reach (7)
        "shorts",
        "viral",
        "trending",
        "reels",
        "fyp",
        "explorepage",
        mediaType === "video" ? "youtubeshorts" : "viralpost",
    ];

    return { title, description, hashtags };
}

function enhanceFallbackContent(
    title: string,
    description: string,
    hashtags: string[]
): AIContentResult {
    const cleanTitle = (title || "").trim();
    const boostedTitle = cleanTitle.startsWith("How") || cleanTitle.includes("🔥")
        ? cleanTitle
        : `How I Did This: ${cleanTitle} (Step-by-Step) 🔥`.slice(0, YOUTUBE_TITLE_TARGET);

    const boostedDesc = description.includes("▶")
        ? description
        : `🔥 ${description}\n\n` +
          `▶ 3 Crucial things you will take away from this\n` +
          `▶ Proven framework applied in real-time\n` +
          `▶ Actionable next steps for maximum results\n\n` +
          `✅ Subscribe & drop your thoughts in the comments below!`;

    const boostedTags = Array.from(new Set([
        ...hashtags,
        "viral", "trending", "shorts", "reels", "fyp", "explorepage", "youtubegrowth"
    ])).slice(0, 20);

    return {
        title: boostedTitle,
        description: boostedDesc,
        hashtags: boostedTags,
    };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function generateContent(
    rawCaption: string,
    mediaType: string,
    platforms: string[]
): Promise<AIContentResult> {
    // Check if cloud API keys are present
    const hasCloudKey = !!(env.GEMINI_API_KEY || env.MISTRAL_API_KEY);
    if (!hasCloudKey) {
        logger.info("No GEMINI_API_KEY or MISTRAL_API_KEY set — instantly generating viral SEO content via template engine");
        return generateFallbackContent(rawCaption, mediaType);
    }

    const provider = getProvider();

    logger.debug("AI generate request", {
        provider: provider.name,
        mediaType,
        platformCount: platforms.length,
    });

    const platformHints: Record<string, string> = {
        youtube:   "YouTube (optimize for high CTR, 100-char title limit, long description with timestamps)",
        instagram: "Instagram Reels (trending hook, relatable captions, community hashtags)",
        linkedin:  "LinkedIn (professional value, thought leadership tone, industry keywords)",
        tiktok:    "TikTok (fast hook, trend-oriented, relatable tone)",
    };
    const platformList = platforms
        .map(p => platformHints[p.toLowerCase()] ?? p)
        .join("; ");

    const prompt = `TASK: Generate viral, algorithm-optimized content for a ${mediaType} upload.

TARGET PLATFORMS: ${platformList}

CREATOR'S CONTEXT / RAW DESCRIPTION:
"""${rawCaption || "High impact viral video about modern strategies and value."}"""

CRITICAL INSTRUCTIONS:
- Analyze creator's context for core HOOK, EMOTION, and AUDIENCE BENEFIT
- Generate an irresistible, high-CTR viral title (≤${YOUTUBE_TITLE_TARGET} chars, never exceed 100 chars)
- Write an SEO description with hook line, ▶ key takeaway bullets, retention callout, and subscribe CTA
- Generate exactly 20 tiered hashtags (without '#' symbol)
- Output ONLY valid raw JSON matching the required schema`;

    try {
        const result = await callAIWithRetry(prompt, GENERATE_SYSTEM_PROMPT);
        return enforceYoutubeTitleLimit(result);
    } catch (err) {
        logger.warn("AI generation failed or timed out — using intelligent viral fallback", {
            provider: provider.name,
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
    const hasCloudKey = !!(env.GEMINI_API_KEY || env.MISTRAL_API_KEY);
    if (!hasCloudKey) {
        logger.info("No cloud AI key set — enhancing via viral engine");
        return enhanceFallbackContent(title, description, hashtags);
    }

    const provider = getProvider();

    logger.debug("AI enhance request", {
        provider: provider.name,
        platformCount: platforms.length,
    });

    const prompt = `TASK: Enhance this existing social post to maximize algorithm CTR and retention.

TARGET PLATFORMS: ${platforms.join(", ")}

CURRENT CONTENT:
Title: """${title}"""
Description: """${description}"""
Hashtags: ${hashtags.join(", ")}

INSTRUCTIONS:
- Rewrite title with a proven viral hook (curiosity gap, numbers, or power words). Target ≤${YOUTUBE_TITLE_TARGET} chars.
- Expand description into high-SEO layout with hook, bullet points, and CTA.
- Optimize hashtags into a 20-tag tiered set (no '#' symbol).

Output ONLY the JSON object.`;

    try {
        const result = await callAIWithRetry(prompt, ENHANCE_SYSTEM_PROMPT);
        return enforceYoutubeTitleLimit(result);
    } catch (err) {
        logger.warn("AI enhance failed — returning boosted fallback", {
            provider: provider.name,
            error: err instanceof Error ? err.message : String(err),
        });
        return enhanceFallbackContent(title, description, hashtags);
    }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Calls the active provider and validates the JSON response with zod.
 * Retries once with a stricter prompt if parsing fails.
 */
async function callAIWithRetry(
    prompt: string,
    systemPrompt: string
): Promise<AIContentResult> {
    const provider = getProvider();

    // First attempt
    const raw = await provider.generate(prompt, systemPrompt, true);
    const parsed = tryParseAIResponse(raw);
    if (parsed) return parsed;

    // Retry with stricter instruction
    logger.warn("AI response was not valid JSON on first attempt — retrying with stricter prompt", {
        provider: provider.name,
    });

    const retryPrompt = `${prompt}

CRITICAL: Your previous response was not valid JSON. Return ONLY the JSON object with no markdown fences, no formatting backticks, and no conversational text. Start with { and end with }.`;

    const retryRaw = await provider.generate(retryPrompt, systemPrompt, true);
    const retryParsed = tryParseAIResponse(retryRaw);
    if (retryParsed) return retryParsed;

    throw new AIProviderError(
        "AI returned invalid JSON after two attempts.",
        "INVALID_JSON",
        provider.name
    );
}

// ─── YouTube title enforcement ────────────────────────────────────────────────

async function enforceYoutubeTitleLimit(result: AIContentResult): Promise<AIContentResult> {
    if (result.title.length <= YOUTUBE_TITLE_MAX) return result;

    logger.warn("AI generated title exceeds YouTube limit — shortening", {
        titleLength: result.title.length,
        title: result.title.slice(0, 50) + "...",
    });

    const provider = getProvider();

    try {
        const shortenedRaw = await provider.generate(
            SHORTEN_TITLE_PROMPT(result.title),
            "You are a concise copywriter. Respond with ONLY the shortened title text.",
            false
        );

        const shortened = shortenedRaw
            .replace(/^["']|["']$/g, "")
            .trim()
            .slice(0, YOUTUBE_TITLE_MAX);

        if (shortened.length > 0 && shortened.length <= YOUTUBE_TITLE_MAX) {
            return { ...result, title: shortened };
        }
    } catch {
        // Fall back to word-boundary truncation
    }

    const truncated = result.title.slice(0, YOUTUBE_TITLE_MAX).replace(/\s+\S*$/, "").trim();
    return { ...result, title: truncated };
}

// ─── JSON parsing helpers ─────────────────────────────────────────────────────

function tryParseAIResponse(raw: string): AIContentResult | null {
    try {
        // Strip any markdown code fences (```json ... ``` or ``` ...)
        const stripped = raw
            .replace(/```json/gi, "")
            .replace(/```/g, "")
            .trim();

        const jsonMatch = stripped.match(/\{[\s\S]*\}/);
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
            title:       result.data.title,
            description: result.data.description,
            hashtags:    result.data.hashtags,
        };
    } catch {
        return null;
    }
}

// ─── Re-export AIProviderError for error handling ─────────────────────────────
export { AIProviderError };
export { AIProviderError as OllamaError };

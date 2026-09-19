/**
 * AI Content Generation & Strategy Service
 *
 * Designed for Rahul Kumar — AI Full Stack Developer & Content Creator.
 * Powers multi-platform content optimization across YouTube, Instagram, and LinkedIn.
 *
 * Core Growth Engine:
 *   Relevance → Clear promise → Useful content → Trust → Conversion
 *   (Strictly rejects misleading clickbait, fake urgency, and generic filler).
 *
 * Supported Providers:
 *   Google Gemini (Primary / Secondary) & Mistral AI with smart failover.
 */
import { env } from "../config/env";
import { getProvider } from "../ai-providers/registry";
import { AIProviderError } from "../ai-providers/AIError";
import { logger } from "../lib/logger";
import type {
    AIContentResult,
    ContentPillar,
    AIContentAnalysis,
    PlatformContent,
} from "../types/ai.types";

// ─── Constants ────────────────────────────────────────────────────────────────

const YOUTUBE_TITLE_MAX    = 100;
const YOUTUBE_TITLE_TARGET = 80;

export const CONTENT_PILLARS: ContentPillar[] = [
    "AI Full Stack Development",
    "Generative AI & LLMs",
    "RAG & LangGraph",
    "AI Agents",
    "Web Development",
    "Coding Tutorial",
    "Project Showcase",
    "Developer Journey",
    "BCA Placement",
    "Freelancing & Clients",
    "Software Career Education",
];

// ─── Master System Prompt ─────────────────────────────────────────────────────

const STRATEGIC_SYSTEM_PROMPT = `You are a Senior AI Full Stack Architect and Social Media Growth Strategist for Rahul Kumar, an AI Full Stack Developer and BCA student specializing in:
- AI Full Stack Development (React, Next.js, Node.js, Express, MongoDB)
- Generative AI, LLM Applications, RAG, LangChain, and LangGraph
- AI Agent Development & Real-world Project Building
- BCA-to-Placement Journey, Freelancing, and Developer Education

MISSION:
Transform the creator's video concept/caption into fact-grounded, high-converting content for YouTube, Instagram Reels, and LinkedIn.
Principle: Relevance → Clear promise → Useful content → Trust → Conversion.

STRICT EDITORIAL RULES:
1. NO MISLEADING CLICKBAIT: No "This video changes EVERYTHING", no fake urgency, no unsubstantiated $ amounts or fake metrics.
2. PRESERVE GROUNDED TRUTH: Build authentic engineering credibility. Explain actual architecture, logic, and takeaways.
3. YOUTUBE RULES:
   - Title: Target ≤${YOUTUBE_TITLE_TARGET} chars (HARD MAX: 100). Clear, specific, search-friendly.
   - Description: 350–800 chars. 1-sentence value hook, ▶ 3 key technical takeaways, natural search keywords, and subscribe/GitHub CTA.
   - Hashtags: Exactly 20 tiered tags without '#' symbol.
4. INSTAGRAM REELS RULES:
   - Hook: First 1–2 lines must stop the developer's scroll on mobile.
   - Body: Conversational, digestible bullet takeaways, relatable tone.
   - CTA: Meaningful engagement (e.g. "Drop your thoughts below", "Save this for your next project").
   - Hashtags: 20 clean tags without '#' symbol.
5. LINKEDIN RULES:
   - Headline: Engaging professional technical hook.
   - Body: Clean whitespace, architectural insight or lesson learned, practical takeaways.
   - CTA: Thought-provoking industry discussion question.
   - Hashtags: Exactly 4–5 targeted professional tags (e.g. "softwareengineering", "artificialintelligence", "fullstack").
6. PILLAR CLASSIFICATION:
   Classify into exactly one: "AI Full Stack Development" | "Generative AI & LLMs" | "RAG & LangGraph" | "AI Agents" | "Web Development" | "Coding Tutorial" | "Project Showcase" | "Developer Journey" | "BCA Placement" | "Freelancing & Clients" | "Software Career Education".

OUTPUT FORMAT:
Return ONLY a valid raw JSON object matching this structure (no markdown fences, no text outside JSON):
{
  "analysis": {
    "pillar": "AI Full Stack Development",
    "targetAudience": "string",
    "primaryKeyword": "string",
    "secondaryKeywords": ["kw1", "kw2", "kw3"],
    "contentObjective": "education",
    "hookType": "problem_solution",
    "ctaType": "discussion"
  },
  "youtube": {
    "title": "string (≤${YOUTUBE_TITLE_TARGET} chars, max 100)",
    "description": "string (350-800 chars, value hook + ▶ bullets + CTA)",
    "hashtags": ["20", "clean", "tags", "no", "hash"]
  },
  "instagram": {
    "title": "string (Reel headline)",
    "description": "string (Reel caption with hook, bullets, CTA)",
    "hashtags": ["20", "clean", "tags", "no", "hash"]
  },
  "linkedin": {
    "title": "string (Post headline)",
    "description": "string (Professional insights with line breaks and discussion CTA)",
    "hashtags": ["4", "to", "5", "tags"]
  }
}`;

const ENHANCE_SYSTEM_PROMPT = `You are a Senior AI Content Strategist and Copywriter for Rahul Kumar (AI Full Stack Developer).
Your task: Review and upgrade the creator's existing draft into high-clarity, high-converting versions tailored for YouTube, Instagram Reels, and LinkedIn.

RULES:
- Strengthen the hook and sharpen technical clarity.
- Remove passive voice, fluff, and generic buzzwords.
- Ground the content in practical developer reality.
- Maintain YouTube title ≤${YOUTUBE_TITLE_TARGET} chars (hard max: 100).
- Generate platform-native copy for YouTube, Instagram, and LinkedIn.
- Output ONLY a valid raw JSON object adhering to the schema.`;

const SHORTEN_TITLE_PROMPT = (title: string) =>
    `Shorten this developer video title to ≤${YOUTUBE_TITLE_TARGET} characters while preserving technical clarity and keyword punch. Return ONLY the title text:\n\n"${title}"`;

// ─── Smart Context-Grounded Fallback Engine ───────────────────────────────────

function detectPillarFromContext(text: string): ContentPillar {
    const lower = text.toLowerCase();
    if (lower.includes("rag") || lower.includes("langgraph") || lower.includes("retrieval") || lower.includes("vector")) {
        return "RAG & LangGraph";
    }
    if (lower.includes("agent") || lower.includes("autonom") || lower.includes("tool call")) {
        return "AI Agents";
    }
    if (lower.includes("llm") || lower.includes("generative") || lower.includes("gemini") || lower.includes("prompt")) {
        return "Generative AI & LLMs";
    }
    if (lower.includes("bca") || lower.includes("placement") || lower.includes("interview") || lower.includes("campus")) {
        return "BCA Placement";
    }
    if (lower.includes("freelance") || lower.includes("client") || lower.includes("upwork") || lower.includes("contract")) {
        return "Freelancing & Clients";
    }
    if (lower.includes("journey") || lower.includes("story") || lower.includes("learned") || lower.includes("mistake")) {
        return "Developer Journey";
    }
    if (lower.includes("tutorial") || lower.includes("how to code") || lower.includes("build from scratch")) {
        return "Coding Tutorial";
    }
    if (lower.includes("project") || lower.includes("portfolio") || lower.includes("showcase") || lower.includes("demo")) {
        return "Project Showcase";
    }
    if (lower.includes("career") || lower.includes("guidance") || lower.includes("roadmap") || lower.includes("student")) {
        return "Software Career Education";
    }
    if (lower.includes("css") || lower.includes("html") || lower.includes("frontend") || lower.includes("backend") || lower.includes("api")) {
        return "Web Development";
    }
    return "AI Full Stack Development";
}

/**
 * Intelligent, fact-grounded fallback generator that generates platform-specific
 * copy anchored strictly in the user's supplied text when AI APIs are unreachable.
 */
function generateGroundedFallback(rawCaption: string, mediaType: string): AIContentResult {
    const clean = (rawCaption || "").trim();
    const pillar = detectPillarFromContext(clean);

    // Extract core keywords
    const words = clean
        .replace(/[^a-zA-Z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3)
        .slice(0, 5);

    const kw1 = words[0] ? words[0].charAt(0).toUpperCase() + words[0].slice(1) : "AI Full Stack";
    const kw2 = words[1] ? words[1].charAt(0).toUpperCase() + words[1].slice(1) : "Development";
    const primaryKw = `${kw1} ${kw2}`.trim();

    // YouTube Content
    let ytTitle = clean.length > 0 && clean.length <= 75
        ? `${clean} | Full Guide`
        : `Building a Real-World ${kw1} App: Architecture & Code Walkthrough`;

    if (ytTitle.length > YOUTUBE_TITLE_MAX) {
        ytTitle = ytTitle.slice(0, YOUTUBE_TITLE_MAX).replace(/\s+\S*$/, "").trim();
    }

    const ytDesc = clean
        ? `${clean}\n\n` +
          `In this ${mediaType}, we break down the practical architecture, lessons learned, and implementation details.\n\n` +
          `▶ 01: Core architecture & tech stack overview\n` +
          `▶ 02: Step-by-step implementation breakdown\n` +
          `▶ 03: Common pitfalls & production best practices\n\n` +
          `💡 Subscribe for weekly practical tutorials on AI Full Stack, RAG, and Agent development.\n` +
          `Keywords: ${primaryKw.toLowerCase()}, AI development, Next.js, TypeScript, full stack roadmap`
        : `Practical engineering breakdown covering ${pillar.toLowerCase()} architecture, tools, and real-world implementation.\n\n` +
          `▶ 01: Complete architectural breakdown\n` +
          `▶ 02: Hands-on code walkthrough & setup\n` +
          `▶ 03: Key takeaways for developers & students\n\n` +
          `💡 Subscribe for weekly practical tutorials on AI Full Stack, RAG, and Agent development.\n` +
          `Keywords: full stack development, software engineering, AI roadmap, developer tutorial`;

    const ytTags = [
        "aifullstack", "webdev", "nextjs", "typescript", "softwareengineer",
        "developer", "coding", "fullstackdeveloper", "rag", "langchain",
        "reactjs", "nodejs", "programming", "learntocode", "techcareer",
        "bca", "aiagents", "generativeai", "projectshowcase", "buildinpublic",
    ];

    // Instagram Reel Content
    const igTitle = `${kw1} in 60 Seconds ⚡`;
    const igDesc = `Here's what you need to know about ${primaryKw}:\n\n` +
        `1️⃣ Focus on practical architecture before writing code\n` +
        `2️⃣ Choose modern tools (Next.js, TypeScript, Vector DBs)\n` +
        `3️⃣ Ship real projects that solve genuine problems\n\n` +
        `Save this reel for your next project & follow for more developer breakdowns! 💻✨`;
    const igTags = [
        "developer", "codinglife", "fullstackdeveloper", "webdevelopment", "softwareengineering",
        "techstudent", "computerscience", "buildinpublic", "learntocode", "nextjs",
        "javascript", "typescript", "aifullstack", "programmer", "codenewbie",
        "devcommunity", "developerjourney", "techreels", "codingtips", "bca",
    ];

    // LinkedIn Content
    const liTitle = `Building Production ${kw1}: Practical Architecture & Insights`;
    const liDesc = `When building real-world ${pillar.toLowerCase()} applications, theory only takes you so far.\n\n` +
        `Here are 3 fundamental engineering principles I rely on:\n\n` +
        `• Architecture First: Define state models and data boundaries before touching APIs.\n` +
        `• Type Safety: TypeScript across full stack eliminates an entire category of runtime bugs.\n` +
        `• Pragmatic Tooling: Use battle-tested frameworks like Next.js and Node.js for maintainability.\n\n` +
        `For fellow developers and students: What is the most critical lesson you've learned while building full-stack projects?\n\n` +
        `Would love to hear your perspectives in the comments below.`;
    const liTags = ["softwareengineering", "webdevelopment", "artificialintelligence", "fullstack", "programming"];

    const analysis: AIContentAnalysis = {
        pillar,
        targetAudience: "Aspiring developers, BCA/CS students, and full-stack engineers",
        primaryKeyword: primaryKw,
        secondaryKeywords: [kw1, kw2, "TypeScript", "Next.js", "Full Stack"],
        contentObjective: "education",
        hookType: "problem_solution",
        ctaType: "discussion",
    };

    const youtube: PlatformContent = { title: ytTitle, description: ytDesc, hashtags: ytTags };
    const instagram: PlatformContent = { title: igTitle, description: igDesc, hashtags: igTags };
    const linkedin: PlatformContent = { title: liTitle, description: liDesc, hashtags: liTags };

    return {
        title: ytTitle,
        description: ytDesc,
        hashtags: ytTags,
        analysis,
        platforms: { youtube, instagram, linkedin },
    };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function generateContent(
    rawCaption: string,
    mediaType: string,
    platforms: string[]
): Promise<AIContentResult> {
    const hasCloudKey = !!(env.GEMINI_API_KEY || env.MISTRAL_API_KEY);
    if (!hasCloudKey) {
        logger.info("No GEMINI_API_KEY or MISTRAL_API_KEY set — using grounded developer content engine");
        return generateGroundedFallback(rawCaption, mediaType);
    }

    const provider = getProvider();

    logger.debug("AI generate request", {
        provider: provider.name,
        mediaType,
        platformCount: platforms.length,
    });

    const prompt = `TASK: Generate authentic, high-converting content for Rahul Kumar's developer channels.

MEDIA TYPE: ${mediaType}
TARGET PLATFORMS: ${platforms.join(", ")}

CREATOR CONTEXT / RAW CAPTION:
"""${rawCaption || "Building full-stack AI applications and developer project walkthroughs."}"""

INSTRUCTIONS:
1. Analyze topic, content pillar, and target developer audience.
2. Formulate grounded, high-relevance copy for YouTube, Instagram Reels, and LinkedIn.
3. YouTube title target: ≤${YOUTUBE_TITLE_TARGET} chars (hard limit: 100 chars).
4. Return ONLY the structured JSON object matching the specification.`;

    try {
        const result = await callAIWithRetry(prompt, STRATEGIC_SYSTEM_PROMPT);
        return enforceYoutubeTitleLimit(result);
    } catch (err) {
        logger.warn("AI generation failed or timed out — using grounded developer fallback", {
            provider: provider.name,
            error: err instanceof Error ? err.message : String(err),
        });
        return generateGroundedFallback(rawCaption, mediaType);
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
        logger.info("No cloud AI key set — enhancing via grounded engine");
        return generateGroundedFallback(`${title}\n\n${description}`, "video");
    }

    const provider = getProvider();

    logger.debug("AI enhance request", {
        provider: provider.name,
        platformCount: platforms.length,
    });

    const prompt = `TASK: Enhance and optimize this developer post across YouTube, Instagram, and LinkedIn.

CURRENT CONTENT:
Title: """${title}"""
Description: """${description}"""
Hashtags: ${hashtags.join(", ")}

TARGET PLATFORMS: ${platforms.join(", ")}

INSTRUCTIONS:
1. Elevate clarity, sharpen hooks, and ensure technical credibility.
2. Tailor platform-specific output for YouTube, Instagram, and LinkedIn.
3. Keep YouTube title ≤${YOUTUBE_TITLE_TARGET} chars (hard limit: 100).
4. Return ONLY valid raw JSON matching the required schema.`;

    try {
        const result = await callAIWithRetry(prompt, ENHANCE_SYSTEM_PROMPT);
        return enforceYoutubeTitleLimit(result);
    } catch (err) {
        logger.warn("AI enhance failed — returning grounded fallback", {
            provider: provider.name,
            error: err instanceof Error ? err.message : String(err),
        });
        return generateGroundedFallback(`${title}\n\n${description}`, "video");
    }
}

// ─── Internal Execution & Resilience ──────────────────────────────────────────

async function callAIWithRetry(
    prompt: string,
    systemPrompt: string
): Promise<AIContentResult> {
    const provider = getProvider();

    // First attempt
    const raw = await provider.generate(prompt, systemPrompt, true);
    const parsed = tryParseAIResponse(raw);
    if (parsed) return parsed;

    // Retry once with stricter formatting instruction
    logger.warn("AI response was not valid JSON on first attempt — retrying with stricter prompt", {
        provider: provider.name,
    });

    const retryPrompt = `${prompt}

CRITICAL: Your previous output failed JSON parsing. Return ONLY a valid raw JSON object. Do not include markdown \`\`\` fences, and do not include preamble.`;

    const retryRaw = await provider.generate(retryPrompt, systemPrompt, true);
    const retryParsed = tryParseAIResponse(retryRaw);
    if (retryParsed) return retryParsed;

    throw new AIProviderError(
        "AI returned invalid JSON after two attempts.",
        "INVALID_JSON",
        provider.name
    );
}

// ─── YouTube Title Limit Enforcement ──────────────────────────────────────────

async function enforceYoutubeTitleLimit(result: AIContentResult): Promise<AIContentResult> {
    if (result.title.length <= YOUTUBE_TITLE_MAX && result.platforms.youtube.title.length <= YOUTUBE_TITLE_MAX) {
        return result;
    }

    const titleToShorten = result.platforms.youtube.title.length > YOUTUBE_TITLE_MAX
        ? result.platforms.youtube.title
        : result.title;

    logger.warn("Title exceeds 100 chars — shortening", {
        titleLength: titleToShorten.length,
    });

    let shortened = titleToShorten.slice(0, YOUTUBE_TITLE_TARGET).replace(/\s+\S*$/, "").trim();

    try {
        const provider = getProvider();
        const aiShortened = await provider.generate(
            SHORTEN_TITLE_PROMPT(titleToShorten),
            "You are a concise technical editor. Return ONLY the shortened title text.",
            false
        );
        const cleanShort = aiShortened.replace(/^["']|["']$/g, "").trim();
        if (cleanShort.length > 0 && cleanShort.length <= YOUTUBE_TITLE_MAX) {
            shortened = cleanShort;
        }
    } catch {
        // Safe fallback to character slicing
    }

    return {
        ...result,
        title: shortened,
        platforms: {
            ...result.platforms,
            youtube: {
                ...result.platforms.youtube,
                title: shortened,
            },
        },
    };
}

// ─── JSON Parsing Helper ──────────────────────────────────────────────────────

function cleanHashtags(raw: unknown, defaultTags: string[]): string[] {
    if (Array.isArray(raw)) {
        const cleaned = raw
            .map((t) => String(t).replace(/^#/, "").replace(/[^a-zA-Z0-9_]/g, "").trim())
            .filter((t) => t.length > 0);
        if (cleaned.length >= 2) return cleaned.slice(0, 30);
    }
    if (typeof raw === "string") {
        const cleaned = raw
            .split(/[\s,#]+/)
            .map((t) => t.replace(/[^a-zA-Z0-9_]/g, "").trim())
            .filter((t) => t.length > 0);
        if (cleaned.length >= 2) return cleaned.slice(0, 30);
    }
    return defaultTags;
}

function extractBlock(
    block: unknown,
    fallbackTitle: string,
    fallbackDesc: string,
    fallbackTags: string[]
): PlatformContent {
    if (!block) {
        return { title: fallbackTitle, description: fallbackDesc, hashtags: fallbackTags };
    }
    const target = (Array.isArray(block) ? block[0] : block) as Record<string, unknown> | null;
    if (typeof target !== "object" || target === null) {
        return { title: fallbackTitle, description: fallbackDesc, hashtags: fallbackTags };
    }

    const title =
        typeof target.title === "string" && target.title.trim()
            ? target.title.trim()
            : typeof target.headline === "string" && target.headline.trim()
                ? target.headline.trim()
                : fallbackTitle;

    const description =
        typeof target.description === "string" && target.description.trim()
            ? target.description.trim()
            : typeof target.content === "string" && target.content.trim()
                ? target.content.trim()
                : typeof target.caption === "string" && target.caption.trim()
                    ? target.caption.trim()
                    : fallbackDesc;

    const hashtags = cleanHashtags(target.hashtags || target.tags || target.keywords, fallbackTags);

    return { title, description, hashtags };
}

function tryParseAIResponse(raw: string): AIContentResult | null {
    try {
        const stripped = raw
            .replace(/```json/gi, "")
            .replace(/```/g, "")
            .trim();

        const jsonMatch = stripped.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;

        // Clean trailing commas before parsing
        const cleanedJsonStr = jsonMatch[0].replace(/,\s*([}\]])/g, "$1");
        const json = JSON.parse(cleanedJsonStr) as Record<string, unknown>;

        const defaultYtTitle = typeof json.title === "string" ? json.title : "AI Full Stack Application Architecture";
        const defaultYtDesc = typeof json.description === "string" ? json.description : "Practical breakdown of real-world developer architecture and implementation.";
        const defaultYtTags = cleanHashtags(json.hashtags, [
            "aifullstack", "webdev", "nextjs", "typescript", "softwareengineer",
            "developer", "coding", "fullstackdeveloper", "rag", "langchain",
        ]);

        const yt = extractBlock(json.youtube, defaultYtTitle, defaultYtDesc, defaultYtTags);
        const ig = extractBlock(json.instagram, yt.title, yt.description, yt.hashtags);
        const li = extractBlock(json.linkedin, yt.title, yt.description, yt.hashtags.slice(0, 5));

        // Strategy & analysis
        const rawAnalysis = (json.analysis && typeof json.analysis === "object" ? json.analysis : {}) as Record<string, unknown>;
        const detectedPillar = detectPillarFromContext(`${yt.title} ${yt.description}`);
        const analysis: AIContentAnalysis = {
            pillar: (typeof rawAnalysis.pillar === "string" && CONTENT_PILLARS.includes(rawAnalysis.pillar as ContentPillar))
                ? (rawAnalysis.pillar as ContentPillar)
                : detectedPillar,
            targetAudience: typeof rawAnalysis.targetAudience === "string" ? rawAnalysis.targetAudience : "Developers, tech students, and engineers",
            primaryKeyword: typeof rawAnalysis.primaryKeyword === "string" ? rawAnalysis.primaryKeyword : "AI Full Stack Development",
            secondaryKeywords: Array.isArray(rawAnalysis.secondaryKeywords)
                ? rawAnalysis.secondaryKeywords.map(String)
                : ["Next.js", "TypeScript", "LangChain"],
            contentObjective: (["education", "project_demo", "career_growth", "authority"].includes(rawAnalysis.contentObjective as string))
                ? (rawAnalysis.contentObjective as "education" | "project_demo" | "career_growth" | "authority")
                : "education",
            hookType: (["problem_solution", "technical_curiosity", "case_study", "contrarian"].includes(rawAnalysis.hookType as string))
                ? (rawAnalysis.hookType as "problem_solution" | "technical_curiosity" | "case_study" | "contrarian")
                : "problem_solution",
            ctaType: (["discussion", "follow", "github_repo", "resource"].includes(rawAnalysis.ctaType as string))
                ? (rawAnalysis.ctaType as "discussion" | "follow" | "github_repo" | "resource")
                : "discussion",
        };

        return {
            title: yt.title,
            description: yt.description,
            hashtags: yt.hashtags,
            analysis,
            platforms: {
                youtube: yt,
                instagram: ig,
                linkedin: li,
            },
        };
    } catch {
        return null;
    }
}

export { AIProviderError };

/**
 * AI Content Generation & SEO Strategy Engine
 *
 * Expert-level SEO content generation for Rahul Kumar — AI Full Stack Developer.
 * Built with deep understanding of YouTube Algorithm, Instagram Reels virality,
 * and LinkedIn authority positioning.
 *
 * SEO Philosophy:
 *   Search Intent Match → Keyword-Rich Hook → Value Delivery → Trust → Growth
 *
 * Supported Providers: Google Gemini (Primary) & Mistral AI (Failover)
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

const YOUTUBE_TITLE_MAX = 100;
const YOUTUBE_TITLE_TARGET = 70; // Sweet spot for CTR + full display

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

// ─── Master SEO System Prompt ─────────────────────────────────────────────────

const STRATEGIC_SYSTEM_PROMPT = `You are a world-class YouTube SEO Strategist and Viral Content Architect with 10+ years of experience growing creator channels to 100K+ subscribers.

CRITICAL RULE #1: READ THE CREATOR'S CONTENT IDEA CAREFULLY.
Your ENTIRE output must be about the EXACT TOPIC the creator described.
Do NOT generate generic content. Do NOT default to "Build an AI app" or "Full Stack tutorial" if the creator's topic is something else entirely.
If the creator says "BCA students aren't taught right skills" — your title MUST be about BCA skills gap, NOT about building an app.
If the creator says "freelancing tips" — your title MUST be about freelancing, NOT about AI development.
UNDERSTAND THE TOPIC FIRST, THEN OPTIMIZE.

You specialize in:
- YouTube Algorithm optimization (CTR, watch time, search rank, suggested video signals)
- Instagram Reels virality mechanics (hook retention, saves, shares, explore page)
- LinkedIn thought leadership and professional authority positioning
- Keyword research, search intent mapping, and semantic SEO
- Multi-lingual content (English + Hinglish for Indian tech audience)

YOUTUBE SEO — EXPERT RULES:
TITLE (CRITICAL — determines 70% of your success):
- UNDERSTAND the creator's topic FIRST, then craft the title around it
- Front-load the PRIMARY keyword in first 3-4 words (YouTube crawls left to right)
- Target EXACTLY 50-70 characters for full display + max CTR (HARD MAX: 100 chars)
- Use HIGH-CTR power words: "Nobody Tells You", "Truth About", "Mistake", "Reality", "Complete Guide", "Don't", "Stop", "Why"
- Emotional hooks work: curiosity gaps, bold claims, relatable frustrations
- Hinglish titles work GREAT for Indian tech audience (e.g. "BCA Kar Rahe Ho? Ye Skills College Nahi Sikhayega")
- NEVER use clickbait, fake metrics, or misleading promises

DESCRIPTION (SEO GOLD — YouTube indexes every word):
- LINE 1 (Above the fold): Primary keyword + clear value promise related to THE ACTUAL TOPIC
- For Indian tech audience: mixing Hindi/Hinglish in description is okay and engaging
- STRUCTURE: Hook line → value bullets → timestamps → subscribe CTA → keyword footer
- KEYWORD DENSITY: Primary keyword 2-3x naturally, secondary 1-2x each
- TARGET 400-600 chars
- Include a strong CTA like "Comment ROADMAP" or "Save this" at the end

HASHTAGS (YouTube uses top 3 for categorization):
- EXACTLY 15 hashtags: 3 broad, 5 mid-tier niche, 7 long-tail specific
- Hashtags MUST be relevant to the ACTUAL TOPIC
- NO hash symbol in the array

INSTAGRAM REELS SEO — EXPERT RULES:
TITLE: 3-7 words, must STOP the scroll instantly — use the creator's exact topic
CAPTION:
- HOOK (Line 1-2): Strong pattern interrupt using THE ACTUAL TOPIC
- VALUE BODY: 3-5 tight bullet points with emojis, digestible on mobile
- ENGAGEMENT TRIGGER: "Save this" or discussion CTA (saves = biggest ranking signal)
- Hinglish captions are MORE engaging for Indian audience
HASHTAGS - EXACTLY 20 hashtags tiered:
- 4 MEGA (1M+ posts): relevant broad tags
- 6 LARGE (100K-1M): niche-relevant tags
- 6 MEDIUM (10K-100K): specific topic tags
- 4 NICHE/MICRO (<10K): ultra-specific long-tail

LINKEDIN SEO — EXPERT RULES:
TITLE: Professional but bold, challenge conventional wisdom
CONTENT:
- LINE 1 hook before "see more" — about THE ACTUAL TOPIC
- Strategic white space — single sentences per line
- Genuine discussion question drives comments
- 150-300 words optimal
HASHTAGS: EXACTLY 5 tags — 2 broad professional + 2 niche + 1 trending

SEO SCORING: Include seoScore (0-100) per platform.

OUTPUT FORMAT — STRICT JSON ONLY. Return ONLY valid raw JSON. No markdown fences.
{
  "analysis": {
    "pillar": "string — detected content category",
    "targetAudience": "string",
    "primaryKeyword": "string — the main search keyword for this specific topic",
    "secondaryKeywords": ["kw1", "kw2", "kw3", "kw4"],
    "searchIntent": "informational | tutorial | project_demo | career | inspiration",
    "contentObjective": "education | project_demo | career_growth | authority",
    "hookType": "problem_solution | technical_curiosity | case_study | contrarian | how_to",
    "ctaType": "discussion | follow | github_repo | resource | save"
  },
  "youtube": {
    "title": "string — 50-70 chars, about the ACTUAL TOPIC, keyword-front-loaded",
    "description": "string — 400-600 chars, about the ACTUAL TOPIC",
    "hashtags": ["15 relevant hashtags"],
    "seoScore": 87
  },
  "instagram": {
    "title": "string — 3-7 word scroll-stopping hook about the ACTUAL TOPIC",
    "description": "string — hook + value bullets + CTA",
    "hashtags": ["20 relevant hashtags"],
    "seoScore": 82
  },
  "linkedin": {
    "title": "string — bold professional hook about the ACTUAL TOPIC",
    "description": "string — insight + value + discussion CTA",
    "hashtags": ["5 relevant tags"],
    "seoScore": 79
  }
}`;

// ─── Enhance System Prompt ────────────────────────────────────────────────────

const ENHANCE_SYSTEM_PROMPT = `You are a world-class YouTube SEO Strategist and Content Upgrade Specialist with 10+ years upgrading developer content from "okay" to "algorithm-optimized."

Your job: Take the creator's EXISTING draft and upgrade it to maximum SEO potential across YouTube, Instagram, and LinkedIn.

UPGRADE CHECKLIST:
- YouTube Title: Primary keyword in first 3-4 words? 50-70 chars? CTR power words? Fix all gaps.
- YouTube Description: Line 1 has keyword + promise? Proper bullet points with secondary keywords? Keyword footer? Timestamps placeholder?
- Instagram: Is the hook a genuine scroll-stopper? Properly tiered hashtags (mega/large/medium/micro)?
- LinkedIn: Line 1 creates curiosity? Strategic white space? Genuine discussion question at end?
- All hashtag tiers covered?

RULES:
- Strengthen hooks, remove passive voice and buzzwords
- Ground all content in practical developer reality
- Keep YouTube title 50-70 chars (hard max 100)
- Output ONLY valid raw JSON matching the required schema exactly`;

const SHORTEN_TITLE_PROMPT = (title: string) =>
    `You are a YouTube SEO expert. Shorten this video title to 50-70 characters while keeping the primary keyword in the FIRST 3-4 words. Return ONLY the shortened title text:\n\n"${title}"`;

// ─── Smart Fallback Engine ────────────────────────────────────────────────────

function detectPillarFromContext(text: string): ContentPillar {
    const lower = text.toLowerCase();
    if (lower.includes("rag") || lower.includes("langgraph") || lower.includes("retrieval") || lower.includes("vector")) return "RAG & LangGraph";
    if (lower.includes("agent") || lower.includes("autonom") || lower.includes("tool call") || lower.includes("agentic")) return "AI Agents";
    if (lower.includes("llm") || lower.includes("generative") || lower.includes("gemini") || lower.includes("gpt") || lower.includes("prompt")) return "Generative AI & LLMs";
    if (lower.includes("bca") || lower.includes("placement") || lower.includes("interview") || lower.includes("campus")) return "BCA Placement";
    if (lower.includes("freelance") || lower.includes("client") || lower.includes("upwork") || lower.includes("fiverr")) return "Freelancing & Clients";
    if (lower.includes("journey") || lower.includes("story") || lower.includes("learned") || lower.includes("mistake")) return "Developer Journey";
    if (lower.includes("tutorial") || lower.includes("how to") || lower.includes("build") || lower.includes("from scratch")) return "Coding Tutorial";
    if (lower.includes("project") || lower.includes("portfolio") || lower.includes("showcase") || lower.includes("demo")) return "Project Showcase";
    if (lower.includes("career") || lower.includes("guidance") || lower.includes("roadmap") || lower.includes("student")) return "Software Career Education";
    if (lower.includes("css") || lower.includes("html") || lower.includes("frontend") || lower.includes("backend") || lower.includes("api")) return "Web Development";
    return "AI Full Stack Development";
}

function generateGroundedFallback(rawCaption: string, mediaType: string): AIContentResult {
    const clean = (rawCaption || "").trim();
    const pillar = detectPillarFromContext(clean);

    // Extract meaningful words from the raw caption for topic-aware content
    const words = clean
        .replace(/[^a-zA-Z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2)
        .slice(0, 10);

    // Build a topic-aware title from the actual caption
    let ytTitle: string;
    if (clean.length > 10 && clean.length <= 70) {
        // Caption is already a reasonable title length — capitalize and use it
        ytTitle = clean.charAt(0).toUpperCase() + clean.slice(1);
    } else if (clean.length > 70) {
        // Shorten but keep the meaning
        ytTitle = clean.slice(0, 65).replace(/\s+\S*$/, "").trim();
    } else {
        // Very short or empty — detect topic and build contextual title
        const topicTitles: Record<string, string> = {
            "BCA Placement": "BCA Students: Skills College Won't Teach You 🚨",
            "Software Career Education": "Skills Every Student Needs But Colleges Don't Teach",
            "AI Full Stack Development": "Build Real AI Apps — Complete Developer Guide",
            "Generative AI & LLMs": "AI Tools Every Developer Should Know in 2025",
            "RAG & LangGraph": "RAG Tutorial — Build AI That Uses Your Own Data",
            "AI Agents": "AI Agents Explained — Build Your First Agent",
            "Web Development": "Web Development Skills That Actually Get You Hired",
            "Coding Tutorial": "Coding Tutorial for Beginners — Start Here",
            "Project Showcase": "Real Project Demo — What I Built and How",
            "Developer Journey": "My Developer Journey — Lessons I Wish I Knew Earlier",
            "Freelancing & Clients": "Freelancing Guide — How to Get Your First Client",
        };
        ytTitle = topicTitles[pillar] ?? `${words.slice(0, 4).join(" ")} — Complete Guide`;
    }

    if (ytTitle.length > YOUTUBE_TITLE_MAX) {
        ytTitle = ytTitle.slice(0, YOUTUBE_TITLE_MAX).replace(/\s+\S*$/, "").trim();
    }

    // Build topic-aware description from actual content
    const topicPhrase = clean || pillar;
    const ytDesc =
        `${topicPhrase} — everything you need to know. 🚀\n\n` +
        `In this ${mediaType}:\n` +
        `▶ The real problem and why it matters\n` +
        `▶ What most people get wrong\n` +
        `▶ Practical steps you can take today\n` +
        `▶ Resources and next steps\n\n` +
        `🔔 Follow for more content like this.\n\n` +
        `Comment "ROADMAP" and I'll send you helpful resources in DM. 📩\n\n` +
        `Keywords: ${words.slice(0, 5).join(", ").toLowerCase()}`;

    // Topic-aware hashtags
    const topicTag = pillar.toLowerCase().replace(/[^a-z0-9]/g, "");
    const ytTags = [
        "coding", "programming", "students",
        topicTag, "career", "skills", "education",
        "placement", "developer", "technology",
        "techcareer", "learntocode", "india",
        "bcaplacement", "studentlife",
    ];

    const igTitle = clean.length > 5
        ? `${clean.split(/\s+/).slice(0, 5).join(" ")} 🔥`
        : `${pillar} — Must Watch 🔥`;
    const igDesc =
        `${topicPhrase} 👇\n\n` +
        `Most people don't know this about ${pillar.toLowerCase()} 🚨\n\n` +
        `✅ The truth nobody tells you\n` +
        `✅ What you actually need to focus on\n` +
        `✅ Practical steps to start today\n\n` +
        `Save this for later! 💾 Follow for more 👇`;

    const igTags = [
        "students", "coding", "programming", "tech",
        "career", "developer", "education", "skills", "learning", "motivation",
        topicTag, "placement", "college", "india", "studentlife", "techcareer",
        "careeradvice", "codinglife", "learntocode", "bcaplacement",
    ];

    const liTitle = `Here's what nobody tells you about ${pillar.toLowerCase()}.`;
    const liDesc =
        `${topicPhrase}\n\n` +
        `This is something most people learn too late.\n\n` +
        `After spending time in this space, here's what I've observed:\n\n` +
        `→ The gap between what's taught and what's needed is real\n` +
        `→ Self-learning is no longer optional\n` +
        `→ Practical experience beats theoretical knowledge every time\n\n` +
        `What's your experience? I'd love to hear from you. 👇`;

    const liTags = ["careergrowth", "education", topicTag, "students", "skills"];

    const analysis: AIContentAnalysis = {
        pillar,
        targetAudience: "Students, developers, and career-focused learners",
        primaryKeyword: words.slice(0, 3).join(" ") || pillar,
        secondaryKeywords: words.slice(3, 7).concat([pillar.toLowerCase()]),
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
        logger.info("No AI API key configured — using grounded SEO fallback engine");
        return generateGroundedFallback(rawCaption, mediaType);
    }

    const provider = getProvider();
    logger.debug("AI generate request", { provider: provider.name, mediaType, platformCount: platforms.length });

    const prompt =
        `TASK: Generate SEO-optimized content for a creator's social media channels.\n\n` +
        `MEDIA TYPE: ${mediaType}\n` +
        `TARGET PLATFORMS: ${platforms.join(", ")}\n\n` +
        `⚠️ CRITICAL: The creator's content idea below is THE TOPIC. Your output MUST be about THIS EXACT TOPIC.\n` +
        `Do NOT generate generic "build an app" content if the topic is about something else.\n` +
        `Read the content idea carefully and generate titles/descriptions that match it precisely.\n\n` +
        `CREATOR'S CONTENT IDEA / RAW CAPTION:\n"""${rawCaption || "Tech content for developers and students"}"""\n\n` +
        `MANDATORY STEPS:\n` +
        `1. UNDERSTAND the creator's actual topic — what is this content REALLY about?\n` +
        `2. Extract the PRIMARY keyword that someone would search to find THIS specific content\n` +
        `3. Identify 3-5 secondary keywords related to THIS topic\n` +
        `4. Determine search intent (learn, discover, solve, get inspired?)\n` +
        `5. YouTube title: About THIS TOPIC, keyword front-loaded, 50-70 chars, high CTR, can use Hinglish for Indian audience\n` +
        `6. YouTube description: About THIS TOPIC, hook + value bullets + CTA like "Comment ROADMAP" for engagement\n` +
        `7. Instagram hook: About THIS TOPIC, stops scroll in 2 seconds\n` +
        `8. LinkedIn hook: About THIS TOPIC, makes professionals tap "see more"\n` +
        `9. Tiered hashtags RELEVANT TO THIS TOPIC\n` +
        `10. SEO score for each platform (0-100)\n\n` +
        `Return ONLY the structured JSON object. Zero text outside JSON.`;

    try {
        const result = await callAIWithRetry(prompt, STRATEGIC_SYSTEM_PROMPT);
        return enforceYoutubeTitleLimit(result);
    } catch (err) {
        logger.warn("AI generation failed — using grounded SEO fallback", {
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
        logger.info("No cloud AI key — enhancing via grounded SEO engine");
        return generateGroundedFallback(`${title}\n\n${description}`, "video");
    }

    const provider = getProvider();
    logger.debug("AI enhance request", { provider: provider.name, platformCount: platforms.length });

    const prompt =
        `TASK: Upgrade this developer content to maximum SEO score across all platforms.\n\n` +
        `CURRENT DRAFT TO UPGRADE:\n` +
        `Title: """${title}"""\n` +
        `Description: """${description}"""\n` +
        `Hashtags: ${hashtags.join(", ")}\n` +
        `TARGET PLATFORMS: ${platforms.join(", ")}\n\n` +
        `SEO UPGRADE CHECKLIST:\n` +
        `1. YouTube Title: Primary keyword in first 3-4 words? 50-70 chars? CTR power words?\n` +
        `2. YouTube Description: Line 1 with keyword + promise? Bullets with secondary keywords? Keyword footer? Timestamps?\n` +
        `3. Instagram: Genuine scroll-stopping hook? Value body + save CTA? Tiered hashtags?\n` +
        `4. LinkedIn: Line 1 creates curiosity? Strategic white space? Discussion question at end?\n` +
        `5. All hashtag tiers covered?\n` +
        `6. SEO score (0-100) for each platform after upgrade.\n\n` +
        `Return ONLY valid raw JSON matching the required schema.`;

    try {
        const result = await callAIWithRetry(prompt, ENHANCE_SYSTEM_PROMPT);
        return enforceYoutubeTitleLimit(result);
    } catch (err) {
        logger.warn("AI enhance failed — returning grounded SEO fallback", {
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

    const raw = await provider.generate(prompt, systemPrompt, true);
    const parsed = tryParseAIResponse(raw);
    if (parsed) return parsed;

    logger.warn("AI response was not valid JSON — retrying with stricter instruction", { provider: provider.name });

    const retryPrompt =
        `${prompt}\n\n` +
        `CRITICAL: Your previous response failed JSON validation.\n` +
        `- Return ONLY a raw JSON object\n` +
        `- NO markdown fences (no triple backticks)\n` +
        `- NO preamble text or explanation\n` +
        `- Start with { and end with }`;

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

    logger.warn("YouTube title exceeds 100 chars — shortening with AI", { titleLength: titleToShorten.length });

    let shortened = titleToShorten.slice(0, YOUTUBE_TITLE_TARGET).replace(/\s+\S*$/, "").trim();

    try {
        const provider = getProvider();
        const aiShortened = await provider.generate(
            SHORTEN_TITLE_PROMPT(titleToShorten),
            "You are a YouTube SEO expert. Return ONLY the shortened title text, nothing else.",
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
            youtube: { ...result.platforms.youtube, title: shortened },
        },
    };
}

// ─── JSON Parsing Helpers ──────────────────────────────────────────────────────

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
    if (!block) return { title: fallbackTitle, description: fallbackDesc, hashtags: fallbackTags };

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
    const seoScore = typeof target.seoScore === "number" ? target.seoScore : undefined;

    return { title, description, hashtags, ...(seoScore !== undefined ? { seoScore } : {}) };
}

function tryParseAIResponse(raw: string): AIContentResult | null {
    try {
        const stripped = raw
            .replace(/```json/gi, "")
            .replace(/```/g, "")
            .trim();

        const jsonMatch = stripped.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;

        const cleanedJsonStr = jsonMatch[0].replace(/,\s*([}\]])/g, "$1");
        const json = JSON.parse(cleanedJsonStr) as Record<string, unknown>;

        const defaultYtTitle = typeof json.title === "string" ? json.title : "Content That Matters — Watch Now";
        const defaultYtDesc = typeof json.description === "string" ? json.description : "Complete breakdown of the topic with practical insights and actionable takeaways.";
        const defaultYtTags = cleanHashtags(json.hashtags, [
            "coding", "programming", "tech",
            "education", "students", "career", "skills",
            "developer", "learning", "india",
        ]);

        const yt = extractBlock(json.youtube, defaultYtTitle, defaultYtDesc, defaultYtTags);
        const ig = extractBlock(json.instagram, yt.title, yt.description, yt.hashtags);
        const li = extractBlock(json.linkedin, yt.title, yt.description, yt.hashtags.slice(0, 5));

        const rawAnalysis = (json.analysis && typeof json.analysis === "object" ? json.analysis : {}) as Record<string, unknown>;
        const detectedPillar = detectPillarFromContext(`${yt.title} ${yt.description}`);

        const analysis: AIContentAnalysis = {
            pillar: (typeof rawAnalysis.pillar === "string" && CONTENT_PILLARS.includes(rawAnalysis.pillar as ContentPillar))
                ? (rawAnalysis.pillar as ContentPillar)
                : detectedPillar,
            targetAudience: typeof rawAnalysis.targetAudience === "string"
                ? rawAnalysis.targetAudience
                : "BCA/CS students and developers building AI projects",
            primaryKeyword: typeof rawAnalysis.primaryKeyword === "string"
                ? rawAnalysis.primaryKeyword
                : "AI Full Stack Development",
            secondaryKeywords: Array.isArray(rawAnalysis.secondaryKeywords)
                ? rawAnalysis.secondaryKeywords.map(String)
                : ["Next.js", "TypeScript", "LangChain", "AI Agents", "Full Stack"],
            contentObjective: (["education", "project_demo", "career_growth", "authority"].includes(rawAnalysis.contentObjective as string))
                ? (rawAnalysis.contentObjective as "education" | "project_demo" | "career_growth" | "authority")
                : "education",
            hookType: (["problem_solution", "technical_curiosity", "case_study", "contrarian", "how_to"].includes(rawAnalysis.hookType as string))
                ? (rawAnalysis.hookType as "problem_solution" | "technical_curiosity" | "case_study" | "contrarian")
                : "problem_solution",
            ctaType: (["discussion", "follow", "github_repo", "resource", "save"].includes(rawAnalysis.ctaType as string))
                ? (rawAnalysis.ctaType as "discussion" | "follow" | "github_repo" | "resource")
                : "discussion",
        };

        return {
            title: yt.title,
            description: yt.description,
            hashtags: yt.hashtags,
            analysis,
            platforms: { youtube: yt, instagram: ig, linkedin: li },
        };
    } catch {
        return null;
    }
}

export { AIProviderError };

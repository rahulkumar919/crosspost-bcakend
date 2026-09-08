/**
 * Platform-specific content validation.
 *
 * These validators enforce the hard limits imposed by each platform's API.
 * AI generates content within these limits, but post-generation validation
 * acts as a safety net — AI output is never trusted blindly.
 *
 * Limits are sourced from platform developer documentation:
 *   YouTube: https://developers.google.com/youtube/v3/docs/videos/insert
 *   Instagram: https://developers.facebook.com/docs/instagram-api/reference/ig-media
 *   LinkedIn: https://learn.microsoft.com/en-us/linkedin/marketing/integrations/community-management/shares
 */

export interface ValidationError {
    field: string;
    message: string;
    /** Platform-enforced hard limit — if true, this MUST be fixed before publishing */
    hard: boolean;
}

export interface PlatformValidationResult {
    valid: boolean;
    errors: ValidationError[];
    /** Sanitized content with safe truncations applied where possible */
    sanitized: {
        title: string;
        description: string;
        hashtags: string[];
    };
}

// ─── YouTube ──────────────────────────────────────────────────────────────────

const YT_LIMITS = {
    title: { max: 100, target: 80 },
    description: { max: 5000 },
    hashtags: { max: 15 },               // YouTube ignores beyond 15 in search
    hashtagLength: { max: 100 },
} as const;

export function validateYouTubeContent(
    title: string,
    description: string,
    hashtags: string[]
): PlatformValidationResult {
    const errors: ValidationError[] = [];

    let sanitizedTitle = title.trim();
    let sanitizedDescription = description.trim();
    let sanitizedHashtags = [...hashtags];

    // Title — HARD limit
    if (!sanitizedTitle) {
        errors.push({ field: "title", message: "YouTube title is required.", hard: true });
    } else if (sanitizedTitle.length > YT_LIMITS.title.max) {
        errors.push({
            field: "title",
            message: `YouTube title is ${sanitizedTitle.length} characters — maximum is ${YT_LIMITS.title.max}. The title will be truncated.`,
            hard: false,
        });
        // Auto-truncate at word boundary
        sanitizedTitle = truncateAtWordBoundary(sanitizedTitle, YT_LIMITS.title.max);
    }

    // Description — HARD limit
    if (sanitizedDescription.length > YT_LIMITS.description.max) {
        errors.push({
            field: "description",
            message: `YouTube description is ${sanitizedDescription.length} characters — maximum is ${YT_LIMITS.description.max}.`,
            hard: false,
        });
        sanitizedDescription = sanitizedDescription.slice(0, YT_LIMITS.description.max);
    }

    // Hashtags — soft limit (YouTube ignores extras)
    if (sanitizedHashtags.length > YT_LIMITS.hashtags.max) {
        errors.push({
            field: "hashtags",
            message: `YouTube recognizes only the first ${YT_LIMITS.hashtags.max} hashtags. The extra ${sanitizedHashtags.length - YT_LIMITS.hashtags.max} will be ignored.`,
            hard: false,
        });
        sanitizedHashtags = sanitizedHashtags.slice(0, YT_LIMITS.hashtags.max);
    }

    return {
        valid: !errors.some((e) => e.hard),
        errors,
        sanitized: {
            title: sanitizedTitle,
            description: sanitizedDescription,
            hashtags: sanitizedHashtags,
        },
    };
}

// ─── Instagram ───────────────────────────────────────────────────────────────

const IG_LIMITS = {
    caption: { max: 2200 },
    hashtags: { max: 30 },              // Instagram soft limit: 30 hashtags
} as const;

export function validateInstagramContent(
    _title: string,                     // Instagram has no separate title field
    description: string,
    hashtags: string[]
): PlatformValidationResult {
    const errors: ValidationError[] = [];

    let sanitizedDescription = description.trim();
    let sanitizedHashtags = [...hashtags];

    // Caption (description + hashtags combined) — HARD limit
    const hashtagStr = sanitizedHashtags.map((h) => `#${h}`).join(" ");
    const combined = `${sanitizedDescription}\n\n${hashtagStr}`;

    if (combined.length > IG_LIMITS.caption.max) {
        errors.push({
            field: "description",
            message: `Instagram caption (including hashtags) is ${combined.length} characters — maximum is ${IG_LIMITS.caption.max}.`,
            hard: false,
        });
        // Truncate description to fit
        const hashtagPart = `\n\n${hashtagStr}`;
        const maxDescLen = IG_LIMITS.caption.max - hashtagPart.length;
        if (maxDescLen > 0) {
            sanitizedDescription = sanitizedDescription.slice(0, maxDescLen).trim();
        }
    }

    // Hashtag count
    if (sanitizedHashtags.length > IG_LIMITS.hashtags.max) {
        errors.push({
            field: "hashtags",
            message: `Instagram allows a maximum of ${IG_LIMITS.hashtags.max} hashtags. The extra ${sanitizedHashtags.length - IG_LIMITS.hashtags.max} will be removed.`,
            hard: false,
        });
        sanitizedHashtags = sanitizedHashtags.slice(0, IG_LIMITS.hashtags.max);
    }

    return {
        valid: !errors.some((e) => e.hard),
        errors,
        sanitized: {
            title: _title,              // Passed through unchanged
            description: sanitizedDescription,
            hashtags: sanitizedHashtags,
        },
    };
}

// ─── LinkedIn ─────────────────────────────────────────────────────────────────

const LI_LIMITS = {
    title: { max: 200 },
    description: { max: 3000 },
} as const;

export function validateLinkedInContent(
    title: string,
    description: string,
    hashtags: string[]
): PlatformValidationResult {
    const errors: ValidationError[] = [];

    let sanitizedTitle = title.trim();
    let sanitizedDescription = description.trim();

    if (sanitizedTitle.length > LI_LIMITS.title.max) {
        errors.push({
            field: "title",
            message: `LinkedIn title is ${sanitizedTitle.length} characters — maximum is ${LI_LIMITS.title.max}.`,
            hard: false,
        });
        sanitizedTitle = truncateAtWordBoundary(sanitizedTitle, LI_LIMITS.title.max);
    }

    if (sanitizedDescription.length > LI_LIMITS.description.max) {
        errors.push({
            field: "description",
            message: `LinkedIn description is ${sanitizedDescription.length} characters — maximum is ${LI_LIMITS.description.max}.`,
            hard: false,
        });
        sanitizedDescription = sanitizedDescription.slice(0, LI_LIMITS.description.max);
    }

    return {
        valid: !errors.some((e) => e.hard),
        errors,
        sanitized: {
            title: sanitizedTitle,
            description: sanitizedDescription,
            hashtags,
        },
    };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function truncateAtWordBoundary(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    // Find the last space before maxLen
    const truncated = text.slice(0, maxLen);
    const lastSpace = truncated.lastIndexOf(" ");
    return (lastSpace > maxLen * 0.5 ? truncated.slice(0, lastSpace) : truncated).trim();
}

export type ContentPillar =
    | "AI Full Stack Development"
    | "Generative AI & LLMs"
    | "RAG & LangGraph"
    | "AI Agents"
    | "Web Development"
    | "Coding Tutorial"
    | "Project Showcase"
    | "Developer Journey"
    | "BCA Placement"
    | "Freelancing & Clients"
    | "Software Career Education";

export interface AIContentAnalysis {
    pillar: ContentPillar;
    targetAudience: string;
    primaryKeyword: string;
    secondaryKeywords: string[];
    searchIntent?: "informational" | "tutorial" | "project_demo" | "career" | "inspiration";
    contentObjective: "education" | "project_demo" | "career_growth" | "authority";
    hookType: "problem_solution" | "technical_curiosity" | "case_study" | "contrarian" | "how_to";
    ctaType: "discussion" | "follow" | "github_repo" | "resource" | "save";
    // Extended analysis fields from the new engine
    topic?: string;
    problem?: string;
    contentAngle?: string;
    language?: string;
    contentType?: string;
}

export interface PlatformContent {
    title: string;
    description: string;
    hashtags: string[];
    seoScore?: number;       // 0-100 SEO quality score for this platform
    titleScore?: number;     // 0-100 title quality score (YouTube only)
    titleReason?: string;    // Why this title was selected
    hook?: string;           // Native hook for Instagram / LinkedIn
    strengths?: string[];    // What is already strong
    improvements?: string[]; // Actionable suggestions
}

export interface GenerateContentRequest {
    rawCaption: string;
    mediaType: "video" | "image";
    platforms: string[];
}

export interface EnhanceContentRequest {
    title: string;
    description: string;
    hashtags: string[];
    platforms: string[];
}

export interface AIContentResult {
    // Primary / Default (YouTube optimized, backward-compatible)
    title: string;
    description: string;
    hashtags: string[];

    // Advanced Strategy & Platform-Specific Generation
    analysis: AIContentAnalysis;
    platforms: {
        youtube: PlatformContent;
        instagram: PlatformContent;
        linkedin: PlatformContent;
    };

    // Global optimization feedback
    optimization?: {
        strengths: string[];
        improvements: string[];
    };
}

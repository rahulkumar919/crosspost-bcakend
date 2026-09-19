/**
 * Gemini AI Provider
 *
 * Adapter for Google Gemini via the Generative Language REST API.
 * Docs: https://ai.google.dev/api/generate-content
 *
 * Config (via env):
 *   GEMINI_API_KEY — Google AI Studio API key (required)
 *   GEMINI_MODEL   — Model ID (default: gemini-1.5-flash)
 */
import axios, { AxiosError } from "axios";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import type { AIProvider } from "./types";
import { AIProviderError } from "./AIError";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

interface GeminiContent {
    parts: { text: string }[];
    role: string;
}

interface GeminiRequestBody {
    contents: GeminiContent[];
    systemInstruction?: { parts: { text: string }[] };
    generationConfig: {
        temperature: number;
        maxOutputTokens: number;
        responseMimeType?: string;
    };
}

interface GeminiResponse {
    candidates: Array<{
        content: GeminiContent;
        finishReason: string;
    }>;
}

export class GeminiProvider implements AIProvider {
    readonly name = "gemini";

    async generate(
        prompt: string,
        systemPrompt: string,
        jsonMode = true
    ): Promise<string> {
        if (!env.GEMINI_API_KEY) {
            throw new AIProviderError(
                "GEMINI_API_KEY is not set. Add it to your .env file.",
                "UNREACHABLE",
                this.name
            );
        }

        const url = `${GEMINI_BASE_URL}/models/${env.GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;

        const body: GeminiRequestBody = {
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 4096,
                ...(jsonMode ? { responseMimeType: "application/json" } : {}),
            },
        };

        try {
            const res = await axios.post<GeminiResponse>(url, body, {
                headers: { "Content-Type": "application/json" },
                timeout: 15_000,
            });

            const candidate = res.data.candidates?.[0];
            if (!candidate?.content?.parts?.[0]?.text) {
                throw new AIProviderError(
                    "Gemini returned an empty response. Please try again.",
                    "INVALID_JSON",
                    this.name
                );
            }
            return candidate.content.parts[0].text;
        } catch (err) {
            if (err instanceof AIProviderError) throw err;

            if (axios.isAxiosError(err)) {
                const axErr = err as AxiosError;
                if (axErr.code === "ECONNREFUSED" || axErr.code === "ENOTFOUND") {
                    throw new AIProviderError("Gemini API is unreachable. Check your network.", "UNREACHABLE", this.name);
                }
                if (axErr.code === "ECONNABORTED" || axErr.message.includes("timeout")) {
                    throw new AIProviderError("Gemini request timed out. Please try again.", "TIMEOUT", this.name);
                }

                const status = axErr.response?.status;
                if (status === 400) {
                    logger.error("Gemini 400 — invalid request", { data: axErr.response?.data });
                    throw new AIProviderError("Gemini rejected the request (invalid input).", "MODEL_ERROR", this.name);
                }
                if (status === 401 || status === 403) {
                    throw new AIProviderError("Gemini API key is invalid or lacks permissions.", "UNREACHABLE", this.name);
                }
                if (status === 429) {
                    throw new AIProviderError("Gemini rate limit reached. Please wait a moment.", "TIMEOUT", this.name);
                }
                if (status && status >= 500) {
                    throw new AIProviderError("Gemini is experiencing issues. Please try again.", "MODEL_ERROR", this.name);
                }

                logger.error("Gemini HTTP error", { status, data: axErr.response?.data });
                throw new AIProviderError("Gemini returned an unexpected error.", "MODEL_ERROR", this.name);
            }
            throw err;
        }
    }

    async ping(): Promise<boolean> {
        if (!env.GEMINI_API_KEY) return false;
        try {
            await axios.get(
                `${GEMINI_BASE_URL}/models?key=${env.GEMINI_API_KEY}`,
                { timeout: 5000 }
            );
            return true;
        } catch {
            return false;
        }
    }
}

/**
 * Gemini AI client — uses Google's Generative AI REST API.
 *
 * Docs: https://ai.google.dev/api/generate-content
 * Model: gemini-1.5-flash (fast, free-tier friendly)
 *
 * Errors are mapped to the same OllamaError class for unified error handling
 * in ai.service.ts — the service only deals with UNREACHABLE / TIMEOUT / INVALID_JSON.
 */
import axios, { AxiosError } from "axios";
import { env } from "../config/env";
import { logger } from "./logger";
import { OllamaError } from "./ollama-client"; // Reuse error class for unified handling

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

interface GeminiContent {
    parts: { text: string }[];
    role: string;
}

interface GeminiCandidate {
    content: GeminiContent;
    finishReason: string;
}

interface GeminiResponse {
    candidates: GeminiCandidate[];
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

/**
 * Call Gemini and return the raw text response.
 * Maps network/API errors to OllamaError for unified handling in ai.service.ts.
 */
export async function geminiGenerate(
    prompt: string,
    systemPrompt: string,
    /** If true, instruct Gemini to respond with JSON */
    jsonMode = true
): Promise<string> {
    if (!env.GEMINI_API_KEY) {
        throw new OllamaError(
            "GEMINI_API_KEY is not set. Add it to your .env file.",
            "UNREACHABLE"
        );
    }

    const url = `${GEMINI_BASE_URL}/models/${env.GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;

    const body: GeminiRequestBody = {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 2048,
            // Tell Gemini to return JSON when requested (supported in gemini-1.5+)
            ...(jsonMode ? { responseMimeType: "application/json" } : {}),
        },
    };

    try {
        const res = await axios.post<GeminiResponse>(url, body, {
            headers: { "Content-Type": "application/json" },
            timeout: 30_000, // 30 seconds — Gemini is fast
        });

        const candidate = res.data.candidates?.[0];
        if (!candidate?.content?.parts?.[0]?.text) {
            throw new OllamaError(
                "Gemini returned an empty response. Please try again.",
                "INVALID_JSON"
            );
        }

        return candidate.content.parts[0].text;
    } catch (err) {
        if (err instanceof OllamaError) throw err;

        if (axios.isAxiosError(err)) {
            const axiosErr = err as AxiosError;

            if (axiosErr.code === "ECONNREFUSED" || axiosErr.code === "ENOTFOUND") {
                throw new OllamaError("Gemini API is unreachable. Check your network.", "UNREACHABLE");
            }

            if (axiosErr.code === "ECONNABORTED" || axiosErr.message.includes("timeout")) {
                throw new OllamaError("Gemini request timed out. Please try again.", "TIMEOUT");
            }

            const status = axiosErr.response?.status;

            if (status === 400) {
                logger.error("Gemini API 400 — invalid request", {
                    data: axiosErr.response?.data,
                });
                throw new OllamaError(
                    "Gemini rejected the request (invalid input). Please try again.",
                    "MODEL_ERROR"
                );
            }

            if (status === 401 || status === 403) {
                throw new OllamaError(
                    "Gemini API key is invalid or lacks permissions. Check GEMINI_API_KEY.",
                    "UNREACHABLE"
                );
            }

            if (status === 429) {
                throw new OllamaError(
                    "Gemini rate limit reached. Please wait a moment and try again.",
                    "TIMEOUT"
                );
            }

            if (status && status >= 500) {
                throw new OllamaError(
                    "Gemini is experiencing issues. Please try again shortly.",
                    "MODEL_ERROR"
                );
            }

            logger.error("Gemini HTTP error", { status, data: axiosErr.response?.data });
            throw new OllamaError("Gemini returned an unexpected error.", "MODEL_ERROR");
        }

        throw err;
    }
}

/** Quick ping to verify the Gemini API key is valid */
export async function pingGemini(): Promise<boolean> {
    if (!env.GEMINI_API_KEY) return false;
    try {
        // Lightweight call — list models
        await axios.get(
            `${GEMINI_BASE_URL}/models?key=${env.GEMINI_API_KEY}`,
            { timeout: 5000 }
        );
        return true;
    } catch {
        return false;
    }
}

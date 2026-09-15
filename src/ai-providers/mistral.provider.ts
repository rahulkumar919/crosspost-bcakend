/**
 * Mistral AI Provider
 *
 * Adapter for Mistral AI via their OpenAI-compatible Chat Completions API.
 * Docs: https://docs.mistral.ai/api/
 * API:  https://api.mistral.ai/v1/chat/completions
 *
 * Config (via env):
 *   MISTRAL_API_KEY    — Mistral platform API key (required)
 *   MISTRAL_MODEL      — Model ID (default: mistral-small-latest)
 *   MISTRAL_TIMEOUT_MS — Request timeout in ms (default: 30000)
 *
 * Supported models (as of 2025):
 *   mistral-small-latest    — Fast, efficient, good for structured output
 *   mistral-medium-latest   — Balanced quality / speed
 *   mistral-large-latest    — Highest quality (slowest)
 *   open-mistral-7b         — Open-weight, self-hostable alternative
 *   open-mixtral-8x7b       — Open-weight MoE model
 *
 * JSON mode: uses `response_format: { type: "json_object" }` when jsonMode=true.
 * This is natively supported by all Mistral Instruct models.
 */
import axios, { AxiosError } from "axios";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import type { AIProvider } from "./types";
import { AIProviderError } from "./AIError";

const MISTRAL_BASE_URL = "https://api.mistral.ai/v1";

interface MistralMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

interface MistralRequestBody {
    model: string;
    messages: MistralMessage[];
    temperature?: number;
    max_tokens?: number;
    response_format?: { type: "text" | "json_object" };
}

interface MistralResponseChoice {
    message: {
        role: string;
        content: string;
    };
    finish_reason: string;
}

interface MistralResponse {
    id: string;
    choices: MistralResponseChoice[];
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

export class MistralProvider implements AIProvider {
    readonly name = "mistral";

    async generate(
        prompt: string,
        systemPrompt: string,
        jsonMode = true
    ): Promise<string> {
        if (!env.MISTRAL_API_KEY) {
            throw new AIProviderError(
                "MISTRAL_API_KEY is not set. Add it to your .env file. Get a key at: https://console.mistral.ai/",
                "UNREACHABLE",
                this.name
            );
        }

        const body: MistralRequestBody = {
            model: env.MISTRAL_MODEL,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user",   content: prompt },
            ],
            temperature: 0.7,
            max_tokens: 2048,
            // Mistral's native JSON mode — forces valid JSON output
            ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
        };

        try {
            const res = await axios.post<MistralResponse>(
                `${MISTRAL_BASE_URL}/chat/completions`,
                body,
                {
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${env.MISTRAL_API_KEY}`,
                    },
                    timeout: env.MISTRAL_TIMEOUT_MS,
                }
            );

            const content = res.data.choices?.[0]?.message?.content;
            if (!content) {
                throw new AIProviderError(
                    "Mistral returned an empty response. Please try again.",
                    "INVALID_JSON",
                    this.name
                );
            }

            logger.debug("Mistral response received", {
                model: env.MISTRAL_MODEL,
                finishReason: res.data.choices?.[0]?.finish_reason,
                tokensUsed: res.data.usage?.total_tokens,
            });

            return content;
        } catch (err) {
            if (err instanceof AIProviderError) throw err;

            if (axios.isAxiosError(err)) {
                const axErr = err as AxiosError;

                if (axErr.code === "ECONNREFUSED" || axErr.code === "ENOTFOUND") {
                    throw new AIProviderError(
                        "Mistral API is unreachable. Check your network connection.",
                        "UNREACHABLE",
                        this.name
                    );
                }

                if (axErr.code === "ECONNABORTED" || axErr.message.includes("timeout")) {
                    throw new AIProviderError(
                        `Mistral request timed out after ${env.MISTRAL_TIMEOUT_MS}ms. Try a smaller model or increase MISTRAL_TIMEOUT_MS.`,
                        "TIMEOUT",
                        this.name
                    );
                }

                const status = axErr.response?.status;

                if (status === 400) {
                    logger.error("Mistral 400 — invalid request", { data: axErr.response?.data });
                    throw new AIProviderError(
                        "Mistral rejected the request. Check that the model supports JSON mode.",
                        "MODEL_ERROR",
                        this.name
                    );
                }

                if (status === 401) {
                    throw new AIProviderError(
                        "Mistral API key is invalid. Check MISTRAL_API_KEY in your .env file.",
                        "UNREACHABLE",
                        this.name
                    );
                }

                if (status === 422) {
                    throw new AIProviderError(
                        "Mistral rejected the request parameters (unprocessable entity).",
                        "MODEL_ERROR",
                        this.name
                    );
                }

                if (status === 429) {
                    throw new AIProviderError(
                        "Mistral rate limit reached. Please wait a moment and try again.",
                        "TIMEOUT",
                        this.name
                    );
                }

                if (status && status >= 500) {
                    throw new AIProviderError(
                        "Mistral is experiencing server issues. Please try again shortly.",
                        "MODEL_ERROR",
                        this.name
                    );
                }

                logger.error("Mistral HTTP error", { status, data: axErr.response?.data });
                throw new AIProviderError(
                    "Mistral returned an unexpected error.",
                    "MODEL_ERROR",
                    this.name
                );
            }

            throw err;
        }
    }

    async ping(): Promise<boolean> {
        if (!env.MISTRAL_API_KEY) return false;
        try {
            // Lightweight call — list available models
            await axios.get(`${MISTRAL_BASE_URL}/models`, {
                headers: { Authorization: `Bearer ${env.MISTRAL_API_KEY}` },
                timeout: 5000,
            });
            return true;
        } catch {
            return false;
        }
    }
}

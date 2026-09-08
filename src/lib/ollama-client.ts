/**
 * Thin HTTP client for Ollama's REST API.
 * The host is fully configurable via OLLAMA_BASE_URL — never hardcoded.
 * Automatically resolves and fallbacks to installed local models if the configured model is missing.
 */
import axios, { AxiosError } from "axios";
import { env } from "../config/env";
import { logger } from "./logger";

export class OllamaError extends Error {
    constructor(
        message: string,
        public readonly kind: "UNREACHABLE" | "TIMEOUT" | "INVALID_JSON" | "MODEL_ERROR"
    ) {
        super(message);
        this.name = "OllamaError";
    }
}

interface OllamaGeneratePayload {
    model: string;
    prompt: string;
    system?: string;
    stream: false;
    format?: "json";
    options?: Record<string, unknown>;
}

interface OllamaGenerateResponse {
    response: string;
    done: boolean;
}

let resolvedModel: string | null = null;

/** Find a valid installed completion model if the configured one fails */
async function resolveInstalledModel(): Promise<string | null> {
    try {
        const res = await axios.get<{ models: { name: string; capabilities?: string[] }[] }>(
            `${env.OLLAMA_BASE_URL}/api/tags`,
            { timeout: 5000 }
        );
        const models = res.data?.models || [];
        // Filter for completion/generation models (ignore embed-only models)
        const candidates = models.filter((m) => !m.name.includes("embed"));
        if (candidates.length > 0) {
            // Prefer llama3.2, llama3, llama models
            const preferred = candidates.find((m) => m.name.includes("llama")) || candidates[0];
            return preferred.name;
        }
    } catch {
        // Ignore resolution errors
    }
    return null;
}

export async function ollamaGenerate(
    prompt: string,
    systemPrompt: string,
    /** Pass true to tell Ollama to enforce JSON mode (supported in newer builds) */
    jsonMode = true
): Promise<string> {
    const targetModel = resolvedModel || env.OLLAMA_MODEL;

    const payload: OllamaGeneratePayload = {
        model: targetModel,
        prompt,
        system: systemPrompt,
        stream: false,
        ...(jsonMode ? { format: "json" } : {}),
    };

    try {
        const response = await axios.post<OllamaGenerateResponse>(
            `${env.OLLAMA_BASE_URL}/api/generate`,
            payload,
            {
                timeout: env.OLLAMA_TIMEOUT_MS,
                headers: { "Content-Type": "application/json" },
            }
        );

        resolvedModel = targetModel;
        return response.data.response;
    } catch (err) {
        if (axios.isAxiosError(err)) {
            const axiosErr = err as AxiosError;
            if (axiosErr.code === "ECONNREFUSED" || axiosErr.code === "ENOTFOUND") {
                throw new OllamaError(
                    `Ollama is unreachable at ${env.OLLAMA_BASE_URL}. Is the server running?`,
                    "UNREACHABLE"
                );
            }
            if (axiosErr.code === "ECONNABORTED" || axiosErr.message.includes("timeout")) {
                throw new OllamaError(
                    `Ollama inference timed out after ${env.OLLAMA_TIMEOUT_MS}ms. Try a smaller model or increase OLLAMA_TIMEOUT_MS.`,
                    "TIMEOUT"
                );
            }

            // If 404 (model not found), attempt auto-fallback to an installed model
            if (axiosErr.response?.status === 404) {
                logger.warn(`Configured Ollama model '${targetModel}' not found. Searching for installed models...`);
                const fallbackModel = await resolveInstalledModel();
                if (fallbackModel && fallbackModel !== targetModel) {
                    logger.info(`Switching to installed Ollama model '${fallbackModel}'`);
                    resolvedModel = fallbackModel;
                    return ollamaGenerate(prompt, systemPrompt, jsonMode);
                }
            }

            logger.error("Ollama HTTP error", {
                status: axiosErr.response?.status,
                data: axiosErr.response?.data,
            });
            throw new OllamaError("Ollama returned an unexpected error", "MODEL_ERROR");
        }
        throw err;
    }
}

/** Ping Ollama — used by /health */
export async function pingOllama(): Promise<boolean> {
    try {
        await axios.get(`${env.OLLAMA_BASE_URL}/api/tags`, { timeout: 3000 });
        return true;
    } catch {
        return false;
    }
}

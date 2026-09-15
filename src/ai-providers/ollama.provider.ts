/**
 * Ollama AI Provider
 *
 * Adapter for self-hosted Ollama (https://ollama.ai).
 * Connects to a local or remote Ollama HTTP server.
 *
 * Config (via env):
 *   OLLAMA_BASE_URL   — Ollama server URL  (default: http://localhost:11434)
 *   OLLAMA_MODEL      — Model tag          (default: llama3.2:latest)
 *   OLLAMA_TIMEOUT_MS — Request timeout ms (default: 45000)
 *
 * Auto-fallback: if the configured model is not installed, automatically
 * discovers and switches to the first available completion model.
 */
import axios, { AxiosError } from "axios";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import type { AIProvider } from "./types";
import { AIProviderError } from "./AIError";

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

export class OllamaProvider implements AIProvider {
    readonly name = "ollama";

    /** Cached model name after first successful call or fallback resolution */
    private resolvedModel: string | null = null;

    async generate(
        prompt: string,
        systemPrompt: string,
        jsonMode = true
    ): Promise<string> {
        const targetModel = this.resolvedModel ?? env.OLLAMA_MODEL;

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
            this.resolvedModel = targetModel;
            return response.data.response;
        } catch (err) {
            if (axios.isAxiosError(err)) {
                const axErr = err as AxiosError;

                if (axErr.code === "ECONNREFUSED" || axErr.code === "ENOTFOUND") {
                    throw new AIProviderError(
                        `Ollama is unreachable at ${env.OLLAMA_BASE_URL}. Is the server running?`,
                        "UNREACHABLE",
                        this.name
                    );
                }
                if (axErr.code === "ECONNABORTED" || axErr.message.includes("timeout")) {
                    throw new AIProviderError(
                        `Ollama inference timed out after ${env.OLLAMA_TIMEOUT_MS}ms. Try a smaller model or increase OLLAMA_TIMEOUT_MS.`,
                        "TIMEOUT",
                        this.name
                    );
                }

                // 404 = model not found → attempt auto-fallback to any installed model
                if (axErr.response?.status === 404) {
                    logger.warn(`Ollama model '${targetModel}' not found. Searching for installed models…`);
                    const fallback = await this.resolveInstalledModel();
                    if (fallback && fallback !== targetModel) {
                        logger.info(`Switching to installed Ollama model '${fallback}'`);
                        this.resolvedModel = fallback;
                        return this.generate(prompt, systemPrompt, jsonMode);
                    }
                }

                logger.error("Ollama HTTP error", {
                    status: axErr.response?.status,
                    data: axErr.response?.data,
                });
                throw new AIProviderError("Ollama returned an unexpected error", "MODEL_ERROR", this.name);
            }
            throw err;
        }
    }

    async ping(): Promise<boolean> {
        try {
            await axios.get(`${env.OLLAMA_BASE_URL}/api/tags`, { timeout: 3000 });
            return true;
        } catch {
            return false;
        }
    }

    /** Find a valid installed completion model if the configured one fails */
    private async resolveInstalledModel(): Promise<string | null> {
        try {
            const res = await axios.get<{ models: { name: string }[] }>(
                `${env.OLLAMA_BASE_URL}/api/tags`,
                { timeout: 5000 }
            );
            const models = (res.data?.models ?? []).filter((m) => !m.name.includes("embed"));
            if (models.length > 0) {
                const preferred = models.find((m) => m.name.includes("llama")) ?? models[0];
                return preferred.name;
            }
        } catch {
            // Ignore resolution errors
        }
        return null;
    }
}

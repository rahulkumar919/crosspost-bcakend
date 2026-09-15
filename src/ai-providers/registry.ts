/**
 * AI Provider Registry
 *
 * Exclusively powers CrossPost AI via Google Gemini and Mistral AI.
 * Ollama has been removed per architecture guidelines.
 *
 * Features:
 * - Direct Gemini & Mistral integration
 * - Intelligent Auto-Failover: if the primary provider runs out of quota or
 *   experiences a temporary outage, it automatically switches to the secondary provider
 *   if configured.
 * - Zero-latency missing key detection (fails in 0ms instead of timing out for 30s).
 */
import { env } from "../config/env";
import { logger } from "../lib/logger";
import type { AIProvider } from "./types";
import { GeminiProvider } from "./gemini.provider";
import { MistralProvider } from "./mistral.provider";
import { AIProviderError } from "./AIError";

const geminiInstance = new GeminiProvider();
const mistralInstance = new MistralProvider();

export const PROVIDERS: Record<string, AIProvider> = {
    gemini: geminiInstance,
    mistral: mistralInstance,
};

/**
 * Composite provider that handles seamless failover between Gemini and Mistral.
 */
class SmartDualProvider implements AIProvider {
    readonly name = "smart-dual";

    private getPrimaryAndFallback(): [AIProvider, AIProvider | null] {
        const preferred = env.AI_PROVIDER === "mistral" ? mistralInstance : geminiInstance;
        const fallback = env.AI_PROVIDER === "mistral" ? geminiInstance : mistralInstance;

        // If preferred has key, try it first
        const preferredHasKey = preferred.name === "gemini" ? !!env.GEMINI_API_KEY : !!env.MISTRAL_API_KEY;
        const fallbackHasKey = fallback.name === "gemini" ? !!env.GEMINI_API_KEY : !!env.MISTRAL_API_KEY;

        if (preferredHasKey) {
            return [preferred, fallbackHasKey ? fallback : null];
        } else if (fallbackHasKey) {
            logger.info(`Primary AI provider '${preferred.name}' has no key set, auto-routing to '${fallback.name}'`);
            return [fallback, null];
        }

        // Neither key is configured
        return [preferred, null];
    }

    async generate(prompt: string, systemPrompt: string, jsonMode = true): Promise<string> {
        const [primary, fallback] = this.getPrimaryAndFallback();

        const primaryHasKey = primary.name === "gemini" ? !!env.GEMINI_API_KEY : !!env.MISTRAL_API_KEY;
        if (!primaryHasKey) {
            throw new AIProviderError(
                "Neither GEMINI_API_KEY nor MISTRAL_API_KEY is configured in backend .env.",
                "UNREACHABLE",
                primary.name
            );
        }

        try {
            logger.debug(`Calling primary AI provider: ${primary.name}`);
            return await primary.generate(prompt, systemPrompt, jsonMode);
        } catch (primaryErr) {
            if (fallback) {
                logger.warn(`Primary provider '${primary.name}' failed — failing over to '${fallback.name}'`, {
                    error: primaryErr instanceof Error ? primaryErr.message : String(primaryErr),
                });
                try {
                    return await fallback.generate(prompt, systemPrompt, jsonMode);
                } catch (fallbackErr) {
                    logger.error(`Both AI providers (${primary.name}, ${fallback.name}) failed.`, {
                        primaryError: primaryErr instanceof Error ? primaryErr.message : String(primaryErr),
                        fallbackError: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
                    });
                    throw fallbackErr;
                }
            }
            throw primaryErr;
        }
    }

    async ping(): Promise<boolean> {
        if (env.GEMINI_API_KEY && (await geminiInstance.ping())) return true;
        if (env.MISTRAL_API_KEY && (await mistralInstance.ping())) return true;
        return false;
    }
}

const smartDualProvider = new SmartDualProvider();

/**
 * Returns the active AIProvider instance.
 * Uses smart dual routing (Gemini <-> Mistral failover).
 */
export function getProvider(): AIProvider {
    return smartDualProvider;
}

/**
 * Returns the names of all supported providers.
 */
export function getRegisteredProviderNames(): string[] {
    return Object.keys(PROVIDERS);
}

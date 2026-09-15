/**
 * Core AI Provider interface.
 *
 * Every AI adapter (Ollama, Gemini, Mistral, OpenAI, …) MUST implement this
 * contract. The rest of the application (ai.service.ts, health.routes.ts)
 * only ever depends on this interface — never on a concrete adapter.
 *
 * To add a new provider:
 *   1. Create `src/ai-providers/<name>.provider.ts` implementing AIProvider
 *   2. Register it in `registry.ts`
 *   3. Add `"<name>"` to `AI_PROVIDER` enum in `config/env.ts`
 *   4. Set `AI_PROVIDER=<name>` in `.env`
 */
export interface AIProvider {
    /**
     * Stable identifier for this provider.
     * Must match the value used in `AI_PROVIDER` env var and the registry key.
     * Example: "ollama" | "gemini" | "mistral"
     */
    readonly name: string;

    /**
     * Send a prompt to the AI model and return the raw text response.
     *
     * @param prompt       - The user/task prompt
     * @param systemPrompt - The system-level instruction
     * @param jsonMode     - When true, instruct the model to respond with valid JSON
     * @returns            Raw string response from the model
     * @throws             AIProviderError on all failure modes
     */
    generate(
        prompt: string,
        systemPrompt: string,
        jsonMode?: boolean
    ): Promise<string>;

    /**
     * Lightweight connectivity check — returns true if the provider is
     * reachable and authenticated, false otherwise.
     * Must never throw; all errors should be swallowed and return false.
     */
    ping(): Promise<boolean>;
}

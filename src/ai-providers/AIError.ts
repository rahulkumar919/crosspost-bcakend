/**
 * Shared error class for all AI providers.
 *
 * Replaces the old `OllamaError` which was incorrectly reused in
 * gemini-client.ts. All provider adapters now throw `AIProviderError` so
 * ai.service.ts can handle errors uniformly without knowing which
 * provider is active.
 */
export type AIErrorKind =
    | "UNREACHABLE"   // Provider endpoint not reachable / API key missing
    | "TIMEOUT"       // Request timed out / rate limited
    | "INVALID_JSON"  // Model returned non-JSON when JSON was expected
    | "MODEL_ERROR";  // Any other model-level error (bad input, 5xx, etc.)

export class AIProviderError extends Error {
    public readonly kind: AIErrorKind;
    public readonly provider?: string;

    constructor(message: string, kind: AIErrorKind, provider?: string) {
        super(message);
        this.name = "AIProviderError";
        this.kind = kind;
        this.provider = provider;
    }
}

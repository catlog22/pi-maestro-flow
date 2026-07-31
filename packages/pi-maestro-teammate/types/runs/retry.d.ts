export declare const NETWORK_RETRY_POLICY: Readonly<{
    maxRetries: 10;
    initialDelayMs: 1000;
    maxDelayMs: 16000;
}>;
export type RetryErrorKind = "network" | "provider" | "fallback-only" | "non-retryable";
export declare function classifyRetryError(message: string | undefined): RetryErrorKind;
export declare function isRetryableProviderError(message: string | undefined): boolean;
export declare function isFallbackProviderError(message: string | undefined): boolean;
export declare function retryDelayMs(retry: number): number;

/**
 * JEV HTTP client — the single transport boundary for the unified classifier.
 *
 * Two endpoints are supported:
 * - `typesafe`:   POST https://api.typesafe.ai/v1/systemone
 *                 (Authorization: Bearer $TYPESAFE_API_KEY, model `jev-latest`)
 * - `openrouter`: POST https://openrouter.ai/api/alpha/decisions
 *                 (Authorization: Bearer $OPENROUTER_API_KEY, model `typesafe/jev-1.13`)
 *
 * The client validates the response shape against the requested question
 * types — a malformed answer fails the call so the engine can fall back.
 */
import type { AuthOperationOptions, ClassifierApi, ClassifierContext, ClassifierModel, ClassifierResult, ModelsClassifierOptions } from "@earendil-works/pi-ai";
import type { JevQuestions, JevRequest, JevResponse } from "./types.ts";
export type JevEndpoint = "typesafe" | "openrouter";
export declare const JEV_ENDPOINT_URLS: Record<JevEndpoint, string>;
export declare const JEV_DEFAULT_MODELS: Record<JevEndpoint, string>;
export declare const JEV_API_KEY_ENVS: Record<JevEndpoint, string>;
export declare const JEV_DEFAULT_TIMEOUT_MS = 4000;
export interface JevClientOptions {
    endpoint: JevEndpoint;
    apiKey: string;
    model?: string;
    baseUrl?: string;
    timeoutMs?: number;
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
}
export interface JevClient {
    decide(request: Omit<JevRequest, "model">): Promise<JevResponse>;
}
interface PreparedJevDecision {
    identity: string;
    decide(): Promise<JevResponse>;
}
/** @internal Resolve the effective transport/model before looking in the cache. */
export declare function prepareJevDecision(client: JevClient, request: Omit<JevRequest, "model">): Promise<PreparedJevDecision>;
/** Parse the top-level response; every requested question must have a valid answer. */
export declare function parseJevResponse(payload: unknown, questions: JevQuestions): JevResponse | undefined;
export interface ClassifierRuntime {
    getAvailableOfType(type: "classifier", provider?: string, options?: AuthOperationOptions): Promise<readonly ClassifierModel<ClassifierApi>[]>;
    getModelOfType(type: "classifier", provider: string, id: string): ClassifierModel<ClassifierApi> | undefined;
    classify(model: ClassifierModel<ClassifierApi>, context: ClassifierContext, options?: ModelsClassifierOptions): Promise<ClassifierResult>;
}
export declare function createNativeJevClient(runtime: ClassifierRuntime, options: Pick<JevClientOptions, "endpoint" | "model" | "timeoutMs">): JevClient;
export declare function createJevClient(options: JevClientOptions): JevClient;
/** Pick an endpoint from an explicit choice, or infer from which API key env exists. */
export declare function resolveJevEndpoint(preferred: JevEndpoint | undefined, env?: Record<string, string | undefined>): {
    endpoint: JevEndpoint;
    apiKey: string;
} | undefined;
export {};

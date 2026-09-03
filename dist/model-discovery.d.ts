import type { RefreshModelsContext } from "@earendil-works/pi-ai";
export interface ModelCostRates {
    /** USD per 1 million tokens. */
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}
export interface ModelCostTier extends ModelCostRates {
    /** Apply this rate set when total input usage exceeds this token count. */
    inputTokensAbove: number;
}
export interface ModelCost extends ModelCostRates {
    tiers?: ModelCostTier[];
}
export interface DiscoveredModel {
    id: string;
    name: string;
    reasoning: boolean;
    input: ("text" | "image")[];
    cost: ModelCost;
    contextWindow: number;
    maxTokens: number;
}
/**
 * Official Google Agent Platform equivalent rates, in USD per 1M tokens.
 * Antigravity's Pro/Ultra baseline quota is subscription-based, so these
 * values are only an equivalent estimate for Pi's cost display; they are not
 * a charge made to the user's account.
 */
export declare function officialCostForModel(modelId: string): ModelCost;
export declare const BASELINE_MODELS: DiscoveredModel[];
export declare function getCacheFilePath(): string;
export declare function loadCachedModels(): DiscoveredModel[];
export declare function saveCachedModels(models: DiscoveredModel[]): void;
export declare function queryAntigravityModels(accessToken: string, refreshToken: string, signal?: AbortSignal): Promise<DiscoveredModel[]>;
export declare function fetchAntigravityModels(context: RefreshModelsContext): Promise<DiscoveredModel[]>;

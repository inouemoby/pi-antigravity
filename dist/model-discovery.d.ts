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
export declare function emptyModelCost(): ModelCost;
/**
 * Read the current official Agent Platform pricing page. Antigravity's
 * subscription quota itself is not a dollar bill; these rates are only used
 * for Pi's equivalent cost estimate. No numeric prices are embedded here.
 */
export declare function fetchOfficialModelPricing(signal?: AbortSignal): Promise<Map<string, ModelCost>>;
export declare const BASELINE_MODELS: DiscoveredModel[];
export declare function getCacheFilePath(): string;
export declare function mergeModels(discovered: DiscoveredModel[], pricing?: Map<string, ModelCost>): DiscoveredModel[];
export declare function loadCachedModels(): DiscoveredModel[];
export declare function saveCachedModels(models: DiscoveredModel[]): void;
export declare function queryAntigravityModels(accessToken: string, refreshToken: string, signal?: AbortSignal): Promise<DiscoveredModel[]>;
export declare function fetchAntigravityModels(context: RefreshModelsContext): Promise<DiscoveredModel[]>;

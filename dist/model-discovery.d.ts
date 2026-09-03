import type { RefreshModelsContext } from "@earendil-works/pi-ai";
export interface DiscoveredModel {
    id: string;
    name: string;
    reasoning: boolean;
    input: ("text" | "image")[];
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    };
    contextWindow: number;
    maxTokens: number;
}
export declare const BASELINE_MODELS: DiscoveredModel[];
export declare function getCacheFilePath(): string;
export declare function loadCachedModels(): DiscoveredModel[];
export declare function saveCachedModels(models: DiscoveredModel[]): void;
export declare function queryAntigravityModels(accessToken: string, refreshToken: string, signal?: AbortSignal): Promise<DiscoveredModel[]>;
export declare function fetchAntigravityModels(context: RefreshModelsContext): Promise<DiscoveredModel[]>;

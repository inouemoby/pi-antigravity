import type { RefreshModelsContext } from "@earendil-works/pi-ai";
export declare function fetchAntigravityModels(context: RefreshModelsContext): Promise<{
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
}[]>;

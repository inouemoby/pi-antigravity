import type { Context } from "@earendil-works/pi-ai";
type GeminiPart = {
    text: string;
    thought?: boolean;
    thoughtSignature?: string;
} | {
    inlineData: {
        mimeType: string;
        data: string;
    };
} | {
    functionCall: {
        name: string;
        args: Record<string, unknown>;
        id: string;
    };
    thoughtSignature?: string;
} | {
    functionResponse: {
        name: string;
        response: Record<string, unknown>;
        id: string;
    };
};
type GeminiContent = {
    role: "user" | "model";
    parts: GeminiPart[];
};
type GeminiTool = {
    functionDeclarations: Array<{
        name: string;
        description: string;
        parameters?: unknown;
    }>;
};
export interface GeminiRequest {
    contents: GeminiContent[];
    tools?: GeminiTool[];
    systemInstruction?: {
        parts: GeminiPart[];
    };
    generationConfig?: Record<string, unknown>;
}
export declare function buildGeminiRequest(context: Context, target?: {
    provider?: string;
    model?: string;
}): GeminiRequest;
export {};

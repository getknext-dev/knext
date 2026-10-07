export type AssetAnchorConsumer = "read" | "excluded" | "unknown";

export interface AssetAnchorAnalysis {
    anchors: { literal: string; start: number; end: number; consumer: AssetAnchorConsumer }[];
    parseError?: string;
}

export function analyzeAssetAnchors(src: string): AssetAnchorAnalysis;

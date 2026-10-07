export type AssetAnchorConsumer = "read" | "excluded" | "unknown";

export interface AssetAnchorAnalysis {
    anchors: {
        literal: string;
        start: number;
        end: number;
        consumer: AssetAnchorConsumer;
        /** Unknown anchors only: why the URL was not recognised as a read. */
        reason?: string;
    }[];
    parseError?: string;
}

export function analyzeAssetAnchors(src: string): AssetAnchorAnalysis;

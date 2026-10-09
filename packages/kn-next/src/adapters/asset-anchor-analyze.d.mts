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

export function findImportMetaUses(src: string): {
    /**
     * `alias` (bare uses only): true when the use is `X = import.meta` and X
     * is provably read solely via .url/.filename/.dirname.
     */
    uses: { start: number; end: number; prop: string | null; alias?: boolean }[];
    parseError?: string;
};

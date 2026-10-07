export function assetAnchorPackageRoot(modulePath: string): string | undefined;

export function findAssetAnchors(src: string): { literal: string }[];

export function hasAssetAnchorCandidate(src: string): boolean;

export function rewriteVinextHarfbuzzAnchors(
    src: string,
    urlExpr: string,
): { contents: string; count: number };

export function rewriteEntryHarfbuzzAnchors(
    src: string,
    resolve: () => string | undefined,
): { contents: string; assets: { id: string; absPath: string }[] };

export function rewriteAssetAnchors(
    src: string,
    modulePath: string,
    resolve: (literal: string) => string | undefined,
    resolveLocateFile?: (name: string) => string | undefined,
    analyze?: (src: string) => {
        anchors: { literal: string; start: number; end: number; consumer: string }[];
        parseError?: string;
    },
): { contents: string; assets: { id: string; absPath: string }[]; parseError?: string };

export function isAllowlistedAssetAnchorModule(modulePath: string): boolean;

export function allowlistedPackageRoot(modulePath: string): string | undefined;

export function findAssetAnchors(src: string): { literal: string }[];

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
):{ contents: string; assets: { id: string; absPath: string }[] };

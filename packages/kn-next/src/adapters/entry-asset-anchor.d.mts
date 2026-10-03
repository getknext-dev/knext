export function isAllowlistedAssetAnchorModule(modulePath: string): boolean;

export function allowlistedPackageRoot(modulePath: string): string | undefined;

export function findAssetAnchors(src: string): { literal: string }[];

export function rewriteAssetAnchors(
    src: string,
    modulePath: string,
    resolve: (literal: string) => string | undefined,
): { contents: string; assets: { id: string; absPath: string }[] };

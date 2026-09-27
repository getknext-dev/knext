// Declarations for standalone-embed.mjs (dependency-free .mjs so the bun-run
// compile script bundles it; this .d.mts exists for the TS tests).

export declare const EMBED_ROOT_GLOBAL: string;

export declare function classifyDistFiles(
    relFiles: readonly string[],
    opts?: { edgeFiles?: Iterable<string> },
): { modules: string[]; assets: string[]; disk: string[]; unknownKinds: string[] };

export declare function middlewareManifestFiles(manifest: unknown): string[];

export declare function relativeSpecifier(fromRel: string, toRel: string): string;

export declare function rebindDirnameSource(src: string, embeddedRel: string): string;

export declare function installDistDirAlias(
    fs: Record<string, unknown>,
    fsp: Record<string, unknown>,
    aliases: Record<string, string>,
): (p: unknown) => unknown;

export declare function installEmbeddedJsonRequire(
    Module: unknown,
    fs: unknown,
    root: string,
): void;

export declare function rewriteExternalAliases(
    src: string,
    aliases: ReadonlyMap<string, string>,
): { source: string; rewritten: number; unresolvedSubpaths: string[] };

// Declarations for standalone-exec-entry.mjs (dependency-free .mjs so the
// bun-run compile script bundles it; this .d.mts exists for the TS tests,
// which import it with implicit-any off).

/** The binding the re-anchored entry uses in place of `__dirname`. */
export declare const STANDALONE_DIR_BINDING: string;

/**
 * Turn Next's generated `server.js` (CommonJS or the ESM variant) into the
 * CommonJS entry the compiled standalone executable is built from. Throws on
 * any shape it does not recognise.
 */
export declare function standaloneExecEntrySource(
    serverSrc: string,
    preloads: readonly string[],
    opts?: {
        /** Self-contained mode: point `distDir` into the executable. */
        selfContained?: {
            appRel: string;
            distDir?: string;
            extensionless?: readonly string[];
        };
    },
): string;

/**
 * Every cache handler Next loads by computed path (`cacheHandler` and each
 * `cacheHandlers` entry; never the Next-16-removed
 * `experimental.incrementalCacheHandlerPath`), as absolute paths resolved the
 * way Next resolves them. Throws when `server.js`
 * carries no inlined `nextConfig`.
 */
export declare function standaloneCacheHandlerFiles(
    serverSrc: string,
    serverDir: string,
): string[];

/** Source of the throw-on-use stub Next's dev-only modules compile against. */
export declare const DEV_ONLY_STUB_SOURCE: string;

/** `name` + `./subpath` of a bare specifier. */
export declare function splitBareSpecifier(spec: string): {
    name: string;
    subpath: string;
};

/** Resolve a package `exports` field for `subpath` under Node's conditions. */
export declare function resolveExportsUnderNode(
    exportsField: unknown,
    subpath: string,
): string | undefined;

/**
 * Resolve `spec` the way disk-loaded CJS code requires it: the `require`
 * export condition first, falling back to the ESM/`default` condition. Throws
 * an `Error` naming both attempts' failures when neither resolves.
 */
export declare function resolveRequireLike(spec: string, fromDir: string): string;

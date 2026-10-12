/**
 * The CDN routing artifact (ADR-0068 D4.1 condition 10): `knext-cdn-routing.json`.
 *
 * The CDN header preload must know whether the app's middleware/`proxy` matcher
 * covers a path, because a CDN ignores cookies: a statically rendered page that
 * session-cookie middleware protects would otherwise be stored at the edge after
 * an authenticated request and served to anonymous visitors. The matchers are not
 * read from Next's internal build manifests (not a contract, so reading them is
 * reverse-engineering). They come from the OFFICIAL adapter API: `onBuildComplete`
 * hands knext `outputs.middleware` (present only when the app has a
 * middleware/`proxy` file; `config.matchers` is `{ source, sourceRegex, has,
 * missing }[]`) and `ctx.config` (`basePath`, `i18n`).
 *
 * This module turns that into a knext-owned file that ALWAYS exists after a build:
 *
 *     { "version": 1, "basePath": "", "i18n": null | { "locales": [...] },
 *       "middleware": "none" | [{ "source": "...", "sourceRegex": "..." }, ...] }
 *
 * - no middleware output             -> `"middleware": "none"`
 * - middleware without `matchers`    -> one match-all matcher
 * - middleware with matchers         -> `source` + `sourceRegex` of each (`has` /
 *   `missing` are dropped: the runtime ignores them, so a regexp match counts)
 *
 * It is written beside Next's other build output (`<distDir>/`), then staged into
 * the standalone tree (`<serverDir>/.next/`) by `stageCdnRoutingArtifact`, because
 * `onBuildComplete` runs before Next writes the standalone directory and Next
 * copies only the files it traced. From there the compiled executable embeds it
 * with every other `.json` under `.next` (`standalone-embed.mjs`), and the preload
 * reads it from the embedded root.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const CDN_ROUTING_ARTIFACT_NAME = "knext-cdn-routing.json";

export interface CdnRoutingMatcher {
    source?: string;
    sourceRegex: string;
}

export interface CdnRoutingArtifact {
    version: 1;
    basePath: string;
    i18n: { locales: string[] } | null;
    middleware: "none" | CdnRoutingMatcher[];
}

/** The slice of the `onBuildComplete` ctx this reads (structural: no `next` import). */
export interface CdnRoutingCtx {
    config: {
        basePath?: string;
        i18n?: { locales?: readonly string[] } | null;
    };
    outputs: {
        middleware?: {
            config?: {
                matchers?: ReadonlyArray<{
                    source?: string;
                    sourceRegex?: string;
                    /** Next's conditions; read by nothing here (the runtime ignores them). */
                    has?: unknown;
                    missing?: unknown;
                }>;
            };
        };
    };
}

/** Every path, for middleware that declares no matcher (Next runs it on every request). */
const MATCH_ALL: CdnRoutingMatcher = { source: "/:path*", sourceRegex: "^.*$" };

export function buildCdnRoutingArtifact(
    ctx: CdnRoutingCtx,
): CdnRoutingArtifact {
    const basePath =
        typeof ctx.config.basePath === "string" ? ctx.config.basePath : "";
    const locales = ctx.config.i18n?.locales;
    const i18n = Array.isArray(locales)
        ? { locales: [...locales] }
        : ctx.config.i18n
          ? { locales: [] }
          : null;
    const mw = ctx.outputs.middleware;
    if (!mw) return { version: 1, basePath, i18n, middleware: "none" };
    const matchers = mw.config?.matchers;
    if (!matchers || matchers.length === 0) {
        return { version: 1, basePath, i18n, middleware: [MATCH_ALL] };
    }
    return {
        version: 1,
        basePath,
        i18n,
        middleware: matchers.map((m) =>
            typeof m.sourceRegex === "string"
                ? {
                      ...(typeof m.source === "string"
                          ? { source: m.source }
                          : {}),
                      sourceRegex: m.sourceRegex,
                  }
                : // A matcher whose regexp is missing cannot be tested: widen it to match-all.
                  MATCH_ALL,
        ),
    };
}

/** Write the artifact under `distDir`. Returns the file path. */
export function writeCdnRoutingArtifact(
    distDir: string,
    ctx: CdnRoutingCtx,
): string {
    const path = join(distDir, CDN_ROUTING_ARTIFACT_NAME);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(buildCdnRoutingArtifact(ctx))}\n`);
    return path;
}

/**
 * Copy the artifact from the project's dist dir into the standalone tree's own
 * `.next` (next to `BUILD_ID`), where the server and the compiled executable
 * find it. Returns `false` when the build produced none (an older adapter, or a
 * build that never ran `onBuildComplete`): the runtime then fails closed.
 */
export function stageCdnRoutingArtifact(
    projectDistDir: string,
    serverDir: string,
): boolean {
    const from = join(projectDistDir, CDN_ROUTING_ARTIFACT_NAME);
    if (!existsSync(from)) return false;
    const toDir = join(serverDir, ".next");
    mkdirSync(toDir, { recursive: true });
    copyFileSync(from, join(toDir, CDN_ROUTING_ARTIFACT_NAME));
    return true;
}

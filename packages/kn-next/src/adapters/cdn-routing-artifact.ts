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
 * Middleware is not the only thing that makes a response depend on the request.
 * A `next.config` rewrite, redirect or headers rule with a `has` / `missing`
 * condition (cookie, header, query, host) does too: with no middleware at all,
 * `{ source: '/home', has: [{ type: 'cookie', key: 'vip' }], destination: '/dashboard' }`
 * serves `/dashboard` to a visitor with the cookie and `/home` to one without,
 * under one URL. The official `onBuildComplete` `routing` output lists every such
 * rule with its compiled `sourceRegex`, so each is recorded under `conditional`
 * and treated exactly like a middleware matcher (ADR-0068 D4.1 condition 10,
 * Amendment 1). A conditional rule whose regexp is not exposed is widened to
 * match-all, and a missing `routing` output is recorded as `"unknown"` (which the
 * runtime reads as match-all): a request-dependent rule is never ignored.
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
    /**
     * Routing rules (rewrites, redirects, headers) with a `has` / `missing`
     * condition, or `"unknown"` when the build gave no routing output.
     */
    conditional: CdnRoutingMatcher[] | "unknown";
}

/** The slice of the `onBuildComplete` ctx this reads (structural: no `next` import). */
export interface CdnRoutingCtx {
    /** `ctx.routing`: groups of routes, each `{ source?, sourceRegex?, has?, missing?, … }`. */
    routing?: unknown;
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

/** The `ctx.routing` groups, in a fixed order (any other array-valued group follows). */
const ROUTING_GROUPS = [
    "beforeMiddleware",
    "beforeFiles",
    "afterFiles",
    "dynamicRoutes",
    "onMatch",
    "fallback",
    "middlewareMatchers",
] as const;

const nonEmpty = (v: unknown): boolean => Array.isArray(v) && v.length > 0;

/** More conditional sources than this and the list is widened to match-all. */
const CHAIN_CAP = 256;

/** `https://api.example.com/x`: leaves the app, so it cannot reach the app's own rules. */
const EXTERNAL_DESTINATION = /^[a-z][a-z0-9+.-]*:\/\//i;

interface RoutingRule {
    source?: unknown;
    sourceRegex?: unknown;
    destination?: unknown;
    has?: unknown;
    missing?: unknown;
}

const entryOf = (r: RoutingRule): CdnRoutingMatcher =>
    typeof r.sourceRegex === "string"
        ? {
              ...(typeof r.source === "string" ? { source: r.source } : {}),
              sourceRegex: r.sourceRegex,
          }
        : MATCH_ALL;

/**
 * Every routing rule whose result depends on the request, and every rewrite that
 * can lead into one. `"unknown"` when the build supplied no routing output.
 *
 * Direct: a rule with a non-empty `has` / `missing` (cookie, header, query, host).
 *
 * Chains (Amendment 1): an UNCONDITIONAL rewrite is deterministic by URL, but if
 * its destination can reach a conditional rule the answer depends on the request
 * after all (`/alias -> /af`, with `/af` served differently by a cookie). So, to a
 * fixpoint, a rewrite becomes conditional when
 *   - its destination is static and matches a conditional source (any phase, any
 *     number of hops), or
 *   - its destination cannot be evaluated statically (it carries `$1` / `$name`
 *     params) while ANY conditional rule exists, or
 *   - a conditional source's regexp is unusable (it is assumed to be reachable).
 * An external destination leaves the app and cannot reach its rules. Past
 * `CHAIN_CAP` sources the list is widened to match-all. `dynamicRoutes` map a URL to
 * a page file, not to another URL, so they are not chain edges; redirects (no
 * `destination`) end the request.
 */
function conditionalRoutes(
    routing: unknown,
    basePath: string,
): CdnRoutingMatcher[] | "unknown" {
    if (routing === null || typeof routing !== "object") return "unknown";
    const groups = routing as Record<string, unknown>;
    const names = [
        ...ROUTING_GROUPS,
        ...Object.keys(groups).filter(
            (k) => !(ROUTING_GROUPS as readonly string[]).includes(k),
        ),
    ];
    const out: CdnRoutingMatcher[] = [];
    const seen = new Set<string>();
    const pending: RoutingRule[] = [];
    const reach: RegExp[] = [];
    let reachAll = false;

    const add = (r: RoutingRule): void => {
        const entry = entryOf(r);
        const key = JSON.stringify(entry);
        if (seen.has(key)) return;
        seen.add(key);
        out.push(entry);
        if (typeof entry.sourceRegex !== "string" || entry === MATCH_ALL) {
            reachAll = true;
            return;
        }
        try {
            reach.push(new RegExp(entry.sourceRegex, "i"));
        } catch {
            reachAll = true; // an unusable regexp is assumed reachable
        }
    };

    for (const name of names) {
        const rules = groups[name];
        if (!Array.isArray(rules)) continue;
        for (const rule of rules) {
            if (rule === null || typeof rule !== "object") continue;
            const r = rule as RoutingRule;
            if (nonEmpty(r.has) || nonEmpty(r.missing)) add(r);
            else if (
                name !== "dynamicRoutes" &&
                typeof r.destination === "string"
            ) {
                pending.push(r);
            }
        }
    }

    const reaches = (destination: string): boolean => {
        if (EXTERNAL_DESTINATION.test(destination)) return false;
        const path = destination.split(/[?#]/, 1)[0];
        // Params ($1 / $name) make the target unknowable: assume the worst, but
        // only when there is something to reach.
        if (path.includes("$")) return out.length > 0;
        if (reachAll) return true;
        const variants = new Set([
            path,
            path.endsWith("/") ? path.slice(0, -1) : `${path}/`,
        ]);
        if (basePath) {
            // The rule's regexp may or may not carry the basePath: test both forms.
            if (path.startsWith(`${basePath}/`)) {
                variants.add(path.slice(basePath.length));
            } else if (path !== basePath) {
                variants.add(`${basePath}${path}`);
            }
        }
        for (const v of variants)
            for (const re of reach) if (re.test(v)) return true;
        return false;
    };

    for (let changed = true; changed && pending.length > 0; ) {
        changed = false;
        for (let k = pending.length - 1; k >= 0; k--) {
            if (!reaches(pending[k].destination as string)) continue;
            add(pending[k]);
            pending.splice(k, 1);
            changed = true;
        }
        if (out.length > CHAIN_CAP) return [MATCH_ALL];
    }
    return out.length > CHAIN_CAP ? [MATCH_ALL] : out;
}

export function buildCdnRoutingArtifact(
    ctx: CdnRoutingCtx,
): CdnRoutingArtifact {
    const basePath =
        typeof ctx.config.basePath === "string" ? ctx.config.basePath : "";
    const conditional = conditionalRoutes(ctx.routing, basePath);
    const locales = ctx.config.i18n?.locales;
    const i18n = Array.isArray(locales)
        ? { locales: [...locales] }
        : ctx.config.i18n
          ? { locales: [] }
          : null;
    const mw = ctx.outputs.middleware;
    if (!mw)
        return { version: 1, basePath, i18n, middleware: "none", conditional };
    const matchers = mw.config?.matchers;
    if (!matchers || matchers.length === 0) {
        return {
            version: 1,
            basePath,
            i18n,
            middleware: [MATCH_ALL],
            conditional,
        };
    }
    return {
        version: 1,
        basePath,
        i18n,
        conditional,
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

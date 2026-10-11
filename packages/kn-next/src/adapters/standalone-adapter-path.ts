/**
 * Blank `adapterPath` in the standalone tree's RUNTIME config, on every
 * Next.js version.
 *
 * ## Why: `adapterPath` set means "an adapter router already admitted this"
 *
 * With `adapterPath` set, the App Router page template (`app-page-runtime`)
 * handles a `dynamicParams = false` miss with `if (nextConfig.adapterPath)
 * return await render404()`; unset, it throws `NoFallbackError`. The two are
 * not equivalent. `NoFallbackError` makes Next's own router carry on to the next,
 * less specific route (an `app/x/[...rest]` catch-all behind a closed
 * `app/x/[slug]`). `render404()` ends the request. The adapter branch is written
 * for a platform that routes with `@next/routing` over the `routing` output of
 * `onBuildComplete`: that router has already tried the closed route's
 * `__prerender_bypass`-gated `dynamicRoutes` entry and moved on, so by the time
 * a request reaches the render the 404 is final. knext does not use that router.
 * It boots Next's own standalone `server.js`, so the fall-through has to come
 * from Next's own router, which means the branch must be the unset one.
 *
 * The official reference adapter (nextjs/adapter-bun, `createRuntimeNextConfig`)
 * does the same: `delete configRecord.adapterPath` before writing the config its
 * runtime reads.
 *
 * ## A second bug, below 16.4.0: the racy 500
 *
 * On Next.js < 16.4.0 the adapter branch ALSO runs INSIDE the response-cache
 * generator. `render404()` writes the 404 and returns `null`, so the cache layer
 * receives a null entry for a non-null cache key and throws `invariant: cache
 * entry required but not generated`. When the 404 is already committed the throw
 * is log noise; under a burst of concurrent requests (a page prefetching a
 * handful of 404 links at once) the throw lands first and the router answers
 * `500 Internal Server Error`.
 *
 * Fixed upstream in Next.js 16.4.0 (vercel/next.js#98964, "Preserve
 * closed-route admission across cache misses": the adapter 404 now renders
 * OUTSIDE the response cache). It was NOT backported: 16.3.x still carries it.
 * That fix left the missing fall-through above in place, which is why this
 * module no longer retires at 16.4.0.
 *
 * ## Why blanking `adapterPath` at runtime is safe
 *
 * The adapter's work is build-time: `modifyConfig` and `onBuildComplete` both
 * run inside `next build`. A standalone server never loads the adapter -- the
 * config it reads is the one inlined into `server.js`
 * (`__NEXT_PRIVATE_STANDALONE_CONFIG`), and `loadConfig` short-circuits on it
 * before `applyModifyConfig`. Every runtime reader of `config.adapterPath` in
 * Next 16.3.5 / 16.3.6 / 16.3.8 / 16.4.0 is one of three `render404` branches
 * (the app-page template, the app-route template, the pages handler), each of
 * which falls back to `throw new NoFallbackError()` when it is unset -- the
 * exact path a plain `output: 'standalone'` server (no adapter) has always
 * taken. The rest of the occurrences are build-only (`build/index.js`,
 * `build/adapter`, the export worker, telemetry, config defaults and
 * validation). So blanking it changes ONLY how a `dynamicParams = false` miss is
 * answered, from `render404()` to the proven `NoFallbackError` path.
 *
 * ## What is patched
 *
 * `server.js` inlines the config as `const nextConfig = {...}`; the same config
 * is also in `.next/required-server-files.json`, which a route module falls back
 * to when the router context carries none. Both are patched, in place, in the
 * standalone tree -- BEFORE any compile step, so the Bun single executable
 * (`standalone-compile`) bundles the already-blanked config.
 *
 * ## Retirement
 *
 * NOT retired by raising the Next.js floor. The only thing that retires this is
 * knext routing through the adapter's `routing` output (`@next/routing`) instead
 * of Next's own router, or a Next release whose adapter branch falls through
 * without a router in front of it. Until then keep the module and its three call
 * sites (`compileArtifactForDeploy` in `cli/build-artifact.ts`,
 * `scripts/e2e-deploy.sh`, the `./internal/standalone-adapter-path` export).
 * The version only picks which reason is logged (`nextCarriesAdapter404Bug`).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/** First Next.js release whose adapter 404 renders outside the response cache. */
export const ADAPTER_PATH_404_FIXED_IN = "16.4.0";

export interface BlankAdapterPathResult {
    /** True only when at least one file was rewritten. */
    readonly applied: boolean;
    /** Why it did or did not apply; one line, safe to log. */
    readonly reason: string;
    /** The Next.js version the decision was made on, or null if unreadable. */
    readonly nextVersion: string | null;
    /** Files rewritten (absolute paths). */
    readonly files: string[];
}

/** `[major, minor, patch]` plus whether a pre-release tag follows, or null. */
function parseVersion(
    version: string,
): { core: [number, number, number]; pre: boolean } | null {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+.*)?$/.exec(
        version.trim(),
    );
    if (!m) return null;
    return {
        core: [Number(m[1]), Number(m[2]), Number(m[3])],
        pre: m[4] !== undefined,
    };
}

/**
 * Does this Next.js version carry the adapter-404-inside-the-cache bug?
 * True for every parseable version strictly below `16.4.0` (semver order, so a
 * `16.4.0-canary.N` is below it); false at or above; null when unparseable.
 */
export function nextCarriesAdapter404Bug(version: string): boolean | null {
    const v = parseVersion(version);
    const fixed = parseVersion(ADAPTER_PATH_404_FIXED_IN);
    if (!v || !fixed) return null;
    for (let i = 0; i < 3; i++) {
        if (v.core[i] !== fixed.core[i]) return v.core[i] < fixed.core[i];
    }
    // Same major.minor.patch: only a pre-release tag sorts below the release.
    return v.pre;
}

/**
 * The version of the `next` the standalone server will `require`, resolved the
 * way `server.js` resolves it (ancestor `node_modules` from the server's own
 * directory). Falls back to `projectDir` when given. Null if unreadable.
 */
export function resolveStandaloneNextVersion(
    serverDir: string,
    projectDir?: string,
): string | null {
    for (const from of [serverDir, projectDir]) {
        if (!from) continue;
        try {
            const pkgPath = createRequire(join(from, "server.js")).resolve(
                "next/package.json",
            );
            const v = JSON.parse(readFileSync(pkgPath, "utf8")).version;
            if (typeof v === "string") return v;
        } catch {
            // try the next candidate
        }
    }
    return null;
}

/**
 * A NON-EMPTY `"adapterPath": "<json string>"` member. Anchored on the quoted
 * key and a quoted value, so it matches the inlined `JSON.stringify` config and
 * the pretty-printed manifest alike, and an already-blanked `""` does not match
 * (which is what makes a second run a no-op).
 */
const ADAPTER_PATH_MEMBER = /("adapterPath"\s*:\s*)"(?:[^"\\]|\\.)+"/g;

/** An `adapterPath` member that is already unset: blank, or JSON null. */
const UNSET_ADAPTER_PATH_MEMBER = /"adapterPath"\s*:\s*(?:""|null)/g;

/**
 * Rewrite one file; returns how many members it blanked (0 = file untouched).
 *
 * THROWS when the file still names `adapterPath` after the rewrite in any form
 * other than an unset member: that is serialisation drift (a Next.js release
 * that emits the config differently), and it means the adapter is still live in
 * the runtime config. Returning quietly would ship the very 500 this exists to
 * prevent and report success, so the build fails instead, naming the file.
 */
function blankMembers(file: string): number {
    if (!existsSync(file)) return 0;
    const src = readFileSync(file, "utf8");
    let count = 0;
    const out = src.replace(ADAPTER_PATH_MEMBER, (_m, key: string) => {
        count++;
        return `${key}""`;
    });
    if (out.replace(UNSET_ADAPTER_PATH_MEMBER, "").includes("adapterPath")) {
        throw new Error(
            `[knext] ${file} sets adapterPath in a form the adapterPath workaround does not recognise, so it was NOT blanked. ` +
                `Expected a JSON member matching ${ADAPTER_PATH_MEMBER} (e.g. "adapterPath":"/path/adapter.mjs"). ` +
                "Left as is, a dynamicParams=false miss ends in the closed route's 404 instead of falling through to a less specific route, " +
                `and on Next.js < ${ADAPTER_PATH_404_FIXED_IN} a burst of concurrent prefetches can answer it with a 500. ` +
                "Update standalone-adapter-path.ts for the new serialisation.",
        );
    }
    if (count > 0) writeFileSync(file, out);
    return count;
}

export interface BlankAdapterPathOptions {
    /** Directory holding the standalone `server.js` (nested layouts: the nested dir). */
    readonly serverDir: string;
    /** App root, used only to locate `next` when the tree has none of its own. */
    readonly projectDir?: string;
    /** Override the detected Next.js version (tests). */
    readonly nextVersion?: string;
    readonly log?: (message: string) => void;
}

/**
 * Blank `adapterPath` in the standalone tree's runtime config, on every Next.js
 * version. See the module comment.
 *
 * A tree with no adapterPath is reported in the result, not thrown. A config
 * that sets adapterPath in a form this cannot rewrite THROWS (see
 * `blankMembers`): a silent `applied: false` there would ship the bug.
 */
export function blankStandaloneAdapterPath(
    opts: BlankAdapterPathOptions,
): BlankAdapterPathResult {
    const log = opts.log ?? (() => {});
    const nextVersion =
        opts.nextVersion ??
        resolveStandaloneNextVersion(opts.serverDir, opts.projectDir);

    const files: string[] = [];
    for (const file of [
        join(opts.serverDir, "server.js"),
        join(opts.serverDir, ".next", "required-server-files.json"),
    ]) {
        if (blankMembers(file) > 0) files.push(file);
    }
    if (files.length === 0) {
        return {
            applied: false,
            reason: `the standalone config under ${opts.serverDir} sets no adapterPath (nothing to blank)`,
            nextVersion,
            files,
        };
    }
    // The version only decides which consequence the log names. Whether to blank
    // does not depend on it (see the module comment).
    const label = nextVersion === null ? "unreadable" : nextVersion;
    const consequence =
        nextVersion !== null && nextCarriesAdapter404Bug(nextVersion) === true
            ? `a dynamicParams=false 404 would otherwise 500 under concurrent prefetches (Next < ${ADAPTER_PATH_404_FIXED_IN}), and not fall through to a less specific route`
            : "a closed dynamicParams=false matcher must fall through to a less specific route, which Next's own router only does without an adapter";
    const reason = `Next.js ${label}: blanked adapterPath in ${files.length} standalone config file(s) (${consequence})`;
    log(`[knext] ${reason}`);
    return { applied: true, reason, nextVersion, files };
}

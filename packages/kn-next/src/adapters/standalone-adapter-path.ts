/**
 * Version-gated workaround: blank `adapterPath` in the standalone tree's
 * RUNTIME config on Next.js < 16.4.0.
 *
 * ## The upstream bug
 *
 * With `adapterPath` set, the App Router page template (`app-page-runtime`)
 * handles a `dynamicParams = false` miss with `if (nextConfig.adapterPath)
 * return await render404()` -- and it does so INSIDE the response-cache
 * generator. `render404()` writes the 404 and returns `null`, so the cache layer
 * receives a null entry for a non-null cache key and throws `invariant: cache
 * entry required but not generated`. When the 404 is already committed the throw
 * is log noise; under a burst of concurrent requests (a page prefetching a
 * handful of 404 links at once) the throw lands first and the router answers
 * `500 Internal Server Error`. Without `adapterPath` the same branch throws
 * `NoFallbackError`, which the router turns into a clean 404.
 *
 * Fixed upstream in Next.js 16.4.0 (vercel/next.js#98964, "Preserve
 * closed-route admission across cache misses": the adapter 404 now renders
 * OUTSIDE the response cache). It was NOT backported: 16.3.x still carries it.
 *
 * ## Why blanking `adapterPath` at runtime is safe
 *
 * The adapter's work is build-time: `modifyConfig` and `onBuildComplete` both
 * run inside `next build`. A standalone server never loads the adapter -- the
 * config it reads is the one inlined into `server.js`
 * (`__NEXT_PRIVATE_STANDALONE_CONFIG`), and `loadConfig` short-circuits on it
 * before `applyModifyConfig`. Every runtime reader of `config.adapterPath` in
 * Next 16.3.5 / 16.3.6 is one of three `render404` branches (the app-page
 * template, the app-route template, the pages handler), each of which falls back
 * to `throw new NoFallbackError()` when it is unset -- the exact path a plain
 * `output: 'standalone'` server (no adapter) has always taken. The rest of the
 * occurrences are build-only (`build/index.js`, telemetry, config defaults and
 * validation). So blanking it changes ONLY how a `dynamicParams = false` miss is
 * answered, from the racy `render404()` to the proven `NoFallbackError` 404.
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
 * Gated on the installed Next.js version, so it disappears on its own: at
 * `>= 16.4.0` this is a no-op. Once the compat pin and the supported peer range
 * both sit at `>= 16.4.0`, delete this module and its three call sites
 * (`compileArtifactForDeploy` in `cli/build-artifact.ts`, `scripts/e2e-deploy.sh`,
 * the `./internal/standalone-adapter-path` export) and
 * `__tests__/standalone-adapter-path*.test.ts`. A pre-release of 16.4.0 sorts
 * below 16.4.0 under semver and is therefore still blanked; that is safe (it is
 * the proven non-adapter path), merely redundant on a canary that has the fix.
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
            `[knext] ${file} sets adapterPath in a form the Next.js < ${ADAPTER_PATH_404_FIXED_IN} workaround does not recognise, so it was NOT blanked. ` +
                `Expected a JSON member matching ${ADAPTER_PATH_MEMBER} (e.g. "adapterPath":"/path/adapter.mjs"). ` +
                "Left as is, a dynamicParams=false 404 can answer a burst of concurrent prefetches with a 500. " +
                `Upgrade Next.js to ${ADAPTER_PATH_404_FIXED_IN} or later, or update standalone-adapter-path.ts for the new serialisation.`,
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
 * Blank `adapterPath` in the standalone tree's runtime config when (and only
 * when) the installed Next.js is below 16.4.0. See the module comment.
 *
 * An unreadable version or a tree with no adapterPath is reported in the result,
 * not thrown: a deploy must not die on a workaround it cannot judge, and an
 * unreadable version is NOT treated as affected. But on an AFFECTED version
 * whose config sets adapterPath in a form this cannot rewrite, it THROWS (see
 * `blankMembers`): a silent `applied: false` there would ship the bug.
 */
export function blankStandaloneAdapterPath(
    opts: BlankAdapterPathOptions,
): BlankAdapterPathResult {
    const log = opts.log ?? (() => {});
    const nextVersion =
        opts.nextVersion ??
        resolveStandaloneNextVersion(opts.serverDir, opts.projectDir);

    if (nextVersion === null) {
        const reason =
            "could not read the installed Next.js version, so the adapterPath workaround was not applied";
        log(`[knext] ${reason}`);
        return { applied: false, reason, nextVersion, files: [] };
    }
    const affected = nextCarriesAdapter404Bug(nextVersion);
    if (affected === null) {
        const reason = `Next.js version '${nextVersion}' is not a recognisable version, so the adapterPath workaround was not applied`;
        log(`[knext] ${reason}`);
        return { applied: false, reason, nextVersion, files: [] };
    }
    if (!affected) {
        return {
            applied: false,
            reason: `Next.js ${nextVersion} >= ${ADAPTER_PATH_404_FIXED_IN} renders the adapter 404 outside the response cache; no workaround needed`,
            nextVersion,
            files: [],
        };
    }

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
            reason: `Next.js ${nextVersion} is affected, but the standalone config under ${opts.serverDir} sets no adapterPath (nothing to blank)`,
            nextVersion,
            files,
        };
    }
    const reason = `Next.js ${nextVersion} < ${ADAPTER_PATH_404_FIXED_IN}: blanked adapterPath in ${files.length} standalone config file(s) (a dynamicParams=false 404 would otherwise 500 under concurrent prefetches)`;
    log(`[knext] ${reason}`);
    return { applied: true, reason, nextVersion, files };
}

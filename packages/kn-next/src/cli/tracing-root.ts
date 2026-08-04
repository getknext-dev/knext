#!/usr/bin/env node
/**
 * ONE rule for "where is the root of this project" (#644).
 *
 * Three CLI paths need that answer and used to disagree:
 *
 *   - `create.ts` emits `.next/standalone/<prefix>server.js` paths, so it needs
 *     the directory Next.js traced from;
 *   - `deploy.ts` and `preview.ts` pass a directory to `docker buildx build` as
 *     the CONTEXT, so they need the directory that CONTAINS what Next traced.
 *
 * Those are the same directory, and the rule that finds it is Next's own:
 * `findRootDirAndLockFiles` walks up looking for a lockfile and traces from the
 * outermost one it finds. `deploy.ts` instead hardcoded
 * `resolve(process.cwd(), "../..")` — a claim that every app sits at
 * `apps/<name>`. That is true inside this monorepo and false for an app made by
 * `kn-next create` (#642) in a user's own repo, where the app IS the root and
 * the hardcode points two levels ABOVE the project.
 *
 * Choosing the lockfile walk is not a preference for the layout-independent
 * option; it is a correctness requirement. The build context has to agree with
 * what `output: "standalone"` actually produced, and Next decided that by this
 * rule. Any second rule is right only where it happens to coincide.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * EXACTLY the lockfiles next 16.2's `findRootDirAndLockFiles` considers.
 *
 * `pnpm-workspace.yaml` is deliberately NOT here even though it looks like a
 * workspace-root marker: Next does not consult it, so treating it as one made
 * us emit `apps/a/` where Next produces a FLAT `.next/standalone/`. Diverging
 * from Next here does not "fix" anything; it just moves the error somewhere
 * quieter.
 *
 * Each entry also names the package manager, because the generated Dockerfile
 * must install with the manager whose lockfile it found (`npm ci` cannot
 * consume a `pnpm-lock.yaml`).
 */
export const LOCKFILES: ReadonlyArray<{ file: string; install: string }> = [
    {
        file: "pnpm-lock.yaml",
        install: "corepack enable && pnpm install --frozen-lockfile",
    },
    { file: "package-lock.json", install: "npm ci" },
    {
        file: "yarn.lock",
        install: "corepack enable && yarn install --immutable",
    },
    // The node base image has no bun. Rather than emit a command the image
    // cannot run, install with npm from package.json and say so in the emitted
    // Dockerfile — switch the base image if you want bun's lockfile honoured.
    { file: "bun.lock", install: "npm install --no-audit --no-fund" },
    { file: "bun.lockb", install: "npm install --no-audit --no-fund" },
];

/** No lockfile anywhere: nothing to be frozen against. */
export const NO_LOCKFILE_INSTALL = "npm install --no-audit --no-fund";

export interface TracingRoot {
    /** The outermost lockfile-bearing ancestor of `appDir`, or null. */
    root: string | null;
    /** Install command matching the lockfile found at `root`. */
    installCmd: string;
}

/**
 * Next's tracing root for an app at `appDir`: the OUTERMOST lockfile-bearing
 * ancestor. With a lockfile in both the workspace root and (rarely) the app,
 * Next traces from the outer one, and guessing the inner one silently
 * mislocates every emitted path.
 *
 * `root` is null when no ancestor carries a lockfile. Callers decide what that
 * means for them — it is a normal state for `create` (the app is scaffolded
 * before anything is installed) and an unanswerable question for `deploy`.
 */
export function findTracingRoot(appDir: string): TracingRoot {
    let dir = resolve(appDir);
    let root: string | null = null;
    let installCmd = NO_LOCKFILE_INSTALL;
    for (;;) {
        const hit = LOCKFILES.find((l) => existsSync(join(dir, l.file)));
        if (hit) {
            root = dir;
            installCmd = hit.install;
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return { root, installCmd };
}

/**
 * The docker build context for an app at `appDir`, or THROW.
 *
 * Deploy has no safe default here. Without a lockfile the two plausible answers
 * — "the app directory" and "some ancestor" — differ, and picking one silently
 * builds an image from a context that may exclude files the traced server
 * imports, or include the user's entire home directory. So it fails, and the
 * message says which directory was searched and what to do about it.
 */
export function requireBuildContext(appDir: string): string {
    const { root } = findTracingRoot(appDir);
    if (!root) {
        throw new Error(
            `Cannot determine the Docker build context: no lockfile found in ${resolve(appDir)} ` +
                "or any parent directory.\n" +
                `Next.js infers its file-tracing root the same way (${LOCKFILES.map((l) => l.file).join(", ")}), ` +
                "so without one the build context and the standalone output cannot be made to agree.\n" +
                "Run your package manager's install in the project root to create a lockfile, and commit it.",
        );
    }
    return root;
}

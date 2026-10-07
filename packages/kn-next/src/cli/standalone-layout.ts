/**
 * Diagnose a NESTED standalone layout: `.next/standalone/<app>/server.js`.
 *
 * Next.js traces from a "workspace root" it infers by walking up to the
 * outermost lockfile (`tracing-root.ts` ports that rule). When the app sits
 * under a directory that carries a lockfile of its own — the documented
 * getting-started path installs `@getknext/core` in a parent directory and
 * scaffolds the app into a child — that parent becomes the root, and the
 * standalone server is written under the app's path relative to it instead of
 * at `.next/standalone/server.js`.
 *
 * knext deliberately does NOT adopt the nested path. The files Next traced can
 * live OUTSIDE the app directory in that layout, so packaging it from the app
 * directory silently ships an image with missing (or wrongly-placed) files. The
 * right move is to fail — but with the real cause, because the generic
 * "server.js is not there, check output: 'standalone'" message blames a setting
 * that is correctly set.
 */

import { type Dirent, existsSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { findTracingRoot, LOCKFILES } from "./tracing-root";

/** How deep below `.next/standalone` to look for a relocated `server.js`. */
const MAX_NEST_DEPTH = 6;

/** The directory (relative to `.next/standalone`) holding a nested `server.js`, or null. */
function findNestedServerDir(standaloneDir: string): string | null {
    let level: string[] = [""];
    for (let depth = 1; depth <= MAX_NEST_DEPTH; depth++) {
        const next: string[] = [];
        for (const rel of level) {
            let entries: Dirent[];
            try {
                entries = readdirSync(join(standaloneDir, rel), {
                    withFileTypes: true,
                });
            } catch {
                continue;
            }
            for (const entry of entries) {
                // The traced dependency closure and the Next output are never
                // where a relocated app server lives.
                if (!entry.isDirectory()) continue;
                if (entry.name === "node_modules" || entry.name === ".next")
                    continue;
                const childRel = join(rel, entry.name);
                if (existsSync(join(standaloneDir, childRel, "server.js")))
                    return childRel;
                next.push(childRel);
            }
        }
        level = next;
    }
    return null;
}

/**
 * An actionable explanation when `.next/standalone/server.js` is missing
 * because the build was nested, or null when there is no nested server (the
 * normal layout, or no standalone output at all).
 *
 * Call only after the expected `server.js` has been found MISSING; a present
 * one means the layout is fine and there is nothing to diagnose.
 */
export function diagnoseNestedStandalone(appDir: string): string | null {
    const app = resolve(appDir);
    const standaloneDir = join(app, ".next", "standalone");
    if (existsSync(join(standaloneDir, "server.js"))) return null;
    if (!existsSync(standaloneDir)) return null;

    const nestedRel = findNestedServerDir(standaloneDir);
    if (nestedRel === null) return null;

    const segments = nestedRel.split(sep).filter(Boolean);
    const root = resolve(app, ...segments.map(() => ".."));
    const nestedPath = `.next/standalone/${segments.join("/")}/server.js`;

    // Which lockfile put the root there? Ask the same walk Next uses, then
    // prefer a marker sitting AT the inferred root.
    const { lockFiles } = findTracingRoot(app);
    const atRoot =
        lockFiles.find((f) => dirname(f) === root) ??
        LOCKFILES.map((l) => join(root, l.file)).find(existsSync) ??
        (existsSync(join(root, "pnpm-workspace.yaml"))
            ? join(root, "pnpm-workspace.yaml")
            : null);

    const cause = atRoot
        ? `Next.js picked ${root} as the workspace root because of ${atRoot}, so it wrote the standalone server to '${nestedPath}' instead of '.next/standalone/server.js'.`
        : `Next.js traced from ${root}, not from the app directory (${app}), so it wrote the standalone server to '${nestedPath}' instead of '.next/standalone/server.js'. No lockfile was found there, so the root was set another way (an outputFileTracingRoot or turbopack.root in next.config).`;

    return (
        `${cause}\n\n` +
        "knext does not package that layout: the files Next traced can live outside the app directory, " +
        "and the image would start without them. `output: 'standalone'` is set correctly — the root is what is wrong.\n\n" +
        "A root deliberately set ABOVE the app (a workspace monorepo that shares dependencies from its root) is not supported yet: " +
        "knext expects the server at '.next/standalone/server.js'.\n\n" +
        "Fix it one of two ways:\n" +
        `  - set \`outputFileTracingRoot\` (and \`turbopack.root\`) in next.config to this app directory (${app}), or\n` +
        (atRoot
            ? `  - remove the lockfile you do not need (${atRoot}) so the app is its own workspace root.\n`
            : "  - remove the outputFileTracingRoot / turbopack.root that points above the app.\n") +
        `Then rebuild. (Relative to the root, the app is '${relative(root, app) || "."}'.)`
    );
}

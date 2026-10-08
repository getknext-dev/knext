/**
 * Where `next build` puts the standalone server, and what to say when it is
 * not there.
 *
 * Next.js writes the standalone tree relative to its file-tracing root. With
 * the root at the app (the scaffold's pin) the server is
 * `.next/standalone/server.js`. With the root ABOVE the app, as a workspace
 * monorepo needs so Next can trace the shared packages the app imports, the
 * app's path under that root is repeated inside the tree:
 * `.next/standalone/<app path under the root>/server.js`, with the traced
 * workspace files beside it.
 *
 * DELIBERATE vs ACCIDENTAL. Next also infers a root by walking up to the
 * outermost lockfile (`tracing-root.ts` ports that rule), and a stray lockfile
 * in a parent directory moves the root without the user ever choosing it. knext
 * must not package THAT layout: nobody asked for it, and the traced files can
 * live outside the app directory the user thinks they are deploying. So only an
 * EXPLICIT `outputFileTracingRoot` / `turbopack.root` in next.config, naming a
 * strict ancestor of the app, enables nested mode (`resolveStandaloneLayout`).
 * A workspace marker alone (`workspaces`, `pnpm-workspace.yaml`) does not: those
 * are ubiquitous and say nothing about whether the root was chosen. An inferred
 * root keeps failing, with the real cause (`diagnoseNestedStandalone`), because
 * the generic "server.js is not there, check output: 'standalone'" message
 * blames a setting that is correctly set.
 */

import { type Dirent, existsSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
    type ConfiguredRoot,
    configuredTracingRoot,
    findTracingRoot,
    LOCKFILES,
} from "./tracing-root";

/** How deep below `.next/standalone` to look for a relocated `server.js`. */
const MAX_NEST_DEPTH = 6;

/** Where the standalone server for an app is expected, per its own config. */
export interface StandaloneLayout {
    /** The app directory (where `next build` ran). */
    readonly appDir: string;
    /**
     * Next's tracing root: the explicit one when nested, else the app itself.
     * It is also the directory `docker build` is given as its context.
     */
    readonly root: string;
    /** True only for an explicit root above the app. */
    readonly nested: boolean;
    /** The app's path under `root`, with `/` separators; empty when flat. */
    readonly appRel: string;
    /**
     * `appRel` with a trailing slash, or the empty string: the prefix every
     * app-relative path takes inside a Docker build context rooted at `root`.
     * Empty when flat, so a flat path is byte-identical to what it always was.
     */
    readonly contextPrefix: string;
    /** `<app>/.next/standalone`: the whole traced tree. */
    readonly standaloneDir: string;
    /** The directory holding `server.js` (and `.next`, `public` beside it). */
    readonly serverDir: string;
    /** The standalone `server.js` the runtime starts. */
    readonly serverPath: string;
    /** `<file>:<key>` of the explicit setting that enabled nested mode. */
    readonly configSource?: string;
}

/** `root` strictly contains `app` (and is not the app itself). */
function isStrictAncestor(root: string, app: string): boolean {
    const rel = relative(root, app);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * The layout `next build` will produce for the app at `appDir`, decided from
 * its next.config alone (it does not look at build output, so it can be asked
 * before the build runs).
 *
 * A root expression knext cannot evaluate, or a root that is not an ancestor of
 * the app, is NOT read as a deliberate monorepo root: the layout stays flat and
 * the failure, if any, is the actionable one in `diagnoseNestedStandalone`.
 * (`deploy` resolves the same setting for its build context and refuses an
 * expression it cannot evaluate, with its own message.)
 */
export function resolveStandaloneLayout(appDir: string): StandaloneLayout {
    const app = resolve(appDir);
    const standaloneDir = join(app, ".next", "standalone");

    let configured: ConfiguredRoot | null = null;
    try {
        configured = configuredTracingRoot(app);
    } catch {
        configured = null;
    }

    if (configured && isStrictAncestor(configured.root, app)) {
        const appRel = relative(configured.root, app).split(sep).join("/");
        const serverDir = join(standaloneDir, ...appRel.split("/"));
        return {
            appDir: app,
            root: configured.root,
            nested: true,
            appRel,
            contextPrefix: `${appRel}/`,
            standaloneDir,
            serverDir,
            serverPath: join(serverDir, "server.js"),
            configSource: configured.source,
        };
    }

    return {
        appDir: app,
        root: app,
        nested: false,
        appRel: "",
        contextPrefix: "",
        standaloneDir,
        serverDir: standaloneDir,
        serverPath: join(standaloneDir, "server.js"),
    };
}

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
 * An actionable explanation when the standalone server is missing from where
 * the app's config says it should be, because Next wrote it somewhere else, or
 * null when there is no such server (the expected layout, or no standalone
 * output at all).
 *
 * Call only after the expected `server.js` has been found MISSING; a present
 * one means the layout is fine and there is nothing to diagnose.
 */
export function diagnoseNestedStandalone(appDir: string): string | null {
    const layout = resolveStandaloneLayout(appDir);
    const app = layout.appDir;
    const { standaloneDir } = layout;
    if (existsSync(layout.serverPath)) return null;
    if (!existsSync(standaloneDir)) return null;

    const foundRel = findNestedServerDir(standaloneDir);
    if (foundRel === null) return null;

    const segments = foundRel.split(sep).filter(Boolean);
    const foundPath = `.next/standalone/${segments.join("/")}/server.js`;
    const expectedPath = `.next/standalone/${layout.appRel ? `${layout.appRel}/` : ""}server.js`;

    // A deliberate root whose server landed somewhere else: the two keys
    // disagree, or the config names a root other than the one Next traced from.
    if (layout.nested) {
        return (
            `next.config sets the tracing root to ${layout.root} (${layout.configSource}), so knext expected the standalone server at '${expectedPath}', ` +
            `but Next.js wrote it to '${foundPath}'.\n\n` +
            "That happens when `outputFileTracingRoot` and `turbopack.root` name different directories, or the root Next used is not the one in the config. " +
            "Set both to the same directory, the workspace root that contains the app, and rebuild."
        );
    }

    const root = resolve(app, ...segments.map(() => ".."));

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
        ? `Next.js picked ${root} as the workspace root because of ${atRoot}, so it wrote the standalone server to '${foundPath}' instead of '${expectedPath}'.`
        : `Next.js traced from ${root}, not from the app directory (${app}), so it wrote the standalone server to '${foundPath}' instead of '${expectedPath}'. No lockfile was found there, so the root was set another way (an outputFileTracingRoot or turbopack.root that knext could not read as a directory above this app).`;

    return (
        `${cause}\n\n` +
        "knext packages that nested layout only when the root is set on purpose: the files Next traced can live outside the app directory, " +
        "and a root that merely happened to be inferred would ship an image the app never asked for. " +
        "`output: 'standalone'` is set correctly — the root is what is wrong.\n\n" +
        "Fix it one of three ways:\n" +
        `  - if this is a workspace monorepo and ${root} is the root you want, set \`outputFileTracingRoot\` AND \`turbopack.root\` in next.config to that directory (for example \`path.join(__dirname, '${relative(app, root).split(sep).join("/") || "."}')\`); knext then packages the nested layout, or\n` +
        `  - set both to this app directory (${app}) so the app is its own root, or\n` +
        (atRoot
            ? `  - remove the lockfile you do not need (${atRoot}) so the app is its own workspace root.\n`
            : "  - remove the outputFileTracingRoot / turbopack.root that points above the app.\n") +
        `Then rebuild. (Relative to the root, the app is '${relative(root, app) || "."}'.)`
    );
}

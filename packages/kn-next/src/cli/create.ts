#!/usr/bin/env node
/**
 * `kn-next create` — scaffold a knext app that carries the guarded
 * instrumentation BY DEFAULT (#407, ADR-0041 amending ADR-0031).
 *
 * ADR-0031 made the in-repo `turbo gen zone` template emit the guarded pair
 * (edge-safe `instrumentation.ts` + Node-only `instrumentation-node.ts`, the
 * adapter-owned `IgnorePlugin` fence, and both per-app guards). Apps created
 * OUTSIDE this monorepo had no such path and hand-wrote the fence — the exact
 * #342 footgun ADR-0031 removed for generated apps. This command closes that
 * gap by emitting the SAME shape from the published package.
 *
 * What it does NOT do (ADR-0001): it never touches the cluster. It writes
 * files, nothing else.
 *
 * The shared files are byte-identical copies of the zone template
 * (`packages/kn-next/templates/app/` ↔ `turbo/generators/templates/zone/`),
 * pinned by `src/__tests__/create-scaffold-parity.test.ts`. Templates ship as
 * `.hbs` so this repo's own vitest/biome/tsc never collect them as sources.
 */

import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createLogger } from "../utils/logger";

const log = createLogger({ module: "create" });

/**
 * The @getknext/core package root, found by walking UP from this module.
 *
 * Deliberately not a fixed `../..`: tsup code-splits this module into
 * `dist/<name>-<hash>.js` (a THIRD layout beside `src/cli/create.ts` and
 * `dist/cli/kn-next.js`), so a hard-coded depth resolves to a directory that
 * does not exist — which the bundled-bin test in `cli-node-runtime.test.ts`
 * caught. Walking up is layout-agnostic.
 */
export function packageRoot(): string {
    let dir = dirname(fileURLToPath(import.meta.url));
    let fallback: string | null = null;
    for (;;) {
        const manifest = join(dir, "package.json");
        if (existsSync(manifest)) {
            try {
                const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
                    name?: string;
                };
                if (pkg.name === "@getknext/core") return dir;
            } catch {
                // An unreadable manifest is not this walk's problem; keep going.
            }
        }
        // Layout-independent fallback for a vendored/renamed install.
        if (!fallback && existsSync(join(dir, "templates", "app"))) {
            fallback = dir;
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    if (fallback) return fallback;
    throw new Error(
        "could not locate the @getknext/core package root from " +
            `${fileURLToPath(import.meta.url)} — the install looks corrupt`,
    );
}

/** Template root: `<package>/templates/app`. */
export function templateRoot(): string {
    return join(packageRoot(), "templates", "app");
}

/**
 * Lockfiles/workspace manifests Next.js uses to infer `outputFileTracingRoot`.
 * The standalone output nests under the app's path RELATIVE to that root, which
 * is why the emitted seam guard, `start` script and Dockerfile all need it: a
 * guard aimed at the wrong directory finds no build and SKIPS — green-by-skip,
 * which is not a pass (#408).
 */
const LOCKFILES = [
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "bun.lockb",
    "bun.lock",
    "pnpm-workspace.yaml",
];

/**
 * The `.next/standalone/<prefix>server.js` path prefix for an app at `appDir`.
 * Empty string when the app directory IS the tracing root (a flat, single-app
 * repo); otherwise the app's slash-terminated path relative to that root.
 */
export function standalonePrefixFor(appDir: string): string {
    const app = resolve(appDir);
    let dir = app;
    let root = app;
    // Walk up to the OUTERMOST lockfile-bearing ancestor: with a lockfile in
    // both the workspace root and (rarely) the app, Next traces from the outer
    // one, and guessing the inner one silently mislocates every emitted path.
    for (;;) {
        if (LOCKFILES.some((f) => existsSync(join(dir, f)))) {
            root = dir;
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    const rel = relative(root, app);
    if (!rel || rel.startsWith("..")) return "";
    return `${rel.split(sep).join("/")}/`;
}

/** Reads the CLI's own version — the range the scaffold pins its deps to. */
export function cliVersion(): string {
    try {
        const pkgPath = join(packageRoot(), "package.json");
        return (
            (JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string })
                .version ?? "0.0.0"
        );
    } catch {
        return "0.0.0";
    }
}

/** Load every `.hbs` under `root` as relPath (minus the `.hbs`) → source. */
export function loadTemplates(root = templateRoot()): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (!entry.name.endsWith(".hbs")) continue;
            const rel = relative(root, full)
                .split(sep)
                .join("/")
                .replace(/\.hbs$/, "");
            out.set(rel, readFileSync(full, "utf8"));
        }
    };
    if (!existsSync(root)) {
        throw new Error(
            `knext scaffold templates not found at ${root} — the installed ` +
                "@getknext/core package is missing its templates/ directory",
        );
    }
    walk(root);
    return out;
}

export interface RenderOptions {
    name: string;
    standalonePrefix: string;
    version: string;
    templates?: Map<string, string>;
}

/**
 * Substitute the template variables. Deliberately strict: an unknown or
 * misspelled `{{ … }}` THROWS rather than shipping a literal placeholder into a
 * user's app (a silently-unsubstituted path in the seam guard would make it
 * skip forever).
 */
export function renderScaffold(opts: RenderOptions): Map<string, string> {
    const vars: Record<string, string> = {
        name: opts.name,
        standalonePrefix: opts.standalonePrefix,
        version: opts.version,
    };
    const templates = opts.templates ?? loadTemplates();
    const rendered = new Map<string, string>();
    for (const [rel, source] of templates) {
        const out = source.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key) => {
            if (!Object.hasOwn(vars, key)) {
                throw new Error(
                    `unknown template variable '{{ ${key} }}' in ${rel}`,
                );
            }
            return vars[key];
        });
        if (out.includes("{{")) {
            throw new Error(
                `unsubstituted template placeholder left in ${rel} — refusing to emit it`,
            );
        }
        rendered.set(rel, out);
    }
    return rendered;
}

export interface ScaffoldOptions {
    appDir: string;
    name?: string;
    force?: boolean;
    dryRun?: boolean;
    templates?: Map<string, string>;
    version?: string;
}

/**
 * Render the scaffold into `appDir` and return the emitted relPath → content
 * map. Refuses to clobber: an existing file aborts the WHOLE write (before any
 * file is touched) unless `force` is set, so a half-scaffolded app is never a
 * possible outcome.
 */
export function writeScaffold(opts: ScaffoldOptions): Map<string, string> {
    const appDir = resolve(opts.appDir);
    const name = opts.name ?? appDir.split(sep).filter(Boolean).pop() ?? "app";
    const files = renderScaffold({
        name,
        standalonePrefix: standalonePrefixFor(appDir),
        version: opts.version ?? cliVersion(),
        templates: opts.templates,
    });

    if (!opts.force) {
        const clashes = [...files.keys()].filter((rel) =>
            existsSync(join(appDir, rel)),
        );
        if (clashes.length > 0) {
            throw new Error(
                `refusing to overwrite existing file(s): ${clashes.join(", ")} — ` +
                    "re-run with --force to replace them",
            );
        }
    }

    if (opts.dryRun) return files;

    for (const [rel, content] of files) {
        const target = join(appDir, rel);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content, "utf8");
    }
    return files;
}

const HELP = `kn-next create — scaffold a knext app with guarded instrumentation

Usage:
  kn-next create [directory] [options]

Emits the SAME guarded-instrumentation shape the in-repo app template does
(ADR-0031/#407): an edge-clean src/instrumentation.ts, the Node-only
src/instrumentation-node.ts wiring the globalThis-anchored @getknext/lib seams,
next-adapter.ts + adapterPath (the platform-owned edge IgnorePlugin fence), and
both per-app guards (instrumentation-edge-safe / standalone-seam-alive) plus the
\`test:seam\` script that runs the latter for real.

Options:
  --name <name>   App name (default: the directory name)
  --force         Overwrite existing files
  --dry-run       List the files that would be written, write nothing
  -h, --help      Show this help
`;

export async function createMain(argv: string[]): Promise<number> {
    let values: {
        name?: string;
        force?: boolean;
        "dry-run"?: boolean;
        help?: boolean;
    };
    let positionals: string[];
    try {
        ({ values, positionals } = parseArgs({
            args: argv,
            options: {
                name: { type: "string" },
                force: { type: "boolean", default: false },
                "dry-run": { type: "boolean", default: false },
                help: { type: "boolean", short: "h", default: false },
            },
            strict: true,
            allowPositionals: true,
        }));
    } catch (err) {
        process.stderr.write(`${(err as Error).message}\n\n${HELP}`);
        return 1;
    }

    if (values.help) {
        process.stdout.write(HELP);
        return 0;
    }

    const appDir = resolve(positionals[0] ?? ".");
    try {
        const files = writeScaffold({
            appDir,
            name: values.name,
            force: values.force,
            dryRun: values["dry-run"],
        });
        const rels = [...files.keys()].sort();
        process.stdout.write(
            `${values["dry-run"] ? "Would create" : "Created"} ${rels.length} file(s) in ${appDir}:\n` +
                `${rels.map((r) => `  ${r}\n`).join("")}` +
                (values["dry-run"]
                    ? ""
                    : "\nNext: install deps, then `npm run test:seam` to prove the " +
                      "instrumentation seams survive the standalone build.\n"),
        );
        return 0;
    } catch (err) {
        log.error({ err }, "create failed");
        return 1;
    }
}

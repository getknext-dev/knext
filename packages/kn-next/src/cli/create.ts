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
import { handleUsageError, UsageError } from "./shared";
import {
    configuredTracingRoot,
    findTracingRoot,
    NO_LOCKFILE_INSTALL,
} from "./tracing-root";

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
/**
 * The lockfile list and the walk itself live in `tracing-root.ts` (#644): the
 * same rule decides `deploy`/`preview`'s docker build context, and two copies
 * of it agreed only for `apps/<name>`.
 */

export interface Layout {
    /**
     * `.next/standalone/<prefix>server.js` — the app's path relative to the
     * tracing root, slash-terminated, or "" when the app IS that root.
     * ALSO the app's path inside the docker build context, because the
     * generated Dockerfile's context IS the tracing root (see `Dockerfile.hbs`).
     * Those two meanings coincide only under that choice of context — which is
     * why the context is stated in the emitted file rather than assumed.
     */
    standalonePrefix: string;
    /** Absolute path of the inferred tracing root (= the docker build context). */
    root: string;
    /** Install command matching the lockfile actually found at `root`. */
    installCmd: string;
}

/** Resolve the layout facts every emitted path depends on, once. */
export function resolveLayout(appDir: string): Layout {
    const app = resolve(appDir);
    // Same PRECEDENCE `deploy`/`preview` use, not just the same walk (#861).
    // `requireBuildContext` consults `configuredTracingRoot` first; this function
    // used to skip straight to the walk, so pinning `outputFileTracingRoot` moved
    // the deploy build context while leaving the Dockerfile `create` had already
    // baked computed against the walked root — the prefix, both COPY sources, the
    // WORKDIR and the CMD all pointing at something the build never wrote. That is
    // #857's symptom by another route, and reachable by following knext's own advice,
    // since pinning the root is what `warnDuplicatedLockFiles` recommends for an
    // ambiguous chain.
    //
    // `create` still tolerates the no-marker case that `requireBuildContext` rejects:
    // an app is scaffolded BEFORE anything is installed, and with nothing anywhere
    // Next traces from the app directory itself — which is what the null root falls
    // back to here.
    const configured = configuredTracingRoot(app);
    const walked = findTracingRoot(app);
    const root = configured?.root ?? walked.root ?? app;
    // The install command belongs to the root the Dockerfile installs in. When the
    // user pins a root, the walk's command describes a different directory, so ask
    // the walk again FROM the pinned root rather than carrying an answer about
    // somewhere else.
    const installCmd =
        configured === null
            ? walked.installCmd
            : findTracingRoot(configured.root).installCmd;
    const rel = relative(root, app);
    const standalonePrefix =
        !rel || rel.startsWith("..") ? "" : `${rel.split(sep).join("/")}/`;
    return { standalonePrefix, root, installCmd };
}

/**
 * The `.next/standalone/<prefix>server.js` path prefix for an app at `appDir`.
 * Empty string when the app directory IS the tracing root (a flat, single-app
 * repo); otherwise the app's slash-terminated path relative to that root.
 */
export function standalonePrefixFor(appDir: string): string {
    return resolveLayout(appDir).standalonePrefix;
}

/**
 * RFC1123 label: the app name becomes the NextApp resource AND the Knative
 * Service name, so Kubernetes rejects anything else — and the name is
 * interpolated into JSON, TypeScript and JSX, where an unvalidated value is a
 * broken (or hostile) file rather than a late error.
 */
const RFC1123_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Validate the app name, or THROW.
 *
 * REJECT, never escape. Escaping `My App` would produce a valid `package.json`
 * carrying a name Kubernetes refuses at deploy time — the failure just moves
 * further from its cause. This mirrors `renderScaffold`'s refusal to emit an
 * unsubstituted placeholder: the scaffolder does not ship something it knows
 * is wrong.
 */
export function assertValidAppName(name: string): void {
    if (name.length === 0 || name.length > 63 || !RFC1123_LABEL.test(name)) {
        throw new UsageError(
            `invalid app name ${JSON.stringify(name)} — it becomes the NextApp / ` +
                "Knative Service name, so it must be an RFC1123 label: lowercase " +
                "alphanumerics and '-', starting and ending alphanumeric, at most " +
                "63 characters (e.g. 'hello-knext'). Pass --name to choose one.",
        );
    }
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
    /** Install command matching the lockfile at the tracing root. */
    installCmd?: string;
    templates?: Map<string, string>;
}

/**
 * Substitute the template variables. Deliberately strict: an unknown or
 * misspelled `{{ … }}` THROWS rather than shipping a literal placeholder into a
 * user's app (a silently-unsubstituted path in the seam guard would make it
 * skip forever).
 */
export function renderScaffold(opts: RenderOptions): Map<string, string> {
    // Validate BEFORE substituting: the name lands in JSON, TS and JSX, and an
    // invalid one produces files that do not parse (verified: `ev"il` emitted a
    // package.json that is not JSON) or a Service name Kubernetes refuses.
    assertValidAppName(opts.name);
    const vars: Record<string, string> = {
        name: opts.name,
        standalonePrefix: opts.standalonePrefix,
        version: opts.version,
        installCmd: opts.installCmd ?? NO_LOCKFILE_INSTALL,
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
    const layout = resolveLayout(appDir);
    const files = renderScaffold({
        name,
        standalonePrefix: layout.standalonePrefix,
        installCmd: layout.installCmd,
        version: opts.version ?? cliVersion(),
        templates: opts.templates,
    });

    if (!opts.force) {
        const clashes = [...files.keys()].filter((rel) =>
            existsSync(join(appDir, rel)),
        );
        if (clashes.length > 0) {
            throw new UsageError(
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

/**
 * The scaffold's parting words (UX ledger row 3a). The persona is a Next.js
 * developer with zero cluster knowledge, so this speaks their language: the
 * real next steps in the order they will type them. The seam guard is still
 * mentioned — last, and in plain words — because it matters before a
 * production build ships, not on day one.
 */
export function partingLine(dir: string): string {
    const cdPrefix = dir === "." ? "" : `cd ${dir} && `;
    return (
        "\nNext steps:\n" +
        `  ${cdPrefix}npm install\n` +
        "  npm run dev              # local dev server on http://localhost:3000\n" +
        "\nWhen you are ready to put it on your cluster:\n" +
        "  kn-next doctor           # checks your cluster connection and setup\n" +
        "  kn-next deploy           # builds the image and ships the app\n" +
        "\nBefore you ship real traffic, run `npm run test:seam` once — it " +
        "double-checks\nthat the app's built-in tracing still works after a " +
        "production build.\n"
    );
}

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

    if (positionals.length > 1) {
        // A silently-ignored extra positional is how `create app --name x y`
        // scaffolds somewhere the user did not mean. Same discipline as the
        // strict flag parser above.
        process.stderr.write(
            `unexpected extra argument(s): ${positionals.slice(1).join(" ")}\n\n${HELP}`,
        );
        return 1;
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
                (values["dry-run"] ? "" : partingLine(positionals[0] ?? ".")),
        );
        return 0;
    } catch (err) {
        // A user mistake (an app name that is not an RFC1123 label, a scaffold
        // that would overwrite files) is a message, not a dump: `log.error({
        // err })` below still serialises the Error with its stack, which is the
        // presentation ADR-0046 removes.
        // Written through process.stderr.write, not fs.writeSync(2), to match
        // this module's other user-facing rejections (the parseArgs catch
        // above) — createMain RETURNS an exit code rather than exiting here, so
        // the bin's own exit is what flushes.
        if (handleUsageError(err, (text) => void process.stderr.write(text))) {
            return 1;
        }
        // Write the REASON to stderr directly, not only through the logger:
        // pino's transport is async and its object rendering buries the message
        // the user needs ("invalid app name … must be an RFC1123 label"), which
        // turns an actionable rejection into a bare "create failed".
        process.stderr.write(`kn-next create: ${(err as Error).message}\n`);
        log.error({ err }, "create failed");
        return 1;
    }
}

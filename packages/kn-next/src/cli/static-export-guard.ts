/**
 * Refuse a static export (`output: 'export'`) as a knext deployment.
 *
 * knext deploys a Next.js SERVER. `output: 'export'` makes `next build` emit a
 * static `out/` folder and no server, so carrying on would build an image with
 * nothing to run. The adapter deliberately leaves an explicit `export` alone
 * (so Next runs its own export validation); this is the CLI half, called by
 * `runProjectBuild` so build, deploy and preview all share it.
 *
 * Two signals, one per build path:
 *  - Next build: Next writes `<distDir>/export-detail.json` when it exports,
 *    and deletes it on every non-export build, so a present file always
 *    belongs to the build that just ran. `distDir` is read from next.config.
 *  - vinext build: vinext handles `output: 'export'` itself and never writes
 *    that file, so the literal `output` in next.config is checked BEFORE the
 *    build (it would only waste a `vite build`).
 *
 * Both read next.config as text, like the turbopack-fragments guard: a value
 * computed at runtime is not visible. An unreadable config is refused rather
 * than assumed clean.
 *
 * Known shared debt: build.ts, build-artifact.ts and standalone-layout.ts
 * still assume `.next`; only this guard honours a custom `distDir`.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { stripComments } from "./doctor/checks/use-cache";
import { UsageError } from "./shared";
import { readNextConfigStrict } from "./turbopack-fragments-guard";

/** Written by `next build` only for `output: 'export'` (removed otherwise). */
const EXPORT_DETAIL_FILE = "export-detail.json";
const DEFAULT_DIST_DIR = ".next";

const STATIC_EXPORT_MESSAGE = `This app builds as a static export (\`output: 'export'\`), and a static export is not a server deployment.

knext deploys a Next.js server, so there is nothing for it to run from an export.
Either remove \`output: 'export'\` from your Next.js config and build again,
or host the \`out/\` folder on a static host instead.`;

/** The literal `distDir` in the config text, or undefined (default `.next`). */
export function configuredDistDir(configText: string): string | undefined {
    return stripComments(configText).match(
        /\bdistDir\s*:\s*(["'`])([^"'`\n]+)\1/,
    )?.[2];
}

/**
 * How the config text declares `output: 'export'`:
 *  - `unconditional`: a top-level property of the config object literal
 *    (exactly one enclosing `{`, no `[`; wrapping calls like `defineConfig(`
 *    are fine). The app really is a static export.
 *  - `conditional`: the literal appears, but under a spread, ternary branch,
 *    nested object, array or function body, or the structure cannot be
 *    determined. A heuristic must never block a working app, so this only warns.
 *  - `none`: the literal never appears.
 */
export type StaticExportDeclaration = "unconditional" | "conditional" | "none";

export function classifyStaticExport(
    configText: string,
): StaticExportDeclaration {
    const text = stripComments(configText);
    const re = /\boutput\s*:\s*(["'`])export\1/g;
    let result: StaticExportDeclaration = "none";
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
        const stack: string[] = [];
        let quote: string | undefined;
        let broken = false;
        for (let i = 0; i < m.index; i++) {
            const c = text[i];
            if (quote) {
                if (c === "\\") i++;
                else if (c === quote) quote = undefined;
            } else if (c === '"' || c === "'" || c === "`") quote = c;
            else if (c === "{" || c === "[" || c === "(") stack.push(c);
            else if (c === "}" || c === "]" || c === ")") {
                if (stack.pop() === undefined) broken = true;
            }
        }
        const braces = stack.filter((c) => c === "{").length;
        const brackets = stack.filter((c) => c === "[").length;
        const prev = text.slice(0, m.index).trimEnd().slice(-1);
        const unconditional =
            !broken &&
            quote === undefined &&
            braces === 1 &&
            brackets === 0 &&
            stack.lastIndexOf("{") === stack.length - 1 &&
            (prev === "{" || prev === ",");
        if (unconditional) return "unconditional";
        result = "conditional";
    }
    return result;
}

function readConfigOrRefuse(
    readNextConfig: () => string | undefined,
): string | undefined {
    try {
        return readNextConfig();
    } catch (err) {
        throw new UsageError(
            `Could not read your next.config to check for a static export (\`output: 'export'\`), which knext cannot deploy (${err instanceof Error ? err.message : String(err)}). Fix the file's permissions and try again.`,
        );
    }
}

/** After a Next build: refuse if it wrote an export marker into `distDir`. */
export function assertNotStaticExport(
    cwd: string,
    readNextConfig: () => string | undefined = () => readNextConfigStrict(cwd),
): void {
    const text = readConfigOrRefuse(readNextConfig);
    const distDir =
        (text === undefined ? undefined : configuredDistDir(text)) ??
        DEFAULT_DIST_DIR;
    if (existsSync(resolve(cwd, distDir, EXPORT_DETAIL_FILE))) {
        throw new UsageError(STATIC_EXPORT_MESSAGE);
    }
}

/** Before a vinext build: refuse an app whose config unconditionally asks for a static export. */
export function assertVinextNotStaticExport(
    cwd: string,
    readNextConfig: () => string | undefined = () => readNextConfigStrict(cwd),
    warn: (line: string) => void = (line) => {
        process.stderr.write(`${line}\n`);
    },
): void {
    const text = readConfigOrRefuse(readNextConfig);
    if (text === undefined) return;
    const kind = classifyStaticExport(text);
    if (kind === "unconditional") throw new UsageError(STATIC_EXPORT_MESSAGE);
    if (kind === "conditional") {
        warn(
            "warning: your next.config sets `output: 'export'` under a condition or inside a nested value; a static export is not a server deployment and knext deploys standalone only. Continuing the build.",
        );
    }
}

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

/** True iff the config text sets `output` to the literal `'export'`. */
export function declaresStaticExport(configText: string): boolean {
    return /\boutput\s*:\s*(["'`])export\1/.test(stripComments(configText));
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

/** Before a vinext build: refuse an app whose config asks for a static export. */
export function assertVinextNotStaticExport(
    cwd: string,
    readNextConfig: () => string | undefined = () => readNextConfigStrict(cwd),
): void {
    const text = readConfigOrRefuse(readNextConfig);
    if (text !== undefined && declaresStaticExport(text)) {
        throw new UsageError(STATIC_EXPORT_MESSAGE);
    }
}

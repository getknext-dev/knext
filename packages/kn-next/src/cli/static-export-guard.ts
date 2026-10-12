/**
 * Refuse a static export (`output: 'export'`) as a knext deployment.
 *
 * knext deploys a Next.js SERVER. `output: 'export'` makes `next build` emit a
 * static `out/` folder and no server, so carrying on would build an image with
 * nothing to run. The adapter deliberately leaves an explicit `export` alone
 * (so Next runs its own export validation); this is the CLI half, called by
 * `runProjectBuild` after the project's build so build, deploy and preview all
 * share it.
 *
 * Signal: Next writes `<distDir>/export-detail.json` when it exports, and
 * deletes it on every non-export build, so a present file always belongs to
 * the build that just ran.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { UsageError } from "./shared";

/** Written by `next build` only for `output: 'export'` (removed otherwise). */
const EXPORT_DETAIL_FILE = "export-detail.json";

const STATIC_EXPORT_MESSAGE = `This app builds as a static export (\`output: 'export'\`), and a static export is not a server deployment.

knext deploys a Next.js server, so there is nothing for it to run from an export.
Either remove \`output: 'export'\` from your Next.js config and build again,
or host the \`out/\` folder on a static host instead.`;

export function assertNotStaticExport(cwd: string): void {
    if (existsSync(join(cwd, ".next", EXPORT_DETAIL_FILE))) {
        throw new UsageError(STATIC_EXPORT_MESSAGE);
    }
}

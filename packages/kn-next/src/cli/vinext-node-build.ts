/**
 * vinext × node (#1260) — the build-side checks for the node-preset nitro
 * output.
 *
 * This cell compiles nothing. `vite build` (the app's own build script) emits
 * nitro's `node` preset, `node .output/server/index.mjs` runs it, and its
 * bytecode caching is the V8 compile cache the IMAGE bakes at `docker build`
 * time (ADR-0035) — see `templates/app/Dockerfile.vinext-node.hbs`.
 *
 * What `kn-next build` owes this cell is therefore one check: that the
 * `.output` it is about to hand to that image really IS the node preset. The
 * preset is chosen in the app's `vite.config.ts`, and an app scaffolded before
 * #1260 hardcodes `preset: 'bun'` there — switching such an app to
 * `runtime: 'node'` would build a bun-preset entry that exits 1 under node
 * (`Bun is not defined`, measured). That is caught HERE, naming the fix,
 * rather than at the image's cache bake or on a cluster.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UsageError } from "./shared";

/** What nitro writes into `.output/nitro.json` for its `node` preset. */
export const NODE_NITRO_PRESET = "node-server";

/**
 * Refuse unless `<cwd>/.output` is a node-preset nitro build with its entry.
 * Reads `.output/nitro.json` — nitro's own record of what it built — rather
 * than grepping the bundle.
 */
export function assertNodePresetOutput(cwd: string): void {
    const manifest = join(cwd, ".output", "nitro.json");
    if (!existsSync(manifest)) {
        throw new UsageError(
            `No ${join(".output", "nitro.json")} — the vinext build did not produce a nitro output, so the node image would have nothing to run.\n\n` +
                "Run the project build (`vite build`) first, or drop --skip-next.",
        );
    }
    let preset: unknown;
    try {
        preset = (
            JSON.parse(readFileSync(manifest, "utf8")) as { preset?: unknown }
        ).preset;
    } catch (error) {
        throw new UsageError(
            `${manifest} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    if (preset !== NODE_NITRO_PRESET) {
        throw new UsageError(
            `runtime: 'node' needs nitro's '${NODE_NITRO_PRESET}' preset, but this build produced '${String(preset)}'.\n\n` +
                (preset === "bun"
                    ? "A bun-preset server calls Bun's own APIs at startup and exits 1 under node.\n"
                    : "") +
                "Your vite.config.ts chooses the preset. Apps created by current `kn-next create` read it\n" +
                "from kn-next.config.ts's `runtime`; an older app hardcodes `preset: 'bun'`. To fix:\n" +
                "  1. copy knext-node-entry.mjs into this app (from a freshly created app —\n" +
                "     `npx kn-next create` — it sits next to knext-bun-entry.mjs);\n" +
                "  2. make the nitro plugin in vite.config.ts use `preset: 'node'` with\n" +
                "     `entry: './knext-node-entry.mjs'` when runtime is node;\n" +
                "  3. declare `srvx` in package.json (the node entry imports srvx/node).\n" +
                'Then rebuild. The build-pipeline docs ("vinext on Node") show the full vite.config.ts.',
        );
    }
    const entry = join(cwd, ".output", "server", "index.mjs");
    if (!existsSync(entry)) {
        throw new UsageError(
            `${join(".output", "nitro.json")} says '${NODE_NITRO_PRESET}' but ${join(".output", "server", "index.mjs")} is missing — the image's CMD would have nothing to start.`,
        );
    }
}

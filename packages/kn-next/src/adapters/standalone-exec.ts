/**
 * How the standalone supervisor (`node-server.ts`) starts the Next child.
 *
 * The uncompiled cells run `<runtime> [--require preloads…] server.js`. The
 * compiled standalone-on-Bun cell ships `next build`'s server as a Bun single
 * executable with bytecode (`standalone-compile.mjs`); the image points
 * STANDALONE_SERVER_EXEC at it. That executable takes NO arguments — a compiled
 * binary's argv is the app's, so it cannot take `--require` — and its preloads
 * are compiled in, so the plan drops both the preloads and the script path.
 *
 * Pure (env + paths in, argv out) so the choice is unit-tested; the
 * supervisor module itself starts a server on import.
 */

import { resolve } from "node:path";

/** The env var naming the compiled standalone executable. */
export const STANDALONE_SERVER_EXEC_ENV = "STANDALONE_SERVER_EXEC";

export interface ChildSpawnPlan {
    readonly mode: "script" | "exec";
    readonly command: string;
    readonly args: readonly string[];
}

export function childSpawnPlan(opts: {
    env: Record<string, string | undefined>;
    cwd: string;
    execPath: string;
    serverJs: string;
    preloadArgs: readonly string[];
}): ChildSpawnPlan {
    const exec = opts.env[STANDALONE_SERVER_EXEC_ENV];
    if (exec) {
        return { mode: "exec", command: resolve(opts.cwd, exec), args: [] };
    }
    return {
        mode: "script",
        command: opts.execPath,
        args: [...opts.preloadArgs, opts.serverJs],
    };
}

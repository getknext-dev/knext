/**
 * exec.ts — node:child_process exec helpers for the knext CLI.
 *
 * Replaces Bun's `$` shell-template tag. Every former `` $`a b ${c}` `` call
 * becomes an ARGV array `["a", "b", c]` passed to one of these helpers.
 *
 * SECURITY (CLI-58): all helpers run with **`shell: false`** — the command is
 * spawned directly via the OS exec, NOT through `/bin/sh`. Arguments are passed
 * as a discrete argv array, so a value containing shell metacharacters
 * (`;`, backtick, `$()`, spaces, newlines) arrives as a single, uninterpreted
 * token and can never inject a second command. Do NOT reintroduce string-
 * interpolated shell here.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Returns true when the module identified by `importMetaUrl` is being run as the
 * process entry (i.e. `node <thisfile>`), false when it was imported (e.g. by a
 * test). Node-correct replacement for Bun's `import.meta.main`.
 *
 * CRITICAL: npm installs the CLI bins as SYMLINKS — both node_modules/.bin/
 * knext AND node_modules/.bin/kn-next point at the SAME real file,
 * .../dist/cli/kn-next.js (#1369, rev-1380: a second dist file broke `npx
 * @getknext/core`'s bin auto-pick for every consumer). When run via either
 * symlink, `process.argv[1]` is the symlink path while `import.meta.url`
 * resolves to the REAL file. Both sides are therefore passed through
 * realpathSync so the comparison holds for symlinked bins — without this,
 * the entry guard never fires and the CLI silently no-ops. (The deprecation
 * notice in shared.ts relies on the OPPOSITE fact — that `argv[1]` is the
 * symlink path, NOT yet realpath-resolved — to tell `knext` and `kn-next`
 * apart; it deliberately does not call this function.)
 */
export function isEntrypoint(importMetaUrl: string): boolean {
    const argv1 = process.argv[1];
    if (!argv1) {
        return false;
    }
    try {
        const self = realpathSync(fileURLToPath(importMetaUrl));
        const invoked = realpathSync(resolve(argv1));
        return self === invoked;
    } catch {
        return false;
    }
}

/**
 * Run a command (argv array) and CAPTURE its stdout as a trimmed string.
 *
 * No shell. argv[0] is the binary; argv[1..] are arguments. stderr is inherited
 * so failures are visible; a non-zero exit throws (execFileSync semantics).
 *
 * @param argv - command + args, e.g. ["docker", "inspect", ref]
 * @returns trimmed stdout
 */
export function runCapture(argv: readonly string[]): string {
    const [cmd, ...args] = argv;
    if (!cmd) {
        throw new Error("runCapture: empty argv");
    }
    const out = execFileSync(cmd, args, {
        shell: false,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "inherit"],
        maxBuffer: 64 * 1024 * 1024,
    });
    return out.toString().trim();
}

/**
 * Run a command (argv array) and INHERIT stdio (stream child output straight to
 * the terminal). No captured value. A non-zero exit throws.
 *
 * @param argv - command + args, e.g. ["kubectl", "apply", "-f", path]
 */
export function runInherit(argv: readonly string[]): void {
    const [cmd, ...args] = argv;
    if (!cmd) {
        throw new Error("runInherit: empty argv");
    }
    execFileSync(cmd, args, {
        shell: false,
        stdio: "inherit",
        maxBuffer: 64 * 1024 * 1024,
    });
}

export interface RunQuietOptions {
    /**
     * #1385 — `runQuiet` discards stdout wholesale, so any diagnostic a
     * child process prints there (the vinext compile step's build warnings,
     * e.g. createRequire-staticize warnings — see
     * `apps/docs/content/docs/build-pipeline.mdx`) never reached
     * `kn-next build` users, even though the docs quote them verbatim.
     *
     * When set, stdout lines starting with this exact prefix are printed
     * (via `console.log`, one call per line) AFTER the command finishes —
     * even on a non-zero exit, before the error is rethrown, since a
     * warning printed right before a failure is exactly the context a user
     * needs. Every other stdout line stays discarded: normal build noise
     * (e.g. `npx vite build`'s own chatter) is unaffected. Undefined
     * (default) preserves the original fully-quiet behaviour byte for byte.
     */
    readonly surfaceStdoutPrefix?: string;
}

/** Prints each line of `output` that starts with `prefix`, in order. */
function surfacePrefixedLines(output: string, prefix: string): void {
    for (const line of output.split("\n")) {
        if (line.startsWith(prefix)) {
            console.log(line);
        }
    }
}

/**
 * Run a command (argv array) QUIETLY — discard stdout, inherit stderr. A
 * non-zero exit throws. Use where the former code called `.quiet()` purely to
 * silence stdout.
 *
 * @param argv - command + args
 * @param options - see {@link RunQuietOptions}
 */
export function runQuiet(
    argv: readonly string[],
    options: RunQuietOptions = {},
): void {
    const [cmd, ...args] = argv;
    if (!cmd) {
        throw new Error("runQuiet: empty argv");
    }
    const { surfaceStdoutPrefix } = options;
    if (!surfaceStdoutPrefix) {
        execFileSync(cmd, args, {
            shell: false,
            stdio: ["ignore", "ignore", "inherit"],
            maxBuffer: 64 * 1024 * 1024,
        });
        return;
    }
    // stdout must be CAPTURED (not discarded) to filter it, but is never
    // otherwise printed — only the matching lines are, via
    // `surfacePrefixedLines` below. stderr stays inherited, same as the
    // fully-quiet path.
    try {
        const out = execFileSync(cmd, args, {
            shell: false,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "inherit"],
            maxBuffer: 64 * 1024 * 1024,
        });
        surfacePrefixedLines(out, surfaceStdoutPrefix);
    } catch (error) {
        // execFileSync attaches captured stdout to the thrown error even on
        // a non-zero exit (Node's child_process contract) — surface a
        // warning that was printed right before the failure, then rethrow
        // unchanged so callers' error handling is unaffected.
        const captured = (error as { stdout?: string | Buffer }).stdout;
        if (typeof captured === "string") {
            surfacePrefixedLines(captured, surfaceStdoutPrefix);
        } else if (Buffer.isBuffer(captured)) {
            surfacePrefixedLines(
                captured.toString("utf-8"),
                surfaceStdoutPrefix,
            );
        }
        throw error;
    }
}

/**
 * Like {@link runQuiet} but TOLERATES a non-zero exit (does not throw). Mirrors
 * the old `... || true` shell idiom used for best-effort cleanup deletes.
 *
 * @param argv - command + args
 */
export function runQuietAllowFail(argv: readonly string[]): void {
    const [cmd, ...args] = argv;
    if (!cmd) {
        throw new Error("runQuietAllowFail: empty argv");
    }
    spawnSync(cmd, args, {
        shell: false,
        stdio: ["ignore", "ignore", "inherit"],
        maxBuffer: 64 * 1024 * 1024,
    });
}

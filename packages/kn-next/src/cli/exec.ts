/**
 * exec.ts — node:child_process exec helpers for the kn-next CLI.
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
 * CRITICAL: npm installs the CLI bin as a SYMLINK (node_modules/.bin/kn-next →
 * .../dist/cli/kn-next.js). When run via that symlink, `process.argv[1]` is the
 * symlink path while `import.meta.url` resolves to the REAL file. Both sides are
 * therefore passed through realpathSync so the comparison holds for symlinked
 * bins — without this, the entry guard never fires and the CLI silently no-ops.
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

/**
 * Run a command (argv array) QUIETLY — discard stdout, inherit stderr. A
 * non-zero exit throws. Use where the former code called `.quiet()` purely to
 * silence stdout.
 *
 * @param argv - command + args
 */
export function runQuiet(argv: readonly string[]): void {
    const [cmd, ...args] = argv;
    if (!cmd) {
        throw new Error("runQuiet: empty argv");
    }
    execFileSync(cmd, args, {
        shell: false,
        stdio: ["ignore", "ignore", "inherit"],
        maxBuffer: 64 * 1024 * 1024,
    });
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

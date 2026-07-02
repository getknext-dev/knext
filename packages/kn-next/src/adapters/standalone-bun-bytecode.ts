/**
 * Per-file Bun bytecode precompilation for the standalone tree (runtime=bun).
 *
 * WHY PER-FILE, NOT A BUNDLE: bundling the standalone entry
 * (`bun build server.js --bytecode`) hard-fails — `next build` prunes
 * dev-only modules that `next/dist/server/next.js` still `require()`s
 * (`./dev/next-dev-server`, `./router-utils/setup-dev-bundler`; Bun's
 * `--external` does not accept relative paths), and route chunks are loaded
 * via runtime-computed `require()` a static bundle cannot capture. Instead,
 * each server-side .js file is transformed INDIVIDUALLY with
 * `--external '*'`, which keeps every `require()` verbatim (graph untouched)
 * while emitting a companion `<file>.jsc` with precompiled JSC bytecode.
 *
 * WHY IT WORKS: Bun's runtime consumes the companion .jsc for require()'d
 * files, not just the entry, gated on the `// @bun @bytecode @bun-cjs`
 * pragma the transform writes, and validated against the source — a stale,
 * corrupt, or other-Bun-version .jsc silently falls back to executing the
 * source (verified by corrupting/deleting .jsc: no warning, correct output).
 * Measured on a real next@16.2.4 standalone tree (Bun 1.3.5, N=12,
 * spawn → first dynamic-route response): 287ms plain → 152ms with the pass
 * (-47%); the runtime transpiler cache composes on top (145ms warm).
 *
 * HARD CONSTRAINT — BUN-ONLY OUTPUT, MADE LOUD: a transformed file is a
 * pragma'd CJS wrapper that DOES NOT LOAD UNDER NODE — and it fails
 * SILENTLY there (the wrapper is an expression statement; module.exports is
 * never assigned, so Node "runs" it to empty exports and exits — a mute
 * CrashLoop in a pod). Two defenses:
 *   1. ENTRY FILES (server.js with a sibling .next dir) are NEVER
 *      transformed — their own bytecode win is negligible (~3KB of source);
 *   2. after a successful pass, each entry gets a fail-fast guard prepended
 *      so `node server.js` on a bytecode-built image exits 1 with a FATAL
 *      message naming the fix (boot with bun, or rebuild with
 *      runtime: node / KNEXT_BUN_BYTECODE=0).
 * Callers still gate the pass on an explicit bun runtime choice — flipping
 * a bytecode-built image back to the Node runtime requires a rebuild.
 *
 * COSTS (documented, not hidden): .jsc roughly doubles-to-triples the tree
 * (37MB → 95MB on the minimal app); the pass spawns one `bun build` per
 * file — measured ~11-14s for the 969-file minimal-app tree (Bun 1.3.5,
 * M-series laptop; a single multi-entry invocation crashes Bun 1.3.5, hence
 * per-file spawns). Bytecode is tied to the Bun version that built it — a
 * version mismatch only forfeits the win (source fallback).
 *
 * FAIL-OPEN: any per-file failure leaves that file byte-identical (reason
 * reported in `skipped`); a failed capability probe (old Bun, missing
 * binary) disables the whole pass; temp dirs are always cleaned up; this
 * function never throws.
 */

import { spawnSync } from "node:child_process";
import {
    copyFileSync,
    existsSync,
    lstatSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";

export interface BytecodePassResult {
    /** files transformed in place (companion .jsc written) */
    compiled: number;
    /** human-readable reasons for per-file skips (fail-open) */
    skipped: string[];
    /** entry files that received the fail-fast Node guard */
    guarded: string[];
    /** set when the whole pass was disabled (probe failed / no bun binary) */
    disabled?: string;
}

export interface BytecodePassOptions {
    standaloneDir: string;
    /** Bun binary; defaults to the running Bun, else `bun` on PATH. */
    bunBin?: string;
    log?: (message: string) => void;
}

const GUARD_MARKER = "// knext: bun-only build guard";
const ENTRY_GUARD = `${GUARD_MARKER} (injected by kn-next build)
if (!process.versions.bun) {
    console.error(
        "FATAL: this build was bytecode-compiled for Bun (spec.runtime: bun). " +
            "Boot with bun, or rebuild with runtime: node / KNEXT_BUN_BYTECODE=0.",
    );
    process.exit(1);
}
`;

/** `.next/static` is served verbatim to browsers — never transform it. */
function isStaticAsset(path: string): boolean {
    return path.includes(`${sep}.next${sep}static${sep}`);
}

/**
 * A standalone ENTRY (`server.js` beside a `.next` dir — the file
 * STANDALONE_SERVER_PATH points at, incl. monorepo subpaths). Entries are
 * never transformed and receive the fail-fast Node guard instead.
 */
function isStandaloneEntry(path: string): boolean {
    return (
        basename(path) === "server.js" &&
        existsSync(join(dirname(path), ".next"))
    );
}

function* walkJsFiles(
    dir: string,
): Generator<{ path: string; entry: boolean }> {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        let st: ReturnType<typeof lstatSync>;
        try {
            // lstat, NOT stat: transforming through a symlink would write
            // into its target (e.g. the shared pnpm store) — skip links
            // entirely, files and directories alike.
            st = lstatSync(path);
        } catch {
            continue;
        }
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
            yield* walkJsFiles(path);
        } else if (name.endsWith(".js") && !isStaticAsset(path)) {
            yield { path, entry: isStandaloneEntry(path) };
        }
    }
}

/** Transform one file into `outDir`; returns the built js/.jsc paths or throws. */
function buildOne(
    bunBin: string,
    file: string,
    outDir: string,
): { js: string; jsc: string } {
    const result = spawnSync(
        bunBin,
        [
            "build",
            file,
            "--bytecode",
            "--target=bun",
            "--format=cjs",
            "--external",
            "*",
            "--outdir",
            outDir,
        ],
        { stdio: "pipe", timeout: 60_000 },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(
            result.stderr?.toString().trim().slice(0, 300) ||
                `bun build exited ${result.status}`,
        );
    }
    const js = join(outDir, basename(file));
    const jsc = `${js}.jsc`;
    if (!existsSync(js) || !existsSync(jsc)) {
        throw new Error("bun build emitted no bytecode artifact");
    }
    return { js, jsc };
}

/**
 * Capability probe: transform a trivial file in tmp. Fails on Bun versions
 * without non-compile `--bytecode` emission (needs ≥1.1.30) or a missing
 * binary — in which case the whole pass is disabled (fail-open).
 */
function probe(bunBin: string): string | undefined {
    let dir: string | undefined;
    try {
        dir = mkdtempSync(join(tmpdir(), "knext-bc-probe-"));
        const src = join(dir, "probe.js");
        writeFileSync(src, "module.exports = 1;\n");
        buildOne(bunBin, src, join(dir, "out"));
        return undefined;
    } catch (err) {
        return err instanceof Error ? err.message : String(err);
    } finally {
        if (dir) rmSync(dir, { recursive: true, force: true });
    }
}

/** Prepend the fail-fast Node guard to an entry (idempotent). */
function guardEntry(file: string): boolean {
    const src = readFileSync(file, "utf8");
    if (src.startsWith(GUARD_MARKER)) return false;
    writeFileSync(file, ENTRY_GUARD + src);
    return true;
}

export function precompileBunBytecode(
    options: BytecodePassOptions,
): BytecodePassResult {
    const log = options.log ?? (() => {});
    const bunBin =
        options.bunBin ?? (process.versions.bun ? process.execPath : "bun");
    const result: BytecodePassResult = {
        compiled: 0,
        skipped: [],
        guarded: [],
    };

    try {
        if (!existsSync(options.standaloneDir)) {
            result.disabled = `standalone dir not found: ${options.standaloneDir}`;
            return result;
        }
        const disabledReason = probe(bunBin);
        if (disabledReason) {
            result.disabled = `bun bytecode emission unavailable (${bunBin}): ${disabledReason}`;
            log(result.disabled);
            return result;
        }
        const entries: string[] = [];
        for (const { path: file, entry } of walkJsFiles(
            options.standaloneDir,
        )) {
            if (entry) {
                entries.push(file);
                continue;
            }
            let outDir: string | undefined;
            try {
                outDir = mkdtempSync(join(tmpdir(), "knext-bc-"));
                const built = buildOne(bunBin, file, outDir);
                // Replace only after BOTH artifacts exist — a failure above
                // leaves the original byte-identical (fail-open).
                copyFileSync(built.js, file);
                copyFileSync(built.jsc, `${file}.jsc`);
                result.compiled++;
            } catch (err) {
                const reason = `${file}: ${err instanceof Error ? err.message : String(err)}`;
                result.skipped.push(reason);
                log(`bytecode skip (fail-open): ${reason}`);
            } finally {
                if (outDir) rmSync(outDir, { recursive: true, force: true });
            }
        }
        // The tree is now Bun-only where it matters — make `node server.js`
        // fail LOUDLY instead of exiting mutely with empty exports. Entries
        // stay untransformed (guard is plain JS; Bun passes straight through).
        if (result.compiled > 0) {
            for (const entry of entries) {
                try {
                    if (guardEntry(entry)) result.guarded.push(entry);
                } catch (err) {
                    log(
                        `entry guard failed (non-fatal) for ${entry}: ${
                            err instanceof Error ? err.message : String(err)
                        }`,
                    );
                }
            }
        }
    } catch (err) {
        // Never break the build over an optimization pass.
        result.disabled = `bytecode pass aborted: ${err instanceof Error ? err.message : String(err)}`;
        log(result.disabled);
    }
    return result;
}

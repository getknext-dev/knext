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
 * HARD CONSTRAINT — BUN-ONLY OUTPUT: the transformed file is a pragma'd CJS
 * wrapper that DOES NOT LOAD UNDER NODE (the wrapper is an expression
 * statement; module.exports is never assigned — a transformed tree never
 * boots under `node server.js`, verified). Callers MUST gate this pass on
 * an explicit bun runtime choice; it is deliberately NOT unconditional like
 * the additive bun-exports heal.
 *
 * COSTS (documented, not hidden): .jsc roughly doubles-to-triples the tree
 * (37MB → 95MB on the minimal app) and is tied to the Bun version that
 * built it — a version mismatch only forfeits the win (source fallback).
 *
 * FAIL-OPEN: any per-file failure leaves that file byte-identical; a failed
 * capability probe (old Bun, missing binary) disables the whole pass; this
 * function never throws.
 */

import { spawnSync } from "node:child_process";
import {
    copyFileSync,
    existsSync,
    mkdtempSync,
    readdirSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";

export interface BytecodePassResult {
    /** files transformed in place (companion .jsc written) */
    compiled: number;
    /** human-readable reasons for per-file skips (fail-open) */
    skipped: string[];
    /** set when the whole pass was disabled (probe failed / no bun binary) */
    disabled?: string;
}

export interface BytecodePassOptions {
    standaloneDir: string;
    /** Bun binary; defaults to the running Bun, else `bun` on PATH. */
    bunBin?: string;
    log?: (message: string) => void;
}

/** `.next/static` is served verbatim to browsers — never transform it. */
function isStaticAsset(path: string): boolean {
    return path.includes(`${sep}.next${sep}static${sep}`);
}

function* walkJsFiles(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        let st: ReturnType<typeof statSync>;
        try {
            st = statSync(path);
        } catch {
            continue;
        }
        if (st.isDirectory()) {
            yield* walkJsFiles(path);
        } else if (name.endsWith(".js") && !isStaticAsset(path)) {
            yield path;
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
    try {
        const dir = mkdtempSync(join(tmpdir(), "knext-bc-probe-"));
        const src = join(dir, "probe.js");
        writeFileSync(src, "module.exports = 1;\n");
        buildOne(bunBin, src, join(dir, "out"));
        return undefined;
    } catch (err) {
        return err instanceof Error ? err.message : String(err);
    }
}

export function precompileBunBytecode(
    options: BytecodePassOptions,
): BytecodePassResult {
    const log = options.log ?? (() => {});
    const bunBin =
        options.bunBin ?? (process.versions.bun ? process.execPath : "bun");
    const result: BytecodePassResult = { compiled: 0, skipped: [] };

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
        for (const file of walkJsFiles(options.standaloneDir)) {
            try {
                const outDir = mkdtempSync(join(tmpdir(), "knext-bc-"));
                const built = buildOne(bunBin, file, outDir);
                // Replace only after BOTH artifacts exist — a failure above
                // leaves the original byte-identical (fail-open).
                copyFileSync(built.js, file);
                copyFileSync(built.jsc, `${file}.jsc`);
                result.compiled++;
            } catch (err) {
                result.skipped.push(
                    `${file}: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }
    } catch (err) {
        // Never break the build over an optimization pass.
        result.disabled = `bytecode pass aborted: ${err instanceof Error ? err.message : String(err)}`;
        log(result.disabled);
    }
    return result;
}

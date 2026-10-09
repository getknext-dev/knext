/**
 * #1863 — the ARP primer must actually be the FIRST thing to run when a
 * compiled vinext executable boots, not merely first in the source text.
 *
 * `arp-primer-entry-order.test.ts` proves the TEXT order of the injected
 * imports (the same source-order-guard pattern `deferred-default-metrics
 * .test.ts` uses) — that is sound for a static import list, but it reads
 * `vinext-compile.mjs`'s source, never runs it. This file closes that gap by
 * actually COMPILING a minimal nitro-shaped entry with the real
 * `vinext-compile.mjs` and EXECUTING the resulting binary, so the assertion
 * is about the running process, not the script that built it.
 *
 * The real `arp-primer.cjs` has no observable side effect to assert on (it is
 * a fire-and-forget UDP send, Linux-only, and silently a no-op on this test
 * host's platform/route table — see `arp-primer.test.ts` for its own unit
 * coverage of that logic). So the compile pipeline is run against a COPY of
 * `src/adapters` whose `arp-primer.cjs` is replaced with a drop-in stub that
 * keeps the same "require fires a synchronous side effect, never throws"
 * shape but makes that side effect observable (`console.log`). Everything
 * else — the real `vinext-compile.mjs`, the real keep-alive guard, the real
 * sidecar resolver, the real cache-control preload — is untouched, so this
 * still proves the REAL injection order the shipped script produces.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    cpSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ADAPTERS_DIR = join(import.meta.dir, "..", "adapters");

const temps: string[] = [];
afterAll(() => {
    for (const d of temps) {
        rmSync(d, { recursive: true, force: true });
    }
});

/** realpath: macOS tmpdir is a /var -> /private/var symlink, and the compile
 *  script matches server modules by resolved path (see the sibling
 *  self-contained test, which does the same for the same reason). */
function temp(prefix: string): string {
    const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    temps.push(d);
    return d;
}

function write(path: string, body: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
}

const ARP_PRIMER_RAN_MARKER = "ARP_PRIMER_RAN_7f3c0f1b";
const ENTRY_RAN_MARKER = "ENTRY_RAN_RESULT:ok";

/**
 * A copy of the real `src/adapters` directory, with `arp-primer.cjs`
 * replaced by an observable stub. Every OTHER file — `vinext-compile.mjs`
 * itself, the keep-alive guard, the sidecar resolver, the cache-control
 * preload, `bun-base-exe.mjs`, etc. — is the real, unmodified source, copied
 * byte-for-byte, so the injection order this proves is the real one.
 */
function compileDirWithObservablePrimer(): string {
    const dir = temp("knext-1863-adapters-");
    cpSync(ADAPTERS_DIR, dir, { recursive: true });
    // Same require-time-side-effect shape as the real module (see its own
    // header: "requiring this file fires the primer immediately"), just with
    // an observable effect instead of a silent fire-and-forget UDP send.
    write(
        join(dir, "arp-primer.cjs"),
        `'use strict';\nconsole.log(${JSON.stringify(ARP_PRIMER_RAN_MARKER)});\nmodule.exports = {};\n`,
    );
    return dir;
}

/** A minimal nitro-shaped app root: `.output/server/index.mjs` only — this
 *  proof needs no public assets, no sharp, nothing self-contained. */
function minimalApp(): string {
    const work = temp("knext-1863-app-");
    write(
        join(work, ".output/server/index.mjs"),
        `console.log(${JSON.stringify(ENTRY_RAN_MARKER)});\n`,
    );
    write(
        join(work, "package.json"),
        JSON.stringify({ name: "app", private: true, type: "module" }),
    );
    return work;
}

function compile(
    compileScriptDir: string,
    work: string,
): ReturnType<typeof spawnSync> & { exe: string } {
    const exe = join(work, "knext-1863-exec");
    const r = spawnSync(
        process.execPath,
        [
            join(compileScriptDir, "vinext-compile.mjs"),
            "--entry",
            join(work, ".output/server/index.mjs"),
            "--outfile",
            exe,
        ],
        { cwd: work, encoding: "utf8", timeout: 120_000 },
    );
    return Object.assign(r, { exe });
}

describe("#1863 compiled vinext executable: the ARP primer runs BEFORE everything else at boot", () => {
    it("builds successfully with the stubbed primer in place", () => {
        const compileScriptDir = compileDirWithObservablePrimer();
        const work = minimalApp();
        const build = compile(compileScriptDir, work);
        expect(build.status, String(build.stderr)).toBe(0);
    }, 120_000);

    it("the primer's output appears in stdout BEFORE the entry's own first output", () => {
        const compileScriptDir = compileDirWithObservablePrimer();
        const work = minimalApp();
        const build = compile(compileScriptDir, work);
        expect(build.status, String(build.stderr)).toBe(0);

        const run = spawnSync(build.exe, [], {
            cwd: work,
            encoding: "utf8",
            timeout: 30_000,
        });
        const out = String(run.stdout);
        const primerAt = out.indexOf(ARP_PRIMER_RAN_MARKER);
        const entryAt = out.indexOf(ENTRY_RAN_MARKER);
        expect(
            primerAt,
            `stdout did not contain the primer marker: ${out}`,
        ).toBeGreaterThan(-1);
        expect(
            entryAt,
            `stdout did not contain the entry marker: ${out}`,
        ).toBeGreaterThan(-1);
        expect(primerAt).toBeLessThan(entryAt);
    }, 120_000);

    it("discriminates: with the REAL (non-stub) arp-primer.cjs, the entry still runs and produces no primer marker", () => {
        // Non-vacuity for the two tests above: proves the marker is coming from
        // the STUB specifically, not from something else in the pipeline that
        // would print it regardless of which arp-primer.cjs is on disk.
        const work = minimalApp();
        const build = compile(ADAPTERS_DIR, work);
        expect(build.status, String(build.stderr)).toBe(0);
        const run = spawnSync(build.exe, [], {
            cwd: work,
            encoding: "utf8",
            timeout: 30_000,
        });
        const out = String(run.stdout);
        expect(out).not.toContain(ARP_PRIMER_RAN_MARKER);
        expect(out).toContain(ENTRY_RAN_MARKER);
    }, 120_000);
});

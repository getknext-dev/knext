/**
 * "No kn-next.config.ts here" is an EXPECTED state, not a crash (UX ledger 1b).
 *
 * The binding persona is a Next.js developer with zero Kubernetes knowledge who
 * runs `npx @getknext/core` in the wrong directory. Before this guard that user
 * got a `FATAL` line with a JSON-serialised Error — message, stack, and bundler
 * chunk paths — which reads as "the tool is broken", not "you are in the wrong
 * directory".
 *
 * What is pinned here:
 *   1. loadConfig() marks the missing-config case with a STABLE, bundling-proof
 *      discriminator (`code`), so the entry can recognise it without relying on
 *      `instanceof` across a bundle boundary.
 *   2. The rendered guidance is plain English, names the two ways forward
 *      (`create` for a new app, write the file for an existing one), points at
 *      the real docs URL, and carries NO stack frame / chunk path.
 *   3. handleConfigNotFound() is a strict discriminator: any OTHER error is left
 *      alone so the existing FATAL path still reports genuine failures.
 *   4. SCAN, not enumeration: every CLI module that can be run as an entry
 *      (`isEntrypoint(import.meta.url)`) must route its catch through
 *      handleConfigNotFound — a new entry that forgets it reds this file.
 *   5. End-to-end through the real deploy entry: exit 1, guidance on stderr, no
 *      stack, no `FATAL`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
    CONFIG_NOT_FOUND_CODE,
    formatConfigNotFound,
    handleConfigNotFound,
    loadConfig,
} from "../cli/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..", "..");
const cliSrcDir = join(pkgRoot, "src", "cli");

/** A stack frame ("\n    at foo (/path/file.js:1:2)") or a bundler chunk path. */
const STACK_FRAME_RE = /\n\s+at\s/;
const CHUNK_PATH_RE = /\b[\w./-]+\.(?:js|cjs|mjs|ts):\d+/;

describe("loadConfig marks a missing config as an expected state", () => {
    it("rejects with the stable ERR_KN_CONFIG_NOT_FOUND code", async () => {
        const dir = mkdtempSync(join(tmpdir(), "knext-noconfig-"));
        const cwd = process.cwd();
        try {
            process.chdir(dir);
            const err = await loadConfig().then(
                () => undefined,
                (e: unknown) => e,
            );
            expect(err).toBeInstanceOf(Error);
            expect((err as { code?: string }).code).toBe(CONFIG_NOT_FOUND_CODE);
        } finally {
            process.chdir(cwd);
        }
    });
});

describe("formatConfigNotFound renders guidance, not an exception dump", () => {
    const text = formatConfigNotFound("/somewhere/my-app");

    it("says what kn-next.config.ts is, in plain English", () => {
        expect(text).toContain("kn-next.config.ts");
        // No Kubernetes jargon in the explanation the newcomer reads.
        expect(text).not.toMatch(/Knative|CRD|NextApp CR|kubectl|namespace/i);
    });

    it("points at `create` for a new app and at the docs for an existing one", () => {
        expect(text).toContain("npx @getknext/core create");
        expect(text).toContain("https://knext.dev");
    });

    it("names the directory that was searched", () => {
        expect(text).toContain("/somewhere/my-app");
    });

    it("carries no stack frame and no bundler chunk path", () => {
        expect(text).not.toMatch(STACK_FRAME_RE);
        expect(text).not.toMatch(CHUNK_PATH_RE);
        expect(text).not.toContain("FATAL");
    });
});

describe("handleConfigNotFound only claims the missing-config error", () => {
    it("handles the config-not-found error and writes the guidance", () => {
        const out: string[] = [];
        const err = Object.assign(new Error("Config file not found: /x"), {
            code: CONFIG_NOT_FOUND_CODE,
            searchedDir: "/x",
        });
        expect(handleConfigNotFound(err, (t) => out.push(t))).toBe(true);
        expect(out.join("")).toContain("npx @getknext/core create");
    });

    it("leaves every other error to the existing FATAL path", () => {
        const out: string[] = [];
        expect(
            handleConfigNotFound(new Error("boom"), (t) => out.push(t)),
        ).toBe(false);
        expect(handleConfigNotFound("not an error", (t) => out.push(t))).toBe(
            false,
        );
        expect(out).toEqual([]);
    });
});

describe("every runnable CLI entry routes config-not-found to the guidance", () => {
    // SCAN, never enumerate (workflow rule): the set is derived from the
    // sources, so a new entry module that forgets the wiring fails here instead
    // of silently regressing to a FATAL dump.
    const entries = readdirSync(cliSrcDir)
        .filter((f) => f.endsWith(".ts") && f !== "exec.ts") // exec.ts DEFINES isEntrypoint
        .filter((f) =>
            /isEntrypoint\(import\.meta\.url\)/.test(
                readFileSync(join(cliSrcDir, f), "utf8"),
            ),
        );

    it("finds a non-trivial set of entry modules", () => {
        expect(entries.length).toBeGreaterThanOrEqual(4);
    });

    it.each(entries)("%s calls handleConfigNotFound in its catch", (file) => {
        // Anchored in CATCH CONTEXT, and on the CALL form — not the bare
        // identifier. A code review defeated the first version of this guard by
        // deleting the whole `if (handleConfigNotFound(err)) …` block from
        // preview.ts's catch and leaving the import: `toContain(
        // "handleConfigNotFound")` matched the import line and stayed green
        // (this package's biome only WARNS on an unused import, so nothing else
        // caught it either). Brace-match each catch body and require the call
        // inside one of them.
        const src = readFileSync(join(cliSrcDir, file), "utf8");
        const bodies = catchBodies(src);
        expect(bodies.length, `${file} has no catch block`).toBeGreaterThan(0);
        expect(
            bodies.some((b) => /handleConfigNotFound\s*\(/.test(b)),
            `${file}: no catch block calls handleConfigNotFound(…) — an entry ` +
                "that imports it but never calls it dumps a FATAL instead",
        ).toBe(true);
    });
});

/**
 * Bodies of every `catch (…) { … }` in `src`, brace-matched so a nested block
 * cannot truncate the body and make the assertion vacuous.
 */
function catchBodies(src: string): string[] {
    const out: string[] = [];
    for (const m of src.matchAll(/catch\s*\([^)]*\)\s*\{/g)) {
        if (m.index === undefined) {
            continue;
        }
        let i = m.index + m[0].length;
        let depth = 1;
        while (i < src.length && depth > 0) {
            const ch = src[i];
            if (ch === "{") {
                depth++;
            } else if (ch === "}") {
                depth--;
            }
            i++;
        }
        out.push(src.slice(m.index + m[0].length, i - 1));
    }
    return out;
}

/**
 * Spawns the REAL built CLI as a subprocess. Under full-suite parallelism that
 * routinely exceeds the 5s default — these passed run alone and failed only in
 * the whole-package run, which is the signature of a budget problem rather than
 * a logic one. Raised with the reason attached so the next person does not
 * "fix" it by trimming the number back.
 */
describe(
    "end-to-end: the real deploy entry in a directory with no config",
    { timeout: 30_000 },
    () => {
        const bun = process.env.BUN_PATH ?? "bun";
        const entry = join(cliSrcDir, "deploy.ts");

        it("exits 1 with the guidance on stderr and no stack trace", () => {
            const probe = spawnSync(bun, ["--version"], { encoding: "utf8" });
            if (probe.error) {
                // Bun runs the TS sources directly; on a Bun-less machine the same
                // contract is covered by the dist-bin assertions in
                // cli-node-runtime.test.ts. Never silently pass — assert we at
                // least have the source to run.
                expect(existsSync(entry)).toBe(true);
                return;
            }
            const dir = mkdtempSync(join(tmpdir(), "knext-noconfig-e2e-"));
            const r = spawnSync(bun, [entry], {
                cwd: dir,
                encoding: "utf8",
                env: { ...process.env, NO_COLOR: "1" },
            });
            const combined = `${r.stdout}${r.stderr}`;
            expect(r.status).toBe(1);
            expect(combined).toContain("kn-next.config.ts");
            expect(combined).toContain("npx @getknext/core create");
            expect(combined).toContain("https://knext.dev");
            expect(combined).not.toContain("FATAL");
            expect(combined).not.toMatch(STACK_FRAME_RE);
        });
    },
);

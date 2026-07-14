/**
 * cli-node-runtime.test.ts — WORKSTREAM A / E1 (#68 follow-up)
 *
 * The kn-next CLI was ported off Bun-only APIs (Bun.$ → node:child_process in
 * cli/exec.ts, `#!/usr/bin/env bun` → `#!/usr/bin/env node`, tsup bundling a
 * Node-runnable bin). This suite is the PERMANENT regression guard for that
 * port, in three layers:
 *
 *  1. STATIC (sources): every file under src/cli plus everything it
 *     transitively imports from src/ must stay Bun-free — no `from "bun"`,
 *     no `bun:*` module specifiers, no `Bun.` globals, no bun shebang. A
 *     reintroduced Bun-ism would otherwise pass unit tests (vitest runs fine
 *     under Node with mocks) and only explode for `npx kn-next` users.
 *
 *  2. STATIC (built bin): dist/cli/kn-next.js — the published `bin` — carries
 *     the `#!/usr/bin/env node` shebang and no bun module imports. This is
 *     what npm actually installs; the bundle includes all transitive local
 *     code, so it catches Bun-isms the source walker's regexes might miss.
 *
 *  3. BEHAVIORAL: the built bin is spawned under plain `node` (--help,
 *     --version → exit 0, usage text) and, when bun is on PATH, under `bun`
 *     with byte-identical --help output — ONE code path, two runtimes.
 *
 * dist/ must exist: CI builds @knext/core before vitest (ci.yml), same
 * contract publish-surface.test.ts relies on. Run `pnpm --filter @knext/core
 * build` locally first.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..", "..");
const srcDir = join(pkgRoot, "src");
const cliSrcDir = join(srcDir, "cli");
const distBin = join(pkgRoot, "dist", "cli", "kn-next.js");

/** Spawn env: neutralize inherited NODE_OPTIONS (preloads) and force no TTY color. */
const spawnEnv = { ...process.env, NODE_OPTIONS: "", NO_COLOR: "1" };

function run(cmd: string, args: string[]) {
    return spawnSync(cmd, args, {
        encoding: "utf8" as const,
        env: spawnEnv,
        timeout: 30_000,
    });
}

function hasBun(): boolean {
    return run("bun", ["--version"]).status === 0;
}

// ---------------------------------------------------------------------------
// Transitive source walker: src/cli/*.ts + every relative import reachable
// from them inside src/ (utils, config, generators, adapters, ...).
// ---------------------------------------------------------------------------

/** Extract import/require/dynamic-import specifiers from a TS/JS source. */
function importSpecifiers(source: string): string[] {
    const specs: string[] = [];
    const re =
        /(?:import|export)\s[^"'`]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;
    for (const m of source.matchAll(re)) {
        const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
        if (spec) {
            specs.push(spec);
        }
    }
    return specs;
}

/** Resolve a relative specifier to an existing file inside src/, else null. */
function resolveLocal(fromFile: string, spec: string): string | null {
    if (!spec.startsWith(".")) {
        return null;
    }
    const base = resolve(dirname(fromFile), spec);
    for (const candidate of [
        base,
        `${base}.ts`,
        `${base}.js`,
        `${base}.cjs`,
        `${base}.mjs`,
        join(base, "index.ts"),
        join(base, "index.js"),
    ]) {
        if (existsSync(candidate) && !candidate.endsWith(join("src", "cli"))) {
            try {
                readFileSync(candidate, "utf8");
                return candidate;
            } catch {
                // directory or unreadable — try next candidate
            }
        }
    }
    return null;
}

/** All files reachable from the CLI entry sources via relative imports. */
function collectCliClosure(): Map<string, string> {
    const entries = readdirSync(cliSrcDir)
        .filter((f) => f.endsWith(".ts"))
        .map((f) => join(cliSrcDir, f));
    const seen = new Map<string, string>();
    const queue = [...entries];
    while (queue.length > 0) {
        const file = queue.pop();
        if (!file || seen.has(file)) {
            continue;
        }
        const content = readFileSync(file, "utf8");
        seen.set(file, content);
        for (const spec of importSpecifiers(content)) {
            const next = resolveLocal(file, spec);
            if (next && !seen.has(next)) {
                queue.push(next);
            }
        }
    }
    return seen;
}

// Bun-ism detectors. NOTE: the word "bun" alone is fine (runtime: "bun" config,
// bytecode labels, spawning the external `bun` binary via child_process) — only
// importing the Bun MODULE surface or touching the Bun GLOBAL is forbidden.
function bunModuleImports(content: string): string[] {
    return importSpecifiers(content).filter(
        (s) => s === "bun" || s.startsWith("bun:"),
    );
}
const BUN_GLOBAL_RE = /\bBun\s*\.\s*[a-zA-Z$_]|\btypeof\s+Bun\b/;

describe("CLI sources are Bun-free (static closure guard)", () => {
    const closure = collectCliClosure();

    it("walks a non-trivial closure (cli entries + transitive src imports)", () => {
        const files = [...closure.keys()];
        // sanity: the walker actually followed imports out of src/cli
        expect(files.length).toBeGreaterThan(10);
        expect(files.some((f) => !f.startsWith(cliSrcDir))).toBe(true);
    });

    it('no file imports the "bun" module or a "bun:*" builtin', () => {
        const offenders: string[] = [];
        for (const [file, content] of closure) {
            for (const spec of bunModuleImports(content)) {
                offenders.push(`${file} imports "${spec}"`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it("no file touches the Bun global", () => {
        const offenders: string[] = [];
        for (const [file, content] of closure) {
            if (BUN_GLOBAL_RE.test(content)) {
                offenders.push(file);
            }
        }
        expect(offenders).toEqual([]);
    });

    it("every executable CLI entry has the node shebang, never bun", () => {
        for (const [file, content] of closure) {
            if (!content.startsWith("#!")) {
                continue;
            }
            const shebang = content.slice(0, content.indexOf("\n"));
            expect(shebang, file).toBe("#!/usr/bin/env node");
        }
        // and the published bin's source entry (deploy.ts) IS executable
        const deploySrc = readFileSync(join(cliSrcDir, "deploy.ts"), "utf8");
        expect(deploySrc.startsWith("#!/usr/bin/env node")).toBe(true);
    });
});

describe("self-entry blocks exist ONLY in sanctioned entry modules (#263)", () => {
    // #263 Option A: `isEntrypoint(import.meta.url)` self-entry blocks are a
    // latent bundling hazard — if tsup ever inlines a module into the bin,
    // `import.meta.url` equals the bin's URL and the block fires at module
    // load, hijacking every subcommand (observed live with gc.ts, PR #262).
    // The ONLY modules allowed to carry one are:
    //   - deploy.ts   — the published bin entry (the subcommand dispatcher)
    //   - build.ts / cleanup.ts / preview.ts / loadtest.ts — documented
    //     directly-runnable entries (docs-site cli.mdx "Directly runnable
    //     entries"; .github/workflows/preview.yml invokes dist/cli/preview.js
    //     directly; scripts/load-test.sh runs dist/cli/loadtest.js) — each with
    //     its OWN tsup entry, so they emit as separate files and are never
    //     inlined into the bin. loadtest.ts uses the SHARED isEntrypoint guard
    //     (v3-P6a: normalized off its former hand-rolled argv check), so its
    //     self-entry block belongs here.
    // Every other CLI module is reached exclusively through the bin dispatch
    // and must NOT self-execute.
    const SANCTIONED = new Set([
        "deploy.ts",
        "build.ts",
        "cleanup.ts",
        "preview.ts",
        "loadtest.ts",
    ]);

    it("no non-sanctioned CLI module carries an isEntrypoint self-entry block", () => {
        const offenders: string[] = [];
        for (const entry of readdirSync(cliSrcDir).filter((f) =>
            f.endsWith(".ts"),
        )) {
            if (SANCTIONED.has(entry) || entry === "exec.ts") {
                continue; // exec.ts DEFINES isEntrypoint
            }
            const content = readFileSync(join(cliSrcDir, entry), "utf8");
            if (/isEntrypoint\(import\.meta\.url\)/.test(content)) {
                offenders.push(entry);
            }
        }
        expect(offenders).toEqual([]);
    });

    it("every sanctioned self-entry module has its own tsup entry (never inlined into the bin)", () => {
        // The sanctioned blocks are safe ONLY because each module emits as its
        // own dist file — pin that: dist/cli/<name>.js must exist for each.
        for (const entry of SANCTIONED) {
            const name = entry.replace(/\.ts$/, "");
            const distFile =
                name === "deploy"
                    ? join(pkgRoot, "dist", "cli", "kn-next.js")
                    : join(pkgRoot, "dist", "cli", `${name}.js`);
            expect(existsSync(distFile), distFile).toBe(true);
        }
    });
});

describe("built bin (dist/cli/kn-next.js) is Node-runnable", () => {
    beforeAll(() => {
        if (!existsSync(distBin)) {
            throw new Error(
                `${distBin} missing — build @knext/core before vitest ` +
                    "(pnpm --filter @knext/lib build && pnpm --filter @knext/db build && pnpm --filter @knext/core build), " +
                    "same contract as publish-surface.test.ts / ci.yml.",
            );
        }
    });

    it("carries the #!/usr/bin/env node shebang", () => {
        const firstLine = readFileSync(distBin, "utf8").split("\n", 1)[0];
        expect(firstLine).toBe("#!/usr/bin/env node");
    });

    it("bundle contains no bun module imports", () => {
        for (const entry of readdirSync(join(pkgRoot, "dist", "cli")).filter(
            (f) => f.endsWith(".js"),
        )) {
            const content = readFileSync(
                join(pkgRoot, "dist", "cli", entry),
                "utf8",
            );
            expect(bunModuleImports(content), entry).toEqual([]);
        }
    });

    it("`node kn-next.js --help` exits 0 with usage text", () => {
        const r = run(process.execPath, [distBin, "--help"]);
        expect(r.error).toBeUndefined();
        expect(r.status).toBe(0);
        expect(r.stdout).toContain("kn-next deploy");
        expect(r.stdout).toContain("--dry-run");
        expect(r.stdout).toContain("-h, --help");
        // Workstream C subcommands are advertised in the bin's help.
        expect(r.stdout).toContain("db bind");
        expect(r.stdout).toContain("doctor");
        expect(r.stdout).toContain("status");
        // #92 rollback is a first-class bin subcommand (Tier-B "rollback demoed").
        expect(r.stdout).toContain("rollback");
        // #93/ADR-0011 gc is a first-class bin subcommand (P4): assert the
        // actual Commands-list entry, not a bare "gc" substring.
        expect(r.stdout).toMatch(/^\s+gc\s+/m);
        expect(r.stdout).toContain("reap old _next/static/<build-id>/");
    });

    it("`node kn-next.js rollback --help` dispatches and exits 0", () => {
        // The bin must route `rollback` to rollbackMain — NOT fall through to the
        // deploy flow (which would try to build+deploy). The e2e_rollback suite
        // (test/e2e/rollback_e2e_test.go) exercises the real traffic patch; this
        // hermetic test pins the dispatch + help contract.
        const r = run(process.execPath, [distBin, "rollback", "--help"]);
        expect(r.error).toBeUndefined();
        expect(r.status).toBe(0);
        expect(r.stdout).toContain("kn-next rollback");
        expect(r.stdout).toContain("--to");
        expect(r.stdout).toContain("--canary");
        // Rollback-ONLY discriminators: these strings exist in rollback's help
        // and nowhere in deploy's usage text, so removing the dispatch branch
        // (falling through to deploy's help/flow) cannot false-pass this test.
        expect(r.stdout).toContain("spec.traffic");
        expect(r.stdout).toContain("Patches ONLY the NextApp CR");
    });

    it("`node kn-next.js gc --help` dispatches and exits 0", () => {
        // The bin must route `gc` to gcMain — NOT fall through to the deploy
        // flow (which would build + push + mutate the cluster). The e2e_gc
        // suite (test/e2e/asset_gc_e2e_test.go) exercises the real prune;
        // this hermetic test pins the dispatch + help contract.
        const r = run(process.execPath, [distBin, "gc", "--help"]);
        expect(r.error).toBeUndefined();
        expect(r.status).toBe(0);
        expect(r.stdout).toContain("kn-next gc");
        expect(r.stdout).toContain("--build-id");
        // gc-ONLY discriminators: these strings exist in gc's help and
        // nowhere in deploy's usage text (deploy's Commands list only carries
        // the short "reap old _next/static/<build-id>/ asset prefixes" line),
        // so removing the dispatch branch (falling through to deploy's
        // help/flow) cannot false-pass this test.
        expect(r.stdout).toContain("over-keep, never over-delete");
        expect(r.stdout).toContain("assetRetention");
        expect(r.stdout).toContain("teardown-only");
    });

    it("`node kn-next.js gc --unknown-flag` exits non-zero (strict parser through the real dispatch)", () => {
        // gc DELETES object-store prefixes: a typo'd flag must be a hard
        // error, never a silent fall-through with different retention
        // semantics. (Exit code only — the fatal log rides pino's async
        // transport and is not guaranteed flushed before exit.)
        const r = run(process.execPath, [distBin, "gc", "--unknown-flag"]);
        expect(r.error).toBeUndefined();
        expect(r.status).toBe(1);
    });

    it("`node kn-next.js status --help` dispatches and exits 0", () => {
        const r = run(process.execPath, [distBin, "status", "--help"]);
        expect(r.error).toBeUndefined();
        expect(r.status).toBe(0);
        expect(r.stdout).toContain("kn-next status");
        expect(r.stdout).toContain("--json");
        expect(r.stdout).toContain("--watch");
    });

    it("`node kn-next.js doctor --help` dispatches and exits 0", () => {
        const r = run(process.execPath, [distBin, "doctor", "--help"]);
        expect(r.error).toBeUndefined();
        expect(r.status).toBe(0);
        expect(r.stdout).toContain("kn-next doctor");
        expect(r.stdout).toContain("--json");
    });

    it("`node kn-next.js db bind --help` dispatches and exits 0", () => {
        const r = run(process.execPath, [distBin, "db", "bind", "--help"]);
        expect(r.error).toBeUndefined();
        expect(r.status).toBe(0);
        expect(r.stdout).toContain("kn-next db bind");
        expect(r.stdout).toContain("--secret");
        expect(r.stdout).toContain("--ro-secret");
    });

    it("`node kn-next.js --version` exits 0 and prints a version", () => {
        const r = run(process.execPath, [distBin, "--version"]);
        expect(r.error).toBeUndefined();
        expect(r.status).toBe(0);
        expect(r.stdout).toMatch(/\d+\.\d+\.\d+/);
    });
});

describe("runtime parity: the SAME built bin under bun", () => {
    // ci.yml's lint-and-test job deliberately has no bun on PATH (the
    // install-smoke workflow even asserts its absence) — so this leg is a
    // skip there and runs locally + in any bun-provisioned lane.
    const bun = hasBun();

    it.skipIf(!bun)(
        "`bun kn-next.js --help` exits 0 with IDENTICAL output to node",
        () => {
            const nodeRun = run(process.execPath, [distBin, "--help"]);
            const bunRun = run("bun", [distBin, "--help"]);
            expect(bunRun.status).toBe(0);
            expect(bunRun.stdout).toBe(nodeRun.stdout);
        },
    );

    it.skipIf(!bun)("`bun kn-next.js --version` matches node's", () => {
        const nodeRun = run(process.execPath, [distBin, "--version"]);
        const bunRun = run("bun", [distBin, "--version"]);
        expect(bunRun.status).toBe(0);
        expect(bunRun.stdout).toBe(nodeRun.stdout);
    });
});

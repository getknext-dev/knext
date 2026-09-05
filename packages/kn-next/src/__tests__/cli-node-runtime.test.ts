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
 * SCOPE: this suite covers dispatch/help/deploy verbs. The vinext COMPILE step
 * legitimately shells out to `bun` (ADR-0048 Amendment 3), so "Bun-free" here
 * means the CLI process itself, not the toolchain it invokes — and the bundled
 * build path under Node up to and through that Bun handoff is guarded
 * separately by vinext-build-node-bundle.test.ts (#948, where a bundled
 * dynamic require broke it while this suite stayed green by design).
 *
 * dist/ must exist: CI builds @getknext/core before vitest (ci.yml), same
 * contract publish-surface.test.ts relies on. Run `pnpm --filter @getknext/core
 * build` locally first.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    existsSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NODE_BIN } from "../../../../tests/helpers/runtime-binaries";
import { KNOWN_VERBS } from "../cli/dispatch";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..", "..");
const srcDir = join(pkgRoot, "src");
const cliSrcDir = join(srcDir, "cli");
const distBin = join(pkgRoot, "dist", "cli", "kn-next.js");

/** A stack frame ("\n    at foo (/path/file.js:1:2)") or a bundler chunk path. */
const STACK_FRAME_RE = /\n\s+at\s/;
const CHUNK_PATH_RE = /\b[\w./-]+\.(?:js|cjs|mjs):\d+/;

/**
 * Spawn env: neutralize inherited NODE_OPTIONS (preloads) and force no TTY
 * color. `npm_config_registry` points `create`'s #950 pin probe at a closed
 * local port so the bundled-bin scaffold below stays offline and
 * deterministic (connection refused is the probe's silent path).
 */
const spawnEnv = {
    ...process.env,
    NODE_OPTIONS: "",
    NO_COLOR: "1",
    npm_config_registry: "http://127.0.0.1:9",
};

function run(cmd: string, args: string[], cwd?: string) {
    return spawnSync(cmd, args, {
        encoding: "utf8" as const,
        env: spawnEnv,
        timeout: 30_000,
        ...(cwd ? { cwd } : {}),
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
                `${distBin} missing — build @getknext/core before vitest ` +
                    "(pnpm --filter @getknext/lib build && pnpm --filter @getknext/db build && pnpm --filter @getknext/core build), " +
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
        const r = run(NODE_BIN, [distBin, "--help"]);
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
        // UX ledger 1d: `create` leads (the reader with no app yet), and the
        // two verbs README advertises are listed because the bin now routes
        // them. Assert the Commands-list entries, not bare substrings.
        expect(r.stdout).toMatch(/^Start here:$/m);
        expect(r.stdout).toMatch(/^ {2}create\s+/m);
        expect(r.stdout).toMatch(/^ {2}cleanup\s+/m);
        expect(r.stdout).toMatch(/^ {2}build\s+/m);
    });

    it.each([
        "build",
        "cleanup",
    ])("`%s` is dispatched, and its body is NOT inlined into the bin (#263)", (verb) => {
        // build.ts/cleanup.ts carry self-entry blocks AND are now bin-
        // dispatched. That is safe only while each stays its own dist file:
        // if tsup ever inlined one into the bin, its `isEntrypoint` block
        // would fire at module load and hijack every subcommand. Prove the
        // separation with a discriminator string unique to each module.
        // Plain-ASCII discriminators on purpose: esbuild escapes non-ASCII
        // literals (the build banner's emoji ships as an \u escape), so an
        // emoji anchor would silently match neither file.
        const discriminator = {
            build: "Uploading static assets...",
            cleanup: "Deleting NextApp CR",
        }[verb] as string;
        const own = readFileSync(
            join(pkgRoot, "dist", "cli", `${verb}.js`),
            "utf8",
        );
        expect(own, `${verb}.js must contain its own body`).toContain(
            discriminator,
        );
        expect(
            readFileSync(distBin, "utf8"),
            "bin must not inline the dispatched entry",
        ).not.toContain(discriminator);
    });

    it("`node kn-next.js cleanup --help`-less dispatch does not run a deploy", () => {
        // The footgun this closes: before the dispatch existed, `kn-next
        // cleanup` fell through to deploy(). Run it in an empty temp dir — the
        // config is absent, so both paths stop early, but ONLY the deploy path
        // announces "kn-next deploy".
        const dir = mkdtempSync(join(tmpdir(), "knext-cleanup-dispatch-"));
        const r = run(NODE_BIN, [distBin, "cleanup"], dir);
        expect(`${r.stdout}${r.stderr}`).not.toContain("kn-next deploy");
        expect(r.status).toBe(1); // no config here → the guidance path
        expect(`${r.stdout}${r.stderr}`).toContain("npx @getknext/core create");
    });

    // --- ADR-0046: --help is never destructive, unknown verbs never deploy ---
    //
    // Derived from the shipped verb list, not enumerated here: a new verb
    // inherits these two assertions automatically.
    const helpVerbs = [...KNOWN_VERBS].filter((v) => v !== "deploy");

    it.each(
        helpVerbs,
    )("`%s --help` exits 0 and performs no work (destructive verbs included)", (verb) => {
        // A reviewer proved `kn-next cleanup --help` DELETED the app: the
        // branch called cleanup() with no argument parsing. Run each verb's
        // help in an EMPTY dir, so anything that actually starts working
        // would announce itself (or fail on the missing config) rather than
        // exiting 0 in silence.
        const dir = mkdtempSync(join(tmpdir(), `knext-help-${verb}-`));
        const r = run(NODE_BIN, [distBin, verb, "--help"], dir);
        expect(r.error).toBeUndefined();
        expect(r.status, `${verb} --help must exit 0`).toBe(0);
        expect(r.stdout).toContain(`kn-next ${verb}`);
        const all = `${r.stdout}${r.stderr}`;
        // Work markers from the two verbs that do irreversible / expensive
        // things. Neither may appear on a help run.
        expect(all).not.toContain("Deleting NextApp CR");
        expect(all).not.toContain("Uploading static assets");
        expect(all).not.toContain("kn-next deploy —"); // no fall-through
    });

    it("an unknown verb is an error with a suggestion, never a silent deploy", () => {
        const dir = mkdtempSync(join(tmpdir(), "knext-unknown-verb-"));
        const r = run(NODE_BIN, [distBin, "celanup", "--dry-run"], dir);
        expect(r.status).toBe(1);
        const all = `${r.stdout}${r.stderr}`;
        expect(all).toContain("unknown command: celanup");
        expect(all).toContain("kn-next cleanup");
        expect(all).toContain("--help");
        // The deploy flow's own banner must be absent — the whole point.
        expect(all).not.toContain("kn-next deploy\n");
    });

    // --- ADR-0046, second half: a verb in a LATER slot is not swallowed ---
    //
    // Round 1 caught the first-slot case (`kn-next celanup`). A reviewer then
    // proved the flags-first door was still open: `kn-next -n prod cleanup`
    // deployed to prod with `cleanup` silently swallowed by
    // `allowPositionals: true` — the same "opposite action" hazard, one flag
    // further in. These three invocations are the reviewer's, verbatim.
    it.each([
        [["deploy", "cleanup"], "cleanup"],
        [["--namespace", "prod", "cleanup"], "cleanup"],
        [["--", "cleanup"], "cleanup"],
    ])("`kn-next %s` refuses rather than deploying", (argv, swallowed) => {
        const dir = mkdtempSync(join(tmpdir(), "knext-stray-positional-"));
        const r = run(NODE_BIN, [distBin, ...argv], dir);
        expect(r.status, `${argv.join(" ")} must exit 1`).toBe(1);
        const all = `${r.stdout}${r.stderr}`;
        expect(all).toContain(`unexpected argument: ${swallowed}`);
        // Verb-first ordering is the actionable half of the message.
        expect(all).toContain(`kn-next ${swallowed}`);
        // It must refuse BEFORE the deploy flow starts — no config was even
        // read, so the config guidance must not appear either.
        expect(all).not.toContain("No kn-next.config.ts found");
        expect(all).not.toContain("kn-next deploy\n");
        // Same presentation contract as every other expected failure.
        expect(all).not.toContain("FATAL");
        expect(all).not.toMatch(STACK_FRAME_RE);
    });

    it("an explicit `deploy` with no positional still runs the deploy flow", () => {
        // The rejection must not swallow the legitimate explicit form: in an
        // empty dir it reaches config loading and prints the guidance.
        const dir = mkdtempSync(join(tmpdir(), "knext-explicit-deploy-"));
        const r = run(NODE_BIN, [distBin, "deploy"], dir);
        expect(r.status).toBe(1);
        expect(`${r.stdout}${r.stderr}`).toContain(
            "No kn-next.config.ts found",
        );
    });

    // --- Usage errors are messages, not FATAL dumps ---
    //
    // The strict-flag rejections landed on `log.fatal({ err })`, which prints a
    // serialised Error with a stack and an absolute dist chunk path — the exact
    // presentation this change exists to remove.
    //
    // BOTH STREAMS, always: pino writes the FATAL line to STDOUT, so a
    // stderr-only assertion reads clean while the dump is on screen. That is how
    // the first sweep looked complete while six verbs still dumped.
    function assertPlainMessage(
        r: ReturnType<typeof run>,
        label: string,
    ): string {
        expect(r.status, `${label} must exit 1`).toBe(1);
        const all = `${r.stdout}${r.stderr}`;
        expect(all, `${label} must not print a FATAL line`).not.toContain(
            "FATAL",
        );
        expect(all, `${label} must not serialise the Error`).not.toContain(
            "err:",
        );
        expect(all).not.toContain('"stack"');
        expect(all, `${label} must not print a stack frame`).not.toMatch(
            STACK_FRAME_RE,
        );
        expect(all, `${label} must not print a chunk path`).not.toMatch(
            CHUNK_PATH_RE,
        );
        return all;
    }

    // DERIVED from the shipped verb list, like the `--help` test above. The
    // previous version enumerated four invocations covering cleanup/build/db —
    // and the live bleed was in doctor/status/rollback/preview, i.e. the two
    // layers had correlated blind spots. An unknown flag is the one usage
    // mistake EVERY verb must reject, so it is the probe.
    const BOGUS_FLAG = "--zzz-not-a-real-flag";
    it.each([
        ...KNOWN_VERBS,
    ])("`%s` rejects an unknown flag as a plain message", (verb) => {
        // `deploy` is the default: exercise it through the bare form too,
        // which is the path parseArgs owns.
        const argv = verb === "deploy" ? [BOGUS_FLAG] : [verb, BOGUS_FLAG];
        const dir = mkdtempSync(join(tmpdir(), `knext-badflag-${verb}-`));
        const all = assertPlainMessage(
            run(NODE_BIN, [distBin, ...argv], dir),
            `kn-next ${argv.join(" ")}`,
        );
        // It must actually name the offending flag, not fail for some
        // unrelated reason (e.g. reaching config loading).
        expect(all).toContain(BOGUS_FLAG);
    });

    // The reviewer's six measured dumps, verbatim. These are NOT flag typos —
    // they are flag-combination and missing-argument mistakes, which no derived
    // probe reaches, so they stay enumerated on top of the derivation.
    it.each([
        [["doctor", "--bogus"], "unknown argument"],
        [["status", "--json", "--watch"], "--json cannot be combined"],
        [["status"], "app name required"],
        [["rollback", "--canary", "500"], "--canary must be an integer"],
        [["rollback", "--canary", "50"], "--canary requires --to"],
        [["db", "bind", "myapp"], "--secret <name> is required"],
    ])("`kn-next %s` is a plain message, not a stack dump", (argv, needle) => {
        const dir = mkdtempSync(join(tmpdir(), "knext-usage-error-"));
        const all = assertPlainMessage(
            run(NODE_BIN, [distBin, ...argv], dir),
            `kn-next ${argv.join(" ")}`,
        );
        expect(all).toContain(needle);
    });

    it("a flags-only invocation still deploys (the advertised front door)", () => {
        // `kn-next --skip-build` must NOT be read as an unknown command: a
        // leading `-` is a flag. Run it where there is no config, so the deploy
        // path identifies itself by printing the config guidance and exiting 1.
        const dir = mkdtempSync(join(tmpdir(), "knext-flags-only-"));
        const r = run(NODE_BIN, [distBin, "--skip-build"], dir);
        expect(r.status).toBe(1);
        const all = `${r.stdout}${r.stderr}`;
        expect(all).toContain("No kn-next.config.ts found");
        expect(all).not.toContain("unknown command");
    });

    it("`node kn-next.js rollback --help` dispatches and exits 0", () => {
        // The bin must route `rollback` to rollbackMain — NOT fall through to the
        // deploy flow (which would try to build+deploy). The e2e_rollback suite
        // (test/e2e/rollback_e2e_test.go) exercises the real traffic patch; this
        // hermetic test pins the dispatch + help contract.
        const r = run(NODE_BIN, [distBin, "rollback", "--help"]);
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
        const r = run(NODE_BIN, [distBin, "gc", "--help"]);
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
        const r = run(NODE_BIN, [distBin, "gc", "--unknown-flag"]);
        expect(r.error).toBeUndefined();
        expect(r.status).toBe(1);
    });

    it("`node kn-next.js status --help` dispatches and exits 0", () => {
        const r = run(NODE_BIN, [distBin, "status", "--help"]);
        expect(r.error).toBeUndefined();
        expect(r.status).toBe(0);
        expect(r.stdout).toContain("kn-next status");
        expect(r.stdout).toContain("--json");
        expect(r.stdout).toContain("--watch");
    });

    it("`node kn-next.js doctor --help` dispatches and exits 0", () => {
        const r = run(NODE_BIN, [distBin, "doctor", "--help"]);
        expect(r.error).toBeUndefined();
        expect(r.status).toBe(0);
        expect(r.stdout).toContain("kn-next doctor");
        expect(r.stdout).toContain("--json");
    });

    it("`node kn-next.js db bind --help` dispatches and exits 0", () => {
        const r = run(NODE_BIN, [distBin, "db", "bind", "--help"]);
        expect(r.error).toBeUndefined();
        expect(r.status).toBe(0);
        expect(r.stdout).toContain("kn-next db bind");
        expect(r.stdout).toContain("--secret");
        expect(r.stdout).toContain("--ro-secret");
    });

    it("`node kn-next.js create --help` dispatches and exits 0", () => {
        // #407: `create` must route to createMain, NOT fall through to the
        // deploy flow (which would try to build + push + apply a CR). The
        // discriminators below appear only in create's help.
        const r = run(NODE_BIN, [distBin, "create", "--help"]);
        expect(r.error).toBeUndefined();
        expect(r.status).toBe(0);
        expect(r.stdout).toContain("kn-next create");
        expect(r.stdout).toContain("--dry-run");
        expect(r.stdout).toContain("guarded instrumentation");
        // The help must tell the truth about the retirement (#885): the seam
        // guard may appear only in its "retired" sentence, never as a shipped
        // deliverable — and instrumentation-edge-safe IS still shipped.
        expect(r.stdout).toContain("instrumentation-edge-safe");
        expect(r.stdout).toContain("retired");
    });

    it("`node kn-next.js create` scaffolds through the BUNDLED bin (templates ship with the package)", () => {
        // The bundle resolves its templates from <package>/templates — a path
        // that only exists if `files` ships them AND the dist layout resolves
        // the same as the source layout. Running the REAL bin is the only way
        // to observe that; a unit test on renderScaffold cannot.
        const dir = mkdtempSync(join(tmpdir(), "kn-next-create-bin-"));
        try {
            const r = run(NODE_BIN, [
                distBin,
                "create",
                dir,
                "--name",
                "smoke",
            ]);
            expect(r.error).toBeUndefined();
            expect(r.stderr + r.stdout, "create failed").not.toMatch(
                /create failed/,
            );
            expect(r.status).toBe(0);
            // The vinext shape (ADR-0048). `next-adapter.ts` and
            // `standalone-seam-alive.test.ts` are deliberately NOT here: the
            // official adapter hooks are a webpack/turbopack mechanism that
            // vinext never calls, and the seam guard existed to catch webpack
            // layering duplicating `@getknext/lib` module state — there are no
            // webpack layers on this path.
            for (const rel of [
                "src/instrumentation.ts",
                "src/instrumentation-node.ts",
                "vite.config.ts",
                "knext-bun-entry.mjs",
                "runtime-contract.mjs",
                "instrumentation-edge-safe.test.ts",
            ]) {
                expect(
                    existsSync(join(dir, rel)),
                    `${rel} not scaffolded`,
                ).toBe(true);
            }

            // Both halves: the vinext files are present AND the retired ones
            // are gone. Asserting only presence would pass on a scaffold that
            // still shipped a dead adapter file for every new app.
            for (const rel of [
                "next-adapter.ts",
                "standalone-seam-alive.test.ts",
            ]) {
                expect(
                    existsSync(join(dir, rel)),
                    `${rel} is retired and must not be scaffolded`,
                ).toBe(false);
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("`node kn-next.js create --unknown-flag` exits non-zero (strict parser through the real dispatch)", () => {
        const r = run(NODE_BIN, [distBin, "create", "--unknown-flag"]);
        expect(r.error).toBeUndefined();
        expect(r.status).toBe(1);
    });

    it("`node kn-next.js --version` exits 0 and prints a version", () => {
        const r = run(NODE_BIN, [distBin, "--version"]);
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
            const nodeRun = run(NODE_BIN, [distBin, "--help"]);
            const bunRun = run("bun", [distBin, "--help"]);
            expect(bunRun.status).toBe(0);
            expect(bunRun.stdout).toBe(nodeRun.stdout);
        },
    );

    it.skipIf(!bun)("`bun kn-next.js --version` matches node's", () => {
        const nodeRun = run(NODE_BIN, [distBin, "--version"]);
        const bunRun = run("bun", [distBin, "--version"]);
        expect(bunRun.status).toBe(0);
        expect(bunRun.stdout).toBe(nodeRun.stdout);
    });
});

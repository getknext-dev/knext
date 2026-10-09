/**
 * 1.0 contract: every CLI verb's flags and exit codes match `cli/contract.ts`
 * (the frozen 1.0 promise).
 *
 * Every check below cross-references the CONTRACT against REALITY derived
 * from the verb's own source — never a second hand-typed list — so a flag or
 * exit code that changes in the code without a matching contract.ts update
 * reds a specific, named assertion here. Three reality sources, depending on
 * how each verb parses its own argv:
 *
 *  1. Verbs with an exported, pure (no I/O) parser function — `doctor`,
 *     `status`, `gc`, `rollback`, `db bind`, `db migrate` — are exercised
 *     DIRECTLY: every contract flag must parse without throwing, and a
 *     fabricated unknown flag must throw. `build`'s flags are its own
 *     exported `ACCEPTED_BUILD_FLAGS` set, compared directly (no invocation
 *     needed). `validate` has no separate parser (inline in `validateMain`,
 *     which never touches disk before -h/--help or an unknown-flag throw),
 *     so it is exercised directly too.
 *  2. Verbs whose argv parsing is a `node:util parseArgs({ options: {...} })`
 *     call — `create`, `init-ci`, `ci-preflight`, `deploy`, `preview`,
 *     `loadtest` — are checked by SCANNING that file's own `options` object
 *     literal (each file has exactly one `parseArgs(` call, asserted below),
 *     never a duplicated flag list.
 *  3. `cleanup` (whose only non-help flag, `--context`, gates a real cluster
 *     mutation) is covered in `cli-contract-cleanup.test.ts`, which mocks the
 *     exec/config seams so it can exercise the SAME "flag not rejected"
 *     property without touching a cluster.
 *
 * Exit codes are cross-checked with the same discipline where a safe seam
 * exists (build, validate, gc, doctor via structure, and the universal
 * usage-error path every verb shares); the remainder are already pinned by
 * each verb's own suite (gc-main, rollback-main, db-bind-main, status-run,
 * doctor, cleanup-cr, deploy-cr, preview-cr, init-ci-cmd, ci-preflight-cmd,
 * loadtest-cli-run) — this file freezes the TABLE, not a second copy of
 * those tests.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ACCEPTED_BUILD_FLAGS } from "../cli/build";
import { CLI_CONTRACT, type VerbContract } from "../cli/contract";
import { createMain } from "../cli/create";
import { parseDbBindArgs } from "../cli/db-bind";
import { parseDbMigrateArgs } from "../cli/db-migrate";
import { KNOWN_VERBS } from "../cli/dispatch";
import { parseDoctorArgs } from "../cli/doctor/args";
import type { DoctorDeps } from "../cli/doctor/types";
import { parseGcArgs } from "../cli/gc";
import { INTERNAL_ONLY_VERBS } from "../cli/help";
import { parseRollbackArgs } from "../cli/rollback";
import { parseStatusArgs } from "../cli/status";
import { validateMain } from "../cli/validate-cmd";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliDir = resolve(__dirname, "..", "cli");

function contractOf(verb: string): VerbContract {
    const c = CLI_CONTRACT.find((v) => v.verb === verb);
    if (!c) throw new Error(`no contract entry for verb "${verb}"`);
    return c;
}

/** Flags a contract declares, minus help (parsers below don't own -h/--help). */
function nonHelpFlags(c: VerbContract): string[] {
    return c.flags.filter((f) => f !== "-h" && f !== "--help");
}

describe("1.0 contract: verb set matches the dispatcher (single source of truth)", () => {
    it("has exactly one contract entry per BIN-DISPATCHED verb, plus db bind/db migrate for the db family", () => {
        // preview/loadtest are NOT bin subcommands (cli.mdx "Directly runnable
        // entries") — they never appear in KNOWN_VERBS at all — so they are
        // compared separately below, against INTERNAL_ONLY_VERBS.
        const dispatched = new Set(KNOWN_VERBS);
        dispatched.delete("db"); // split into "db bind" / "db migrate" below
        const contractVerbs = new Set(
            CLI_CONTRACT.filter(
                (c) =>
                    c.verb !== "db bind" &&
                    c.verb !== "db migrate" &&
                    !c.experimental,
            ).map((c) => c.verb),
        );
        expect([...contractVerbs].sort()).toEqual([...dispatched].sort());
        expect(CLI_CONTRACT.map((c) => c.verb)).toContain("db bind");
        expect(CLI_CONTRACT.map((c) => c.verb)).toContain("db migrate");
    });

    it("marks exactly the help.ts INTERNAL_ONLY_VERBS as experimental", () => {
        const experimental = CLI_CONTRACT.filter((c) => c.experimental).map(
            (c) => c.verb,
        );
        expect(experimental.sort()).toEqual([...INTERNAL_ONLY_VERBS].sort());
    });
});

describe("1.0 contract: flags — pure-parser verbs (exercised directly)", () => {
    it("doctor", () => {
        const flags = nonHelpFlags(contractOf("doctor"));
        for (const f of flags) {
            const argv = f === "--ci-kubeconfig" ? [f, "/tmp/kubeconfig"] : [f];
            expect(() => parseDoctorArgs(argv)).not.toThrow();
        }
        expect(() => parseDoctorArgs(["--totally-bogus-flag"])).toThrow();
    });

    it("status", () => {
        const flags = nonHelpFlags(contractOf("status"));
        for (const f of flags) {
            // --json/--watch take no value; -n/--namespace/--context do.
            const argv =
                f.includes("json") || f.includes("watch") ? [f] : [f, "x"];
            expect(() => parseStatusArgs(argv)).not.toThrow();
        }
        expect(() => parseStatusArgs(["--totally-bogus-flag"])).toThrow();
    });

    it("gc", () => {
        const flags = nonHelpFlags(contractOf("gc"));
        for (const f of flags) {
            const argv = f === "--dry-run" ? [f] : [f, "x"];
            expect(() => parseGcArgs(argv)).not.toThrow();
        }
        expect(() => parseGcArgs(["--totally-bogus-flag"])).toThrow();
    });

    it("rollback", () => {
        const flags = nonHelpFlags(contractOf("rollback"));
        for (const f of flags) {
            const argv = f === "--canary" ? ["--to", "r-1", f, "10"] : [f, "x"];
            expect(() => parseRollbackArgs(argv)).not.toThrow();
        }
        expect(() => parseRollbackArgs(["--totally-bogus-flag"])).toThrow();
    });

    it("db bind", () => {
        const flags = nonHelpFlags(contractOf("db bind"));
        for (const f of flags) {
            const argv = f === "--dry-run" ? [f] : [f, "x"];
            expect(() => parseDbBindArgs(argv)).not.toThrow();
        }
        expect(() => parseDbBindArgs(["--totally-bogus-flag"])).toThrow();
    });

    it("db migrate", () => {
        const flags = nonHelpFlags(contractOf("db migrate"));
        for (const f of flags) {
            expect(() => parseDbMigrateArgs([f, "x"])).not.toThrow();
        }
        expect(() => parseDbMigrateArgs(["--totally-bogus-flag"])).toThrow();
    });

    it("build (ACCEPTED_BUILD_FLAGS is the real, exported accept-set)", () => {
        const flags = nonHelpFlags(contractOf("build"));
        expect([...ACCEPTED_BUILD_FLAGS].sort()).toEqual([...flags].sort());
    });

    it("validate has no flags beyond -h/--help", () => {
        expect(nonHelpFlags(contractOf("validate"))).toEqual([]);
    });
});

describe("1.0 contract: flags — manual-loop verbs, completeness (scanned from source)", () => {
    /**
     * The direct-invocation checks above prove every CONTRACT flag is
     * accepted (removing support for one reds them). They do NOT prove the
     * reverse — that the contract lists every flag the code accepts — since
     * a pure "throw on anything unrecognised" probe can't enumerate a
     * parser's accept-set. Each of these six parsers uses the SAME
     * `a === "-x"` / `a === "--flag"` comparison idiom against one `for`
     * loop's variable (verified: exactly one such loop per file), so
     * scanning for that pattern gives the accept-set directly from source —
     * closing the gap in both directions.
     */
    function extractEqualityFlags(source: string): string[] {
        const flags = new Set<string>();
        const re = /\ba === "(-{1,2}[A-Za-z][\w-]*)"/g;
        let m: RegExpExecArray | null;
        // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
        while ((m = re.exec(source)) !== null) {
            if (m[1]) flags.add(m[1]);
        }
        return [...flags].sort();
    }

    function checkFile(
        verb: string,
        relFile: string,
        opts: { includeHelp: boolean },
    ) {
        const src = readFileSync(join(cliDir, relFile), "utf8");
        const real = extractEqualityFlags(src);
        const contractFlags = opts.includeHelp
            ? [...contractOf(verb).flags].sort()
            : nonHelpFlags(contractOf(verb)).sort();
        expect(real).toEqual(contractFlags);
    }

    // doctor's OWN loop recognises -h/--help itself (doctorMain's later
    // `argv.includes` check is a redundant belt-and-braces, not the only
    // path) — every other verb here handles help OUTSIDE this loop.
    it("doctor (help handled in-loop)", () =>
        checkFile("doctor", "doctor/args.ts", { includeHelp: true }));
    it("status", () =>
        checkFile("status", "status.ts", { includeHelp: false }));
    it("gc", () => checkFile("gc", "gc.ts", { includeHelp: false }));
    it("rollback", () =>
        checkFile("rollback", "rollback.ts", { includeHelp: false }));
    it("db bind", () =>
        checkFile("db bind", "db-bind.ts", { includeHelp: false }));
    it("db migrate", () =>
        checkFile("db migrate", "db-migrate.ts", { includeHelp: false }));
});

describe("1.0 contract: flags — parseArgs-options verbs (scanned from source)", () => {
    /**
     * Every option key + its `short` alias inside a file's OWN
     * `parseArgs({ options: {...} })` call. Each target file has exactly one
     * `parseArgs(` call (asserted per-case below), so scanning the whole file
     * for `key: { ...type: "string"|"boolean"... }` entries cannot pick up an
     * unrelated object literal.
     */
    function extractParseArgsFlags(source: string): string[] {
        const flags = new Set<string>();
        const entryRe =
            /(?:"([\w-]+)"|(?<![\w.])([A-Za-z][\w-]*))\s*:\s*\{([^{}]*)\}/g;
        let m: RegExpExecArray | null;
        // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
        while ((m = entryRe.exec(source)) !== null) {
            const key = m[1] ?? m[2];
            const body = m[3] ?? "";
            if (!key || !/type:\s*"(string|boolean)"/.test(body)) continue;
            flags.add(`--${key}`);
            const short = /short:\s*"(-?\w)"/.exec(body)?.[1];
            if (short) flags.add(`-${short.replace(/^-/, "")}`);
        }
        return [...flags].sort();
    }

    function checkFile(verb: string, relFile: string) {
        const src = readFileSync(join(cliDir, relFile), "utf8");
        expect(
            (src.match(/parseArgs\(/g) ?? []).length,
            `${relFile} must have exactly one parseArgs( call for the scan to be unambiguous`,
        ).toBe(1);
        const real = extractParseArgsFlags(src);
        const contractFlags = [...nonHelpFlags(contractOf(verb))].sort();
        const realNonHelp = real.filter((f) => f !== "-h" && f !== "--help");
        expect(realNonHelp).toEqual(contractFlags);
        // help presence must ALSO match the contract (loadtest/preview have none).
        const contractHasHelp = contractOf(verb).flags.includes("--help");
        expect(real.includes("--help")).toBe(contractHasHelp);
    }

    it("create", () => checkFile("create", "create.ts"));
    it("init-ci", () => checkFile("init-ci", "ci/init-ci-cmd.ts"));
    it("ci-preflight", () =>
        checkFile("ci-preflight", "ci/ci-preflight-cmd.ts"));
    it("deploy", () => checkFile("deploy", "deploy.ts"));
    it("preview", () => checkFile("preview", "preview.ts"));
    it("loadtest", () => checkFile("loadtest", "loadtest.ts"));
});

describe("1.0 contract: exit codes — safe direct proofs", () => {
    it("validate: 0 on --help (no config load), 1 on an unknown flag (usage error, no config load)", async () => {
        expect(await validateMain(["-h"])).toBe(0);
        await expect(validateMain(["--bogus"])).rejects.toThrow(/unknown flag/);
    });

    it("build: --help and --skip-next/--skip-smoke/--self-contained are all in ACCEPTED_BUILD_FLAGS or the help short-circuit", () => {
        for (const f of nonHelpFlags(contractOf("build"))) {
            expect(ACCEPTED_BUILD_FLAGS.has(f)).toBe(true);
        }
    });

    it("gc: 0 on --help without touching config", async () => {
        const { gcMain } = await import("../cli/gc");
        expect(await gcMain(["--help"])).toBe(0);
    });

    it("doctor: 0 on --help without touching the cluster", async () => {
        const { doctorMain } = await import("../cli/doctor");
        const deps: DoctorDeps = {
            kubectl: () => {
                throw new Error("must not be called for --help");
            },
            probeImage: async () => {
                throw new Error("must not be called for --help");
            },
        };
        expect(await doctorMain(["--help"], deps)).toBe(0);
    });

    it("status: exitCodeFor is 1 iff Ready is PRESENT and False (documented in STATUS_HELP)", async () => {
        const { runStatus } = await import("../cli/status");
        const baseDeps = {
            kubectl: (_argv: readonly string[]) => ({
                ok: true,
                stdout: "",
                stderr: "",
            }),
            write: () => {},
            now: () => new Date(),
            sleep: async () => {},
        };
        const readyJson = (ready: string) =>
            JSON.stringify({
                status: {
                    url: "https://x",
                    conditions: [{ type: "Ready", status: ready }],
                },
            });
        const trueDeps = {
            ...baseDeps,
            kubectl: () => ({
                ok: true,
                stdout: readyJson("True"),
                stderr: "",
            }),
        };
        const falseDeps = {
            ...baseDeps,
            kubectl: () => ({
                ok: true,
                stdout: readyJson("False"),
                stderr: "",
            }),
        };
        const opts = {
            namespace: "default",
            watch: false,
            json: false,
            timeoutMs: 1,
        };
        expect(await runStatus("app", opts, trueDeps)).toBe(0);
        expect(await runStatus("app", opts, falseDeps)).toBe(1);
    });
});

describe("1.0 contract: create — flags accepted with a real (throwaway) scaffold dir", () => {
    it("every contract flag is accepted (a scan, not per-flag enumeration, over --dry-run so no files are written)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "knext-cli-contract-create-"));
        try {
            const code = await createMain([
                dir,
                "--name",
                "test-app",
                "--runtime",
                "node",
                "--builder",
                "default",
                "--cache",
                "redis",
                "--storage",
                "s3",
                "--react-compiler",
                "-y",
                "--yes",
                "--force",
                "--dry-run",
            ]);
            expect(code).toBe(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("an unknown flag is rejected (exit 1), proving the accept-set is not permissive", async () => {
        const dir = mkdtempSync(join(tmpdir(), "knext-cli-contract-create-"));
        try {
            const code = await createMain([dir, "--totally-bogus-flag"]);
            expect(code).toBe(1);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("1.0 contract: the CLI reference documents every verb's exit codes", () => {
    const cliDoc = readFileSync(
        resolve(
            cliDir,
            "..",
            "..",
            "..",
            "..",
            "apps/docs/content/docs/cli.mdx",
        ),
        "utf8",
    );

    /** Every `## \`knext <verb>\`` (or `(default)`-suffixed) section, by heading text. */
    function sections(): Map<string, string> {
        const headingRe = /^## (.+)$/gm;
        const matches = [...cliDoc.matchAll(headingRe)];
        const map = new Map<string, string>();
        for (let i = 0; i < matches.length; i++) {
            const start = matches[i]?.index;
            const end = matches[i + 1]?.index ?? cliDoc.length;
            const heading = matches[i]?.[1];
            if (heading !== undefined && start !== undefined) {
                map.set(heading.trim(), cliDoc.slice(start, end));
            }
        }
        return map;
    }

    // Bin-dispatched verbs get their own "## `knext <verb>`" heading; the
    // `db` family shares one section but the heading text differs per verb.
    const headingFor: Record<string, string> = {
        create: "`knext create`",
        "init-ci": "`knext init-ci`",
        "ci-preflight": "`knext ci-preflight`",
        deploy: "`knext deploy` (default)",
        build: "`knext build`",
        cleanup: "`knext cleanup`",
        validate: "`knext validate`",
        doctor: "`knext doctor`",
        status: "`knext status`",
        rollback: "`knext rollback`",
        "db bind": "`knext db bind`",
        "db migrate": "`knext db migrate`",
        gc: "`knext gc`",
    };

    for (const verb of Object.keys(headingFor)) {
        it(`${verb}'s section states an exit code`, () => {
            const map = sections();
            const heading = headingFor[verb] as string;
            const body = map.get(heading);
            expect(
                body,
                `cli.mdx must have a "## ${heading}" section`,
            ).toBeDefined();
            expect(
                (body as string).includes("Exit code"),
                `cli.mdx's "${heading}" section must document an exit code`,
            ).toBe(true);
        });
    }

    it("the experimental (preview/loadtest) entries state their exit codes too", () => {
        const map = sections();
        const body = map.get("Directly runnable entries");
        expect(body).toBeDefined();
        expect((body as string).includes("Exit code")).toBe(true);
        expect((body as string).toLowerCase()).toContain("preview");
        expect((body as string).toLowerCase()).toContain("loadtest");
    });
});

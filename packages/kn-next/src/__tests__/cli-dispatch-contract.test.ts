/**
 * The bin's dispatch contract — two properties that a code review proved were
 * missing, both of which cost a user real damage rather than a bad message:
 *
 *   1. EVERY dispatched verb parses its own argv. The first round's `build` and
 *      `cleanup` branches called their functions with no argument parsing at
 *      all, so `kn-next cleanup --help` DELETED the app instead of printing
 *      help (a reviewer reproduced the CR delete). The guard below scans the
 *      dispatcher and requires each branch to hand `process.argv.slice(3)` to a
 *      `*Main`, which is where `-h/--help` and strict-flag rejection live.
 *
 *   2. An unrecognised FIRST TOKEN is an error, not a silent deploy (ADR-0046).
 *      `kn-next deplyo --dry-run` used to run the deploy flow. A bare
 *      invocation and a flags-only invocation still deploy — that is the
 *      advertised front door and the ADR ratifies it.
 *
 * The verb allowlist is declared ONCE (help.ts `COMMAND_GROUPS`, which also renders
 * the help) and cross-checked here against the dispatcher's actual branches, so
 * the two cannot drift without this file going red.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    formatUnknownCommand,
    KNOWN_VERBS,
    resolveInvocation,
    suggestVerb,
} from "../cli/dispatch";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..", "..");
const deploySrc = readFileSync(
    join(pkgRoot, "src", "cli", "deploy.ts"),
    "utf8",
);

/**
 * Every `(sub === "x") { … }` routing branch, paired with its body.
 *
 * Brace-matched rather than regex-sliced so a nested block inside a branch
 * cannot truncate the body and make the assertion vacuous.
 */
function dispatchBranches(): Array<{ verb: string; body: string }> {
    const out: Array<{ verb: string; body: string }> = [];
    const re = /sub === "([a-z][a-z-]*)"\s*\)\s*\{/g;
    for (const m of deploySrc.matchAll(re)) {
        const verb = m[1];
        if (verb === undefined || m.index === undefined) {
            continue;
        }
        let i = m.index + m[0].length;
        let depth = 1;
        while (i < deploySrc.length && depth > 0) {
            const ch = deploySrc[i];
            if (ch === "{") {
                depth++;
            } else if (ch === "}") {
                depth--;
            }
            i++;
        }
        out.push({ verb, body: deploySrc.slice(m.index + m[0].length, i - 1) });
    }
    return out;
}

describe("every dispatched verb parses its own argv", () => {
    const branches = dispatchBranches();

    it("finds the dispatcher's routing branches", () => {
        expect(branches.length).toBeGreaterThanOrEqual(6);
        expect(branches.map((b) => b.verb)).toContain("cleanup");
    });

    it.each(
        branches.map((b) => b.verb),
    )("`%s` forwards process.argv.slice(3) to a *Main", (verb) => {
        const body = branches.find((b) => b.verb === verb)?.body ?? "";
        // The `*Main(argv)` shape is what makes `-h/--help` and strict flag
        // rejection reachable. A branch that calls a bare worker function
        // (as `cleanup` did) silently ignores every flag the user typed.
        expect(body).toMatch(/Main\(process\.argv\.slice\(3\)\)/);
    });

    it.each(
        branches.map((b) => b.verb),
    )("`%s`'s target module handles -h/--help", (verb) => {
        const module = branches
            .find((b) => b.verb === verb)
            // Subdirectories included: `init-ci` dispatches to `./ci/init-ci-cmd`,
            // and a flat-only pattern does not fail safe here — it reports "no
            // dynamic import found" for a branch that has one, so the verb is
            // never actually checked for --help handling once the message is
            // read as noise.
            ?.body.match(
                /await import\("\.\/([a-z0-9-]+(?:\/[a-z0-9-]+)*)"\)/,
            )?.[1];
        expect(
            module,
            `no dynamic import found in the ${verb} branch`,
        ).toBeDefined();
        const src = readFileSync(
            join(pkgRoot, "src", "cli", `${module}.ts`),
            "utf8",
        );
        // Two idioms are in use and both genuinely parse it: an explicit
        // `argv.includes("--help")` short-circuit (gc, status, cleanup, build,
        // …) and a parseArgs boolean option (create). A main that takes argv
        // and never looks at it matches neither — which is exactly the defect
        // that made `kn-next cleanup --help` delete the app. The dist suite
        // proves the behaviour end-to-end, per verb, on the real bin.
        expect(src).toMatch(
            /includes\("--help"\)|help:\s*\{\s*type:\s*"boolean"/,
        );
    });
});

describe("usage mistakes are UsageErrors, so they render as messages", () => {
    // A usage mistake (unknown flag, stray positional, unknown subcommand) is
    // the user mis-typing, not the tool breaking. Thrown as a plain Error it
    // lands on `log.fatal({ err })` and prints a serialised Error with a stack
    // and an absolute dist chunk path — which a reviewer caught on the
    // strict-flag rejections added in the previous round.
    //
    // THE DEFAULT IS INVERTED, deliberately. Two earlier versions of this guard
    // matched an enumerated list of usage PHRASINGS, and both were defeated:
    //   (A) `doctor.ts` said "unknown argument", not "unknown flag" — missed by
    //       one word, and it shipped.
    //   (B) hoisting the message (`const msg = …; throw new Error(msg)`) left
    //       nothing to match at the throw site at all.
    // Enumerating wordings is the repo's own named defect class, relocated one
    // level down. So: EVERY `throw new Error(` under src/cli is a failure unless
    // its message is on the allowlist below, each entry justified as a genuine
    // environment/cluster/internal failure rather than a user mistake. An
    // unparseable construct — a hoisted message, a novel wording, a helper that
    // builds the string elsewhere — now FAILS rather than passing.
    const THROW_WINDOW = 240;

    /**
     * Message anchors that may be raised as a plain `Error`, per file. Each is
     * NOT a usage mistake: the user could not have avoided it by typing a
     * different command line.
     */
    const NON_USAGE_ALLOWLIST: Record<string, readonly string[]> = {
        // Injectable exec boundary. Empty argv is a programming error inside
        // knext, never something a user types.
        "exec.ts": [
            "runCapture: empty argv",
            "runInherit: empty argv",
            "runQuiet: empty argv",
            "runQuietAllowFail: empty argv",
        ],
        // Registry/build-tool state: the image ref and the buildx metadata are
        // produced by docker, not typed by the user.
        "cr-builder.ts": [
            "contains invalid characters",
            "is not digest-pinned",
            "has no containerimage.digest",
            "does not start with sha256:",
            "Could not resolve digest for image",
        ],
        // Repo state: the app's next.config / lockfile layout, not argv.
        "tracing-root.ts": ["Cannot determine the Docker build context"],
        // Cluster state and kubectl behaviour.
        "status.ts": [
            "not found in namespace",
            "cluster unreachable",
            "kubectl returned unparseable JSON",
        ],
        "db-bind.ts": [
            "not found in namespace",
            "operator predates spec.database.secretRef",
            // Config/CR conflict — the fix is an edit to kn-next.config.ts, not
            // to the command line.
            "it is already defined in spec.secrets.envMap",
            // Internal invariant of an exported builder (unreachable from argv:
            // the CLI path validates `--secret` first).
            "buildDbBindPatch: secret is required",
        ],
        // Install/repo integrity and template hygiene — not argv.
        "create.ts": [
            "could not locate the @getknext/core package root",
            "knext scaffold templates not found",
            "unknown template variable",
            "unsubstituted template placeholder",
        ],
        // Cluster/build state: schema preflight, BUILD_ID skew, CR apply.
        "deploy.ts": [
            "formatPreflightFailure(outcome",
            'BUILD_ID "',
            "describeFailedCRApply()",
            // T2a, the vinext leg of the same BUILD_ID skew check: the state of
            // the BUILD ARTIFACT, not of argv. Fixing it means re-running the
            // build (or restoring the template's generateBuildId), never
            // retyping the command.
            "Could not resolve this build's static id",
            ".output/public/_next/static/${staticId.id}",
        ],
        // Derived name validity: composed from the config's app name + PR id.
        "preview.ts": ["exceeds the 63-char", "is not a valid DNS-1123 label"],
        "preflight.ts": ["formatPreflightFailure(outcome"],
        // Build-time source extraction over cr-builder.ts — an internal
        // invariant of the repo's own tooling.
        "extract-emitted-fields.ts": [
            "buildNextAppCRObject not found",
            "buildNextAppCRObject has no return statement",
        ],
    };

    /** Every .ts under src/cli, including subdirectories (schema/). */
    function cliSources(dir: string, prefix = ""): string[] {
        const out: string[] = [];
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                out.push(
                    ...cliSources(
                        join(dir, entry.name),
                        `${prefix}${entry.name}/`,
                    ),
                );
            } else if (entry.name.endsWith(".ts")) {
                out.push(`${prefix}${entry.name}`);
            }
        }
        return out;
    }

    const cliFiles = cliSources(join(pkgRoot, "src", "cli"));

    it("scans the whole cli tree, subdirectories included", () => {
        expect(cliFiles.length).toBeGreaterThanOrEqual(15);
        expect(cliFiles.some((f) => f.startsWith("schema/"))).toBe(true);
    });

    it.each(cliFiles)("%s: every plain Error is justified", (file) => {
        const src = readFileSync(join(pkgRoot, "src", "cli", file), "utf8");
        const allowed =
            NON_USAGE_ALLOWLIST[file.replace(/^.*\//, "")] ?? ([] as string[]);
        const offenders: string[] = [];
        for (const m of src.matchAll(/throw new Error\(/g)) {
            const window = src
                .slice(m.index, m.index + THROW_WINDOW)
                .replace(/\s+/g, " ");
            if (!allowed.some((anchor) => window.includes(anchor))) {
                offenders.push(window.slice(0, 100));
            }
        }
        expect(
            offenders,
            `${file}: a plain Error prints a FATAL stack dump. If this is a ` +
                "user mistake, throw UsageError; if it is an environment/cluster " +
                "failure, add a justified anchor to NON_USAGE_ALLOWLIST",
        ).toEqual([]);
    });
});

describe("the verb allowlist is the dispatcher's, not a second list", () => {
    it("KNOWN_VERBS matches the dispatcher's branches plus the default", () => {
        const branchVerbs = dispatchBranches().map((b) => b.verb);
        // `deploy` is the default: it has no branch, and the ADR ratifies it as
        // the bare-invocation behaviour, so it is known-but-unbranched.
        expect([...KNOWN_VERBS].sort()).toEqual(
            [...new Set([...branchVerbs, "deploy"])].sort(),
        );
    });
});

describe("resolveInvocation — what counts as a verb", () => {
    it("a bare invocation deploys (the advertised front door)", () => {
        expect(resolveInvocation(undefined)).toEqual({ kind: "deploy" });
    });

    it("a flags-only invocation deploys — a leading `-` is not a verb", () => {
        expect(resolveInvocation("--skip-build")).toEqual({ kind: "deploy" });
        expect(resolveInvocation("-h")).toEqual({ kind: "deploy" });
        expect(resolveInvocation("-v")).toEqual({ kind: "deploy" });
    });

    it("an explicit `deploy` deploys", () => {
        expect(resolveInvocation("deploy")).toEqual({ kind: "deploy" });
    });

    it.each(
        [...KNOWN_VERBS].filter((v) => v !== "deploy"),
    )("`%s` routes as a verb", (verb) => {
        expect(resolveInvocation(verb)).toEqual({ kind: "verb", verb });
    });

    it.each([
        "deplyo",
        "celanup",
        "sttatus",
        "doctro",
    ])("`%s` is an unknown command, not a silent deploy", (typo) => {
        expect(resolveInvocation(typo)).toEqual({
            kind: "unknown",
            input: typo,
        });
    });
});

describe("suggestVerb — nearest verb, or nothing", () => {
    it.each([
        ["deplyo", "deploy"],
        ["celanup", "cleanup"],
        ["doctro", "doctor"],
        ["stats", "status"],
    ])("suggests %s → %s", (input, expected) => {
        expect(suggestVerb(input)).toBe(expected);
    });

    it("suggests nothing for input that resembles no verb", () => {
        expect(suggestVerb("xyzzy")).toBeUndefined();
        expect(suggestVerb("")).toBeUndefined();
    });
});

describe("formatUnknownCommand — an error a newcomer can act on", () => {
    const text = formatUnknownCommand("deplyo");

    it("names the offending token", () => {
        expect(text).toContain("deplyo");
        expect(text.toLowerCase()).toContain("unknown command");
    });

    it("offers the nearest verb and the help pointer", () => {
        expect(text).toContain("deploy");
        expect(text.toLowerCase()).toContain("did you mean");
        expect(text).toContain("--help");
    });

    it("omits the suggestion line when there is no near verb", () => {
        const none = formatUnknownCommand("xyzzy");
        expect(none.toLowerCase()).not.toContain("did you mean");
        expect(none).toContain("--help");
    });

    it("carries no stack frame", () => {
        expect(text).not.toMatch(/\n\s+at\s/);
    });
});

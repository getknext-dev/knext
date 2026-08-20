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

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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
            ?.body.match(/await import\("\.\/([a-z-]+)"\)/)?.[1];
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
    // SCAN so a future verb cannot reintroduce the shape: no CLI module may
    // throw a *plain* Error whose message opens with a usage phrase.
    const USAGE_PHRASES =
        /throw new Error\(\s*(?:`|")(?:unknown flag|unknown db subcommand|unexpected positional|unexpected argument|unknown subcommand)/;

    const cliFiles = readdirSync(join(pkgRoot, "src", "cli")).filter((f) =>
        f.endsWith(".ts"),
    );

    it("scans the whole cli directory", () => {
        expect(cliFiles.length).toBeGreaterThanOrEqual(10);
    });

    it.each(cliFiles)("%s throws UsageError for usage mistakes", (file) => {
        const src = readFileSync(join(pkgRoot, "src", "cli", file), "utf8");
        // Ternaries inside a throw put the phrase after the opening paren, so
        // normalise whitespace before matching.
        const flat = src.replace(/\s+/g, " ");
        expect(
            USAGE_PHRASES.test(flat),
            `${file}: usage mistakes must throw UsageError, not Error — a plain ` +
                "Error prints a FATAL stack dump for what is only a typo",
        ).toBe(false);
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

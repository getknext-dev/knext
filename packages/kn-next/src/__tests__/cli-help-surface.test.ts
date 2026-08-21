/**
 * `kn-next --help` must describe the REAL user-facing surface (UX ledger 1d).
 *
 * The help text used to list seven commands while the bin dispatched more, and
 * README advertised `npx @getknext/core cleanup`, a verb the bin did not route
 * at all — so it silently fell through to a full DEPLOY. For the zero-Kubernetes
 * persona, a teardown command that deploys is worse than a missing one.
 *
 * The assertions here SCAN rather than enumerate (workflow rule): the verb set
 * comes out of the dispatcher source and out of README, so drift on either side
 * reds this file instead of shipping.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLI_HELP, INTERNAL_ONLY_VERBS } from "../cli/help";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..", "..");
const repoRoot = resolve(pkgRoot, "..", "..");
const deploySrc = readFileSync(
    join(pkgRoot, "src", "cli", "deploy.ts"),
    "utf8",
);

/**
 * Verbs the bin's dispatcher actually ROUTES — i.e. `(sub === "x") {`, the
 * branch that runs code.
 *
 * The trailing `) {` matters: the catch block below the chain also mentions
 * every verb, as `sub === "x" ? "x failed" : …`. Matching a bare `sub === "x"`
 * therefore counted a verb as routable when only its ERROR LABEL survived —
 * mutation-proved by deleting the `cleanup` dispatch branch, which left this
 * file green until the pattern was tightened.
 */
function dispatchedVerbs(): string[] {
    const verbs = new Set<string>();
    for (const m of deploySrc.matchAll(/sub === "([a-z][a-z-]*)"\s*\)\s*\{/g)) {
        const v = m[1];
        if (v) {
            verbs.add(v);
        }
    }
    return [...verbs].sort();
}

/**
 * First token of each indented command line in the help's COMMAND sections —
 * i.e. everything above the flag reference, so the `Examples:` block (whose
 * lines start with the bin name, not a verb) is not mistaken for a command.
 */
function helpCommandTokens(): string[] {
    const tokens = new Set<string>();
    const lines = CLI_HELP.split("\n");
    const flagsAt = lines.findIndex((l) => /^Options\b/.test(l));
    expect(flagsAt, "help must have an Options section").toBeGreaterThan(0);
    for (const line of lines.slice(0, flagsAt)) {
        const m = /^ {2}([a-z][a-z-]*)(?:\s|$)/.exec(line);
        if (m?.[1]) {
            tokens.add(m[1]);
        }
    }
    return [...tokens].sort();
}

describe("help lists every verb the bin dispatches", () => {
    const dispatched = dispatchedVerbs();

    it("finds the dispatcher's verbs (scan, not a hardcoded list)", () => {
        expect(dispatched.length).toBeGreaterThanOrEqual(6);
        expect(dispatched).toContain("create");
    });

    it.each(dispatched)("`%s` appears in --help", (verb) => {
        expect(helpCommandTokens()).toContain(verb);
    });

    it("advertises no verb the dispatcher cannot route", () => {
        // `deploy` is the default (no `sub ===` branch) and is legitimately
        // listed; every other advertised token must be routable.
        const routable = new Set([...dispatchedVerbs(), "deploy"]);
        const unroutable = helpCommandTokens().filter((t) => !routable.has(t));
        expect(unroutable).toEqual([]);
    });

    it("keeps deliberately-internal entries out of the help", () => {
        for (const verb of INTERNAL_ONLY_VERBS) {
            expect(helpCommandTokens()).not.toContain(verb);
        }
    });
});

describe("help puts `create` first, under a start-here grouping", () => {
    it("has a start-here heading", () => {
        expect(CLI_HELP).toMatch(/^Start here:$/m);
    });

    it("`create` is the first command listed anywhere in the help", () => {
        expect(helpCommandTokens()).toContain("create");
        const first = CLI_HELP.split("\n").find((l) =>
            /^ {2}[a-z][a-z-]*(?:\s|$)/.test(l),
        );
        expect(first?.trim().startsWith("create")).toBe(true);
    });

    it("points a newcomer at the docs", () => {
        expect(CLI_HELP).toContain("https://knext.dev");
    });
});

describe("README advertises only verbs the bin routes", () => {
    // README.md:800 advertised `npx @getknext/core cleanup` while the bin fell
    // through to deploy. Scan every advertised invocation instead of trusting
    // one line to stay correct.
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    const advertised = [
        ...new Set(
            [...readme.matchAll(/npx @getknext\/core\s+([a-z][a-z-]*)/g)]
                .map((m) => m[1])
                .filter((v): v is string => v !== undefined),
        ),
    ].sort();

    it("finds advertised invocations to check", () => {
        expect(advertised.length).toBeGreaterThanOrEqual(3);
    });

    it.each(advertised)("`npx @getknext/core %s` is a real verb", (verb) => {
        expect([...dispatchedVerbs(), "deploy"]).toContain(verb);
    });
});

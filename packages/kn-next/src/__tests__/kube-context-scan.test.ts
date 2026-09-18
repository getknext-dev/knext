/**
 * #978 — generalised STATIC source-scan: every kubectl argv literal a
 * CONTEXT-RESOLVING verb issues must be threaded through `withKubeContext`.
 *
 * The sibling `kube-context.test.ts` proves each verb BEHAVIOURALLY — it scans
 * the argvs a given mock run happens to exercise. That leaves an enumeration
 * gap: a kubectl call added later (or reached only on a branch the behavioural
 * fixtures never drive) that forgets the context would red NO test, which is
 * exactly the #978 bug class (silent wrong-cluster action). The sibling
 * `cr-apply-strict-validation.test.ts` records that this same enumeration hazard
 * "missed the preview deploy apply" the first time round.
 *
 * So this guard scans SOURCE, per the repo's "prefer scanning to enumerating"
 * rule. Scope: the `*.ts` files DIRECTLY inside `packages/kn-next/src/cli/`
 * (`readdirSync`, top level only — mirroring `scanApplySites`).
 *
 * The invariant it enforces is precisely #978's: a verb that RESOLVES a target
 * context (calls `resolveKubeContext` / uses `withKubeContext`) must honour it
 * at EVERY kubectl site — otherwise a user's `--context staging` is obeyed by
 * some of the verb's kubectl calls and silently ignored by others. A file that
 * resolves NO context cannot ignore a context it never reads, so it is out of
 * this invariant's scope — but that exclusion is made SAFE: such a file is
 * asserted to reference no `--context` / `KN_CONTEXT` / context helper at all,
 * so the moment someone wires context into it without wrapping a kubectl call,
 * it enters the checked set and this guard reds.
 *
 * Anti-vacuity: the scanner understands ONE construct (a flat argv array
 * literal). Any kubectl call in a context-resolving file the scanner cannot
 * read — a nested `[`, a non-literal binary, `argv.push("get", …)` — makes the
 * per-file verb count exceed the parsed-site count and FAILS this suite rather
 * than passing silently (same discipline as cr-apply-strict-validation.test.ts:
 * "a construct the scanner cannot read fails this suite rather than passing").
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_FILE = fileURLToPath(import.meta.url);
const CLI_DIR = join(dirname(TEST_FILE), "..", "cli");

/* ------------------------------------------------------------------ *
 * Lexer helpers — copied from cr-apply-strict-validation.test.ts so    *
 * the two guards read kubectl argv literals the same way.              *
 * ------------------------------------------------------------------ */

/** Blank out comments while preserving line numbers (so failures point home). */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
        .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Index of the string terminator starting at `start` (quote char at start). */
function skipString(s: string, start: number): number {
    const quote = s[start];
    for (let i = start + 1; i < s.length; i++) {
        if (s[i] === "\\") {
            i++;
            continue;
        }
        if (s[i] === quote) return i;
    }
    return s.length;
}

/** Index of the `]` matching the `[` at `start`, or -1. */
function matchBracket(s: string, start: number): number {
    let depth = 0;
    for (let i = start; i < s.length; i++) {
        const c = s[i];
        if (c === '"' || c === "'" || c === "`") {
            i = skipString(s, i);
            continue;
        }
        if (c === "[") depth++;
        else if (c === "]" && --depth === 0) return i;
    }
    return -1;
}

interface KubectlSite {
    file: string;
    line: number;
    args: string[];
    /** True when the argv literal is a direct argument to `withKubeContext(`. */
    wrapped: boolean;
}

/**
 * Find every flat argv array literal that spawns `kubectl`, in BOTH shapes the
 * CLI uses: `run*(["kubectl", …])` and `execFileSync("kubectl", ["verb", …])`.
 * A site is "wrapped" iff the `[` opening the argv is a direct argument to
 * `withKubeContext(` (whitespace/newlines between the two are allowed — every
 * multi-line `withKubeContext(\n  [\n "kubectl", …` in the CLI matches).
 */
function scanKubectlSites(file: string, rawSource: string): KubectlSite[] {
    const src = stripComments(rawSource);
    const sites: KubectlSite[] = [];
    for (let i = 0; i < src.length; i++) {
        if (src[i] !== "[") continue;
        const end = matchBracket(src, i);
        if (end < 0) continue;
        const region = src.slice(i + 1, end);
        if (region.includes("[")) continue; // not a flat argv literal
        const args = [...region.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)].map(
            (m) => m[2] as string,
        );
        const before = src.slice(0, i);
        const isKubectlArgv =
            args[0] === "kubectl" ||
            // execFileSync("kubectl", ["verb", …]) — binary is the arg before.
            /["'`]kubectl["'`]\s*,\s*$/.test(before);
        if (!isKubectlArgv) continue;
        sites.push({
            file,
            line: before.split("\n").length,
            args,
            wrapped: /withKubeContext\(\s*$/.test(before),
        });
    }
    return sites;
}

/**
 * Every occurrence of the `"kubectl"` binary LITERAL — in any quote form — in
 * comment-stripped source. This is the counting half of the anti-vacuity guard:
 * `scanKubectlSites` only parses a flat argv array literal, so anything else
 * that spawns kubectl is invisible to it. Counting the binary literal makes
 * those constructs FAIL LOUDLY (literal present, no parsed site) instead of
 * passing silently.
 */
function kubectlLiteralLines(src: string): number[] {
    const out: number[] = [];
    for (const m of src.matchAll(/(['"`])kubectl\1/g)) {
        out.push(src.slice(0, m.index).split("\n").length);
    }
    return out;
}

/**
 * Does this file RESOLVE a target kube context? If so, #978 requires it thread
 * that context into every kubectl call it issues. Detected structurally, never
 * by a hardcoded filename list.
 */
function resolvesContext(strippedSrc: string): boolean {
    return (
        /\bresolveKubeContext\s*\(/.test(strippedSrc) ||
        /\bwithKubeContext\b/.test(strippedSrc)
    );
}

/* ------------------------------------------------------------------ *
 * The allowlist. Keyed on the EXACT argv, never a blanket file exempt. *
 * Only genuinely context-IRRELEVANT (client-only, no cluster) calls    *
 * belong here — a cluster-touching kubectl call must be wrapped, never  *
 * allowlisted.                                                          *
 * ------------------------------------------------------------------ */
interface AllowEntry {
    argv: string[];
    reason: string;
}
const CLIENT_ONLY_ALLOWLIST: AllowEntry[] = [
    {
        // deploy.ts — reads the LOCAL kubectl's own version to decide how to
        // phrase a strict-validation failure. `--client` contacts no cluster,
        // so a target context is meaningless here; threading one in would be
        // noise, not safety.
        argv: ["kubectl", "version", "--client", "-o", "json"],
        reason: "client-only: reads local kubectl version, touches no cluster",
    },
];

function isAllowlisted(args: string[]): AllowEntry | undefined {
    return CLIENT_ONLY_ALLOWLIST.find(
        (e) =>
            e.argv.length === args.length &&
            e.argv.every((tok, i) => tok === args[i]),
    );
}

/** Read every top-level `*.ts` under src/cli (non-recursive), name→source. */
function readCliSources(): Map<string, string> {
    const out = new Map<string, string>();
    for (const entry of readdirSync(CLI_DIR, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
        out.set(entry.name, readFileSync(join(CLI_DIR, entry.name), "utf-8"));
    }
    return out;
}

describe("#978 — every kubectl call in a context-resolving verb is withKubeContext-wrapped", () => {
    it("no context-resolving verb issues a raw (unwrapped, non-client-only) kubectl call", () => {
        const sources = readCliSources();
        let checkedSites = 0;

        for (const [name, raw] of sources) {
            const stripped = stripComments(raw);
            if (!resolvesContext(stripped)) continue; // out of #978 scope
            for (const site of scanKubectlSites(name, raw)) {
                const where = `${site.file}:${site.line} (${site.args.join(" ")})`;
                if (site.wrapped) {
                    checkedSites++;
                    continue;
                }
                const allow = isAllowlisted(site.args);
                expect(
                    allow,
                    `${where} — a context-resolving verb issues this kubectl call WITHOUT withKubeContext(...) and it is not a client-only allowlisted argv. A user's --context/KN_CONTEXT would be silently ignored by this call (the #978 wrong-cluster bug). Wrap it: withKubeContext([...], context).`,
                ).toBeDefined();
                checkedSites++;
            }
        }

        // Non-vacuity: the six context-resolving verbs issue ~15 kubectl calls
        // today. If the scanner finds far fewer, it has gone blind — fail.
        expect(
            checkedSites,
            "the scanner found almost no kubectl sites in context-resolving verbs — the guard has gone vacuous",
        ).toBeGreaterThanOrEqual(10);
    });

    it('every `"kubectl"` literal in a context-resolving verb is a site the scanner parsed (an unparsed construct fails, it does not slip through)', () => {
        const sources = readCliSources();
        for (const [name, raw] of sources) {
            const stripped = stripComments(raw);
            if (!resolvesContext(stripped)) continue;
            const litLines = kubectlLiteralLines(stripped);
            const sites = scanKubectlSites(name, raw);
            // Both shapes count one binary literal per site: the argv-first
            // `["kubectl", …]` and the `execFileSync("kubectl", […])` binary.
            expect(
                litLines.length,
                `${name}: ${litLines.length} \`"kubectl"\` binary literal(s) (line(s) ${litLines.join(", ") || "-"}) but only ${sites.length} argv the scanner could parse (line(s) ${sites.map((s) => s.line).join(", ") || "-"}). A kubectl call the parser cannot read is NOT allowed to be unverifiable — rewrite it as a flat argv array literal.`,
            ).toBe(sites.length);
        }
    });

    it("context-AGNOSTIC verbs stay agnostic — they reference no context, so their unwrapped kubectl calls are excluded SAFELY", () => {
        // status.ts / loadtest.ts issue cluster kubectl calls but resolve no
        // context and expose no --context flag, so they cannot silently ignore
        // a context a user asked for (the #978 bug requires a resolved-then-
        // ignored context). This makes the "resolvesContext" exclusion above
        // safe: assert such files reference NO context surface at all, so the
        // instant someone threads --context/KN_CONTEXT into one without wrapping
        // its kubectl calls, it enters the checked set and the first test reds.
        const sources = readCliSources();
        let agnosticWithKubectl = 0;
        for (const [name, raw] of sources) {
            const stripped = stripComments(raw);
            if (resolvesContext(stripped)) continue;
            const sites = scanKubectlSites(name, raw);
            if (sites.length === 0) continue;
            agnosticWithKubectl++;
            expect(
                /--context|KN_CONTEXT|resolveKubeContext|withKubeContext/.test(
                    stripped,
                ),
                `${name} issues kubectl calls and is treated as context-agnostic, but it references a context surface (--context/KN_CONTEXT/resolveKubeContext/withKubeContext). Either it resolves a context — then wrap EVERY kubectl call in withKubeContext(...) — or the reference is spurious and must go.`,
            ).toBe(false);
        }
        // Non-vacuity of THIS guard: there is at least one such verb today
        // (status.ts get, loadtest.ts apply). If none is found the exclusion is
        // untested.
        expect(
            agnosticWithKubectl,
            "no context-agnostic verb with kubectl calls found — the safe-exclusion guard is vacuous",
        ).toBeGreaterThanOrEqual(1);
    });
});

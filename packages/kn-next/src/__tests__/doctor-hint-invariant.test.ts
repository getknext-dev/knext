import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The invariant the doctor promises: EVERY FAIL/ERROR result carries a repair
 * hint, so a user who hits a failing check always gets an actionable next step.
 *
 * This is a SCANNING guard, not an enumeration (workflow.md: "prefer scanning to
 * enumerating — an unhandled site FAILS rather than passes"). It statically
 * finds every `mk(...)` call across `doctor/checks/*.ts` and asserts that any
 * with a `"fail"`/`"error"` status literal also passes a (5th) hint argument.
 * A new hint-less fail/error result — today or in a future check — reds this.
 *
 * All doctor results are built via `mk(id, title, status, detail, hint?)`
 * (report.ts); there is no direct CheckResult construction in checks/, so
 * scanning `mk()` calls covers every result — with one assumption: `mk` is
 * imported UNALIASED (all check files today `import { mk } from "../report"`).
 * This is a text scanner, not an AST pass, so a file that aliased the import
 * (`import { mk as x }`) would hide its calls; a rename that conspicuous would
 * stand out in review. Fail-closed on non-literal status closes the dynamic-arg
 * hole; the alias hole is the residual limit of grep-based scanning.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKS_DIR = join(HERE, "..", "cli", "doctor", "checks");

/** Extract each mk(...) call's top-level argument list from source — handles
 *  multi-line calls, nested parens, strings and template literals. */
function mkCallArgs(src: string): string[][] {
    const out: string[][] = [];
    let i = src.indexOf("mk(", 0);
    while (i !== -1) {
        const prev = src[i - 1];
        // Only a bare `mk(` (not `xmk(` / `.mk(` / `Amk(`).
        if (prev && /[A-Za-z0-9_$.]/.test(prev)) {
            i = src.indexOf("mk(", i + 3);
            continue;
        }
        let depth = 0;
        let quote = "";
        let cur = "";
        const args: string[] = [];
        let j = i + 2; // points at '('
        for (; j < src.length; j++) {
            const c = src[j];
            if (quote) {
                cur += c;
                if (c === "\\") {
                    cur += src[++j];
                } else if (c === quote) {
                    quote = "";
                }
                continue;
            }
            if (c === '"' || c === "'" || c === "`") {
                quote = c;
                cur += c;
                continue;
            }
            if (c === "(") {
                depth++;
                if (depth === 1) continue; // opening paren of the mk() call
                cur += c;
                continue;
            }
            if (c === ")") {
                depth--;
                if (depth === 0) {
                    if (cur.trim()) args.push(cur.trim());
                    break;
                }
                cur += c;
                continue;
            }
            if (c === "," && depth === 1) {
                args.push(cur.trim());
                cur = "";
                continue;
            }
            cur += c;
        }
        out.push(args);
        i = src.indexOf("mk(", j + 1);
    }
    return out;
}

// The status literals the doctor uses. A status arg that is NOT one of these is
// a VARIABLE/expression the scanner cannot evaluate — so it cannot prove the call
// is not a hint-less fail/error. The guard FAILS CLOSED on those: use a literal
// status (or the invariant is unverifiable). This closes the false-negative where
// a dynamic-status `mk(..., status, ...)` slips past a literal-only check.
const STATUS_LITERALS = new Set([
    '"fail"',
    "'fail'",
    '"error"',
    "'error'",
    '"warn"',
    "'warn'",
    '"skip"',
    "'skip'",
    '"pass"',
    "'pass'",
    '"info"',
    "'info'",
]);

const isFailOrError = (statusArg: string | undefined) =>
    statusArg === '"fail"' ||
    statusArg === "'fail'" ||
    statusArg === '"error"' ||
    statusArg === "'error'";

const emptyHint = (hintArg: string | undefined) =>
    hintArg === undefined ||
    hintArg === '""' ||
    hintArg === "''" ||
    hintArg === "``";

describe("doctor — every FAIL/ERROR result carries a repair hint (scanning guard)", () => {
    const files = readdirSync(CHECKS_DIR).filter(
        (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    );

    it("no fail/error mk() call is missing a hint, across every check module", () => {
        const offenders: string[] = [];
        for (const f of files) {
            const src = readFileSync(join(CHECKS_DIR, f), "utf8");
            for (const args of mkCallArgs(src)) {
                const status = args[2];
                if (status === undefined) continue;
                if (!STATUS_LITERALS.has(status)) {
                    // Fail closed: a non-literal status is unverifiable, so it
                    // could be a hint-less fail/error. Use a literal status.
                    offenders.push(
                        `${f}: mk(${args[0]}) has a NON-LITERAL status (${status}) — the hint invariant is only checkable with a literal status; split the call per status`,
                    );
                    continue;
                }
                if (isFailOrError(status) && emptyHint(args[4])) {
                    offenders.push(
                        `${f}: mk(${args[0]}, ${status}) has no repair hint`,
                    );
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it("the scanner actually finds fail/error mk() calls (non-vacuity)", () => {
        let n = 0;
        for (const f of files) {
            const src = readFileSync(join(CHECKS_DIR, f), "utf8");
            for (const args of mkCallArgs(src)) if (isFailOrError(args[2])) n++;
        }
        expect(n).toBeGreaterThan(5);
    });
});

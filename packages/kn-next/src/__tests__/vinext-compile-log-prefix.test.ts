/**
 * #1421 review round 1 — the original `COMPILE_LOG_PREFIX` "drift guard"
 * caught nothing: `vinext-compile.mjs` never imports the constant, and the
 * old test compared the constant to a literal WRITTEN IN THE TEST ITSELF —
 * the reviewer renamed all 16 `[knext compile]` prefixes in the real `.mjs`
 * file and every spec stayed green, because nothing ever read that file.
 *
 * Cross-process importing the constant into `vinext-compile.mjs` is not
 * viable: that script is shipped and invoked as a STANDALONE `bun run
 * <path>` process (`compileArgv` in `vinext-build.ts`), and `vinext-build.ts`
 * itself is bundled by tsup into the single `dist/cli/kn-next.js` — there is
 * no addressable `dist/cli/exec.js`/`dist/cli/vinext-build.js` module for a
 * sibling `dist/adapters/vinext-compile.js` to import at runtime.
 *
 * So this is the OTHER option the review offered: a scan. It reads the REAL
 * `vinext-compile.mjs` source, extracts every own-message output call
 * (`console.<method>(...)` for ANY method, plus `process.stdout.write(...)`),
 * and asserts every one that carries a literal first argument starts with
 * `COMPILE_LOG_PREFIX`.
 *
 * #1421 review round 2 (jev 0.82) — that first pass still FAILED OPEN on
 * three independent bypasses, all now closed:
 *   1. `console.log(<non-literal>)` was silently SKIPPED (excluded because
 *      its literal prefix parsed as `null`) instead of being treated as an
 *      offender — so a non-literal, unprefixed message passed silently.
 *   2. `console.info(...)`/`console.debug(...)` were never matched at all —
 *      the old regex only covered `log|warn|error`.
 *   3. `process.stdout.write(...)` was never scanned — an entirely
 *      different call shape that bypasses `console.*` altogether.
 *
 * The fix: match `console\.\w+\(` (any method) and `process\.stdout\.write\(`;
 * treat a `null`/unparseable first argument as an OFFENDER, not a skip; and
 * exempt ONLY the exact, allowlisted `console.error(String(log))` site
 * (bun's own build-log objects, reprinted verbatim — never ours to prefix),
 * matched by an EXACT substring at the call's own source position, with an
 * assertion that the allowlisted text occurs EXACTLY ONCE in the file (so a
 * second, unaudited use of the same exact text cannot ride along for free,
 * and a rename of the one legitimate site is itself caught).
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMPILE_LOG_PREFIX } from "../cli/vinext-build";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPILE_SCRIPT_PATH = resolve(HERE, "../adapters/vinext-compile.mjs");

interface ConsoleCall {
    kind: "console" | "stdout-write";
    /** `null` for `process.stdout.write`, which has no method name. */
    method: string | null;
    /** The literal text up to the first `${` (template) or closing quote
     * (string) — `null` when the first argument is NOT a string/template
     * literal at all (e.g. `String(log)`, a bare identifier, a call). A
     * `null` prefix is NOT automatically excluded from the prefix
     * requirement — see `findOffenders`. */
    literalPrefix: string | null;
    /** Index into `source` where the matched call text begins — used to
     * anchor the exact-match allowlist. */
    index: number;
}

/** Matches `console.<any method>(` or `process.stdout.write(`. */
const CALL_RE = /console\.(\w+)\(|process\.stdout\.write\(/g;

/**
 * Extracts every `console.<method>(`/`process.stdout.write(` call's first
 * argument literal prefix from `source`. Deliberately does NOT fully parse
 * the call's argument list (no bracket-depth tracking needed) — it only has
 * to read far enough to answer "is the very first token a string/template
 * literal, and if so what literal text comes before any interpolation or the
 * closing quote".
 */
export function extractConsoleCalls(source: string): ConsoleCall[] {
    const calls: ConsoleCall[] = [];
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
    while ((m = CALL_RE.exec(source))) {
        const isStdoutWrite = m[0].startsWith("process.stdout.write");
        const method = isStdoutWrite ? null : (m[1] ?? null);
        const index = m.index;
        let i = CALL_RE.lastIndex;
        while (i < source.length && /\s/.test(source[i] ?? "")) i++;
        const ch = source[i];
        let literalPrefix: string | null = null;
        if (ch === '"' || ch === "'") {
            const quote = ch;
            let j = i + 1;
            let buf = "";
            while (j < source.length && source[j] !== quote) {
                if (source[j] === "\\") {
                    buf += (source[j] ?? "") + (source[j + 1] ?? "");
                    j += 2;
                    continue;
                }
                buf += source[j];
                j++;
            }
            literalPrefix = buf;
        } else if (ch === "`") {
            let j = i + 1;
            let buf = "";
            while (j < source.length && source[j] !== "`") {
                if (source[j] === "\\") {
                    buf += (source[j] ?? "") + (source[j + 1] ?? "");
                    j += 2;
                    continue;
                }
                if (source[j] === "$" && source[j + 1] === "{") break;
                buf += source[j];
                j++;
            }
            literalPrefix = buf;
        }
        calls.push({
            kind: isStdoutWrite ? "stdout-write" : "console",
            method,
            literalPrefix,
            index,
        });
    }
    return calls;
}

/**
 * Exact substrings exempt from the prefix requirement — bun's own build-log
 * objects, reprinted verbatim via `console.error(String(log))`, which is
 * never ours to prefix. Matched by an EXACT substring at the call's own
 * source position (not a loose `.includes` anywhere in the file), so a call
 * with the same METHOD but different text is still held to the requirement.
 */
const ALLOWLISTED_EXACT_CALLS = ["console.error(String(log))"];

/** Counts every occurrence of `needle` in `haystack` (non-overlapping). */
function countOccurrences(haystack: string, needle: string): number {
    let count = 0;
    let idx = haystack.indexOf(needle);
    while (idx !== -1) {
        count++;
        idx = haystack.indexOf(needle, idx + needle.length);
    }
    return count;
}

/**
 * Fails closed: every allowlisted exact call text MUST occur exactly once in
 * `source`. Zero occurrences means the site was renamed/removed (the
 * allowlist entry is stale and should be deleted, not silently ignored);
 * more than one means a second, unaudited use of the same exact text would
 * otherwise ride along on the one legitimate exemption for free. Deliberately
 * a SEPARATE assertion from `findOffenders` below (called only against the
 * real `vinext-compile.mjs` source, not against every synthetic snippet
 * `findOffenders` is unit-tested against) — an arbitrary snippet has no
 * obligation to contain the allowlisted text at all.
 */
function assertAllowlistIntegrity(source: string, sourceLabel: string): void {
    for (const entry of ALLOWLISTED_EXACT_CALLS) {
        const count = countOccurrences(source, entry);
        if (count !== 1) {
            throw new Error(
                `allowlist entry ${JSON.stringify(entry)} must occur exactly once in ` +
                    `${sourceLabel}, found ${count}`,
            );
        }
    }
}

function isAllowlisted(source: string, call: ConsoleCall): boolean {
    return ALLOWLISTED_EXACT_CALLS.some(
        (entry) =>
            source.slice(call.index, call.index + entry.length) === entry,
    );
}

/**
 * Every call that is NOT allowlisted and either (a) has no literal prefix at
 * all (non-literal/unparseable first argument — fail CLOSED, not skipped),
 * or (b) has a literal prefix that does not start with `prefix`. Does NOT
 * itself require the allowlisted text to be present — callers scanning the
 * real file assert that separately via `assertAllowlistIntegrity`.
 */
function findOffenders(source: string, prefix: string): ConsoleCall[] {
    return extractConsoleCalls(source).filter((c) => {
        if (isAllowlisted(source, c)) return false;
        if (c.literalPrefix === null) return true;
        return !c.literalPrefix.startsWith(prefix);
    });
}

describe("extractConsoleCalls (the scanner itself, against synthetic snippets)", () => {
    it("extracts a plain double-quoted string", () => {
        const calls = extractConsoleCalls('console.log("hello world");');
        expect(calls).toEqual([
            {
                kind: "console",
                method: "log",
                literalPrefix: "hello world",
                index: 0,
            },
        ]);
    });

    it("extracts a single-quoted string", () => {
        const calls = extractConsoleCalls("console.warn('be careful');");
        expect(calls).toEqual([
            {
                kind: "console",
                method: "warn",
                literalPrefix: "be careful",
                index: 0,
            },
        ]);
    });

    it("extracts the leading literal text of a template literal, stopping at the first ${ interpolation", () => {
        const calls = extractConsoleCalls(
            "console.log(`[x] ${n} thing(s) happened`);",
        );
        expect(calls).toEqual([
            { kind: "console", method: "log", literalPrefix: "[x] ", index: 0 },
        ]);
    });

    it("extracts a template literal with NO interpolation at all", () => {
        const calls = extractConsoleCalls("console.log(`plain template`);");
        expect(calls).toEqual([
            {
                kind: "console",
                method: "log",
                literalPrefix: "plain template",
                index: 0,
            },
        ]);
    });

    it("records a null literalPrefix when the first argument is NOT a string/template literal (e.g. String(log))", () => {
        const calls = extractConsoleCalls("console.error(String(log));");
        expect(calls).toEqual([
            { kind: "console", method: "error", literalPrefix: null, index: 0 },
        ]);
    });

    it("handles a call split across multiple lines (whitespace before the literal)", () => {
        const calls = extractConsoleCalls(
            "console.log(\n    `[x] warned`,\n);",
        );
        expect(calls).toEqual([
            {
                kind: "console",
                method: "log",
                literalPrefix: "[x] warned",
                index: 0,
            },
        ]);
    });

    it("finds multiple calls in one source, in order", () => {
        const calls = extractConsoleCalls(
            'console.log("first");\nconsole.warn("second");',
        );
        expect(calls.map((c) => c.literalPrefix)).toEqual(["first", "second"]);
    });

    it("matches console.info and console.debug, not just log|warn|error (#1421 review round 2)", () => {
        const calls = extractConsoleCalls(
            'console.info("hi");\nconsole.debug("bye");',
        );
        expect(calls.map((c) => [c.method, c.literalPrefix])).toEqual([
            ["info", "hi"],
            ["debug", "bye"],
        ]);
    });

    it("matches process.stdout.write, a call shape console.* cannot cover (#1421 review round 2)", () => {
        const calls = extractConsoleCalls('process.stdout.write("raw\\n");');
        expect(calls).toEqual([
            {
                kind: "stdout-write",
                method: null,
                literalPrefix: "raw\\n",
                index: 0,
            },
        ]);
    });
});

describe("findOffenders (#1421 review round 2 — the three bypasses, closed)", () => {
    it("bypass 1 CLOSED: a non-literal first argument is an OFFENDER, not silently skipped", () => {
        const offenders = findOffenders("console.log(someVariable);", "[x]");
        expect(offenders).toEqual([
            { kind: "console", method: "log", literalPrefix: null, index: 0 },
        ]);
    });

    it("bypass 2 CLOSED: an unprefixed console.info/console.debug call is an OFFENDER", () => {
        const offenders = findOffenders(
            'console.info("no prefix here");\nconsole.debug("nor here");',
            "[x]",
        );
        expect(offenders.map((c) => c.method)).toEqual(["info", "debug"]);
    });

    it("bypass 3 CLOSED: an unprefixed process.stdout.write call is an OFFENDER", () => {
        const offenders = findOffenders(
            'process.stdout.write("no prefix");',
            "[x]",
        );
        expect(offenders).toEqual([
            {
                kind: "stdout-write",
                method: null,
                literalPrefix: "no prefix",
                index: 0,
            },
        ]);
    });

    it("the exact allowlisted console.error(String(log)) site is NOT an offender", () => {
        const offenders = findOffenders("console.error(String(log));", "[x]");
        expect(offenders).toEqual([]);
    });

    it("a DIFFERENT non-literal console.error call (not the exact allowlisted text) IS an offender — the allowlist is exact-match, not method-wide", () => {
        const offenders = findOffenders("console.error(String(logs));", "[x]");
        expect(offenders).toEqual([
            { kind: "console", method: "error", literalPrefix: null, index: 0 },
        ]);
    });

    it("assertAllowlistIntegrity fails closed when the allowlisted text is absent", () => {
        expect(() =>
            assertAllowlistIntegrity("console.log(`[x] fine`);", "synthetic"),
        ).toThrow(/must occur exactly once/);
    });

    it("assertAllowlistIntegrity fails closed when the allowlisted text occurs more than once", () => {
        const source =
            "console.error(String(log));\nconsole.error(String(log));";
        expect(() => assertAllowlistIntegrity(source, "synthetic")).toThrow(
            /must occur exactly once/,
        );
    });
});

describe("#1421 review round 1 — every own-message output call in vinext-compile.mjs carries COMPILE_LOG_PREFIX", () => {
    it("non-vacuity: the real file has more than one console call with a literal first argument", () => {
        const source = readFileSync(COMPILE_SCRIPT_PATH, "utf8");
        const calls = extractConsoleCalls(source);
        const withLiteral = calls.filter((c) => c.literalPrefix !== null);
        expect(withLiteral.length).toBeGreaterThan(1);
    });

    it("non-vacuity: the scanner actually finds the allowlisted String(log) shape in the real file, proving it is not silently dropping calls", () => {
        const source = readFileSync(COMPILE_SCRIPT_PATH, "utf8");
        const calls = extractConsoleCalls(source);
        expect(calls.some((c) => c.literalPrefix === null)).toBe(true);
    });

    it("the allowlisted String(log) site occurs exactly once in the real file (fails closed otherwise)", () => {
        const source = readFileSync(COMPILE_SCRIPT_PATH, "utf8");
        expect(() =>
            assertAllowlistIntegrity(source, COMPILE_SCRIPT_PATH),
        ).not.toThrow();
    });

    it("every own-message console/stdout call, except the allowlisted String(log) reprint, starts with COMPILE_LOG_PREFIX", () => {
        const source = readFileSync(COMPILE_SCRIPT_PATH, "utf8");
        assertAllowlistIntegrity(source, COMPILE_SCRIPT_PATH);
        const offenders = findOffenders(source, COMPILE_LOG_PREFIX);
        expect(
            offenders,
            `${offenders.length} call(s) in vinext-compile.mjs do not start with "${COMPILE_LOG_PREFIX}" and are not allowlisted`,
        ).toEqual([]);
    });
});

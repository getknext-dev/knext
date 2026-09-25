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
 * `vinext-compile.mjs` source, extracts every `console.(log|warn|error)(...)`
 * call's FIRST argument (when that argument is a string/template literal —
 * `console.error(String(log))`, which reprints bun's OWN build-log objects
 * verbatim, is correctly excluded: that text is never ours to prefix), and
 * asserts every one starts with `COMPILE_LOG_PREFIX` — the SAME exported
 * constant `vinext-build.ts` wires into `runQuiet`'s `surfaceStdoutPrefix`.
 * A rename on EITHER side (the constant, or any literal in the real file)
 * now breaks this test, closing the drift the review found.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMPILE_LOG_PREFIX } from "../cli/vinext-build";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPILE_SCRIPT_PATH = resolve(HERE, "../adapters/vinext-compile.mjs");

interface ConsoleCall {
    method: "log" | "warn" | "error";
    /** The literal text up to the first `${` (template) or closing quote
     * (string) — null when the first argument is NOT a string/template
     * literal at all (e.g. `String(log)`), which is excluded from the
     * prefix requirement. */
    literalPrefix: string | null;
}

/**
 * Extracts every `console.(log|warn|error)(` call's first-argument literal
 * prefix from `source`. Deliberately does NOT fully parse the call's
 * argument list (no bracket-depth tracking needed) — it only has to read
 * far enough to answer "is the very first token a string/template literal,
 * and if so what literal text comes before any interpolation or the
 * closing quote", which is exactly what determines whether a message is
 * "ours to prefix".
 */
export function extractConsoleCalls(source: string): ConsoleCall[] {
    const calls: ConsoleCall[] = [];
    const re = /console\.(log|warn|error)\(/g;
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
    while ((m = re.exec(source))) {
        const method = m[1] as ConsoleCall["method"];
        let i = re.lastIndex;
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
        calls.push({ method, literalPrefix });
    }
    return calls;
}

describe("extractConsoleCalls (the scanner itself, against synthetic snippets)", () => {
    it("extracts a plain double-quoted string", () => {
        const calls = extractConsoleCalls('console.log("hello world");');
        expect(calls).toEqual([
            { method: "log", literalPrefix: "hello world" },
        ]);
    });

    it("extracts a single-quoted string", () => {
        const calls = extractConsoleCalls("console.warn('be careful');");
        expect(calls).toEqual([
            { method: "warn", literalPrefix: "be careful" },
        ]);
    });

    it("extracts the leading literal text of a template literal, stopping at the first ${ interpolation", () => {
        const calls = extractConsoleCalls(
            "console.log(`[x] ${n} thing(s) happened`);",
        );
        expect(calls).toEqual([{ method: "log", literalPrefix: "[x] " }]);
    });

    it("extracts a template literal with NO interpolation at all", () => {
        const calls = extractConsoleCalls("console.log(`plain template`);");
        expect(calls).toEqual([
            { method: "log", literalPrefix: "plain template" },
        ]);
    });

    it("excludes a call whose first argument is NOT a string/template literal (e.g. String(log))", () => {
        const calls = extractConsoleCalls("console.error(String(log));");
        expect(calls).toEqual([{ method: "error", literalPrefix: null }]);
    });

    it("handles a call split across multiple lines (whitespace before the literal)", () => {
        const calls = extractConsoleCalls(
            "console.log(\n    `[x] warned`,\n);",
        );
        expect(calls).toEqual([{ method: "log", literalPrefix: "[x] warned" }]);
    });

    it("finds multiple calls in one source, in order", () => {
        const calls = extractConsoleCalls(
            'console.log("first");\nconsole.warn("second");',
        );
        expect(calls.map((c) => c.literalPrefix)).toEqual(["first", "second"]);
    });
});

describe("#1421 review round 1 — every own-message console call in vinext-compile.mjs carries COMPILE_LOG_PREFIX", () => {
    it("non-vacuity: the real file has more than one console call with a literal first argument", () => {
        const source = readFileSync(COMPILE_SCRIPT_PATH, "utf8");
        const calls = extractConsoleCalls(source);
        const withLiteral = calls.filter((c) => c.literalPrefix !== null);
        expect(withLiteral.length).toBeGreaterThan(1);
    });

    it("non-vacuity: the scanner actually finds the excluded String(log) shape in the real file, proving it is not silently dropping calls", () => {
        const source = readFileSync(COMPILE_SCRIPT_PATH, "utf8");
        const calls = extractConsoleCalls(source);
        expect(calls.some((c) => c.literalPrefix === null)).toBe(true);
    });

    it("every console call with a literal first argument starts with COMPILE_LOG_PREFIX", () => {
        const source = readFileSync(COMPILE_SCRIPT_PATH, "utf8");
        const calls = extractConsoleCalls(source);
        const offenders = calls
            .filter((c) => c.literalPrefix !== null)
            .filter((c) => !c.literalPrefix?.startsWith(COMPILE_LOG_PREFIX));
        expect(
            offenders,
            `${offenders.length} console call(s) in vinext-compile.mjs do not start with "${COMPILE_LOG_PREFIX}"`,
        ).toEqual([]);
    });
});

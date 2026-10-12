/**
 * Every production `runProjectBuild(` call must pass `requireEsm`, `runtimeId`
 * and `builderId` as literal top-level properties.
 *
 * Why a scan: the Bun turbopack-fragments guard inside `runProjectBuild` only
 * runs when both `runtimeId` and `builderId` are present, so a future caller
 * that omits either would skip the guard silently. The ids stay optional in the
 * type (unit tests and the vinext single-executable path legitimately omit
 * them), so this scan is what makes omission a red CI instead of a quiet skip.
 *
 * Fail-closed: a call whose argument is not an object literal, uses a spread,
 * or cannot be parsed is an offender, never a pass.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_KEYS = ["requireEsm", "runtimeId", "builderId"] as const;
const CALL = "runProjectBuild(";

/** Blank out line and block comments so prose cannot form a "call". */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
        .replace(/^\s*\/\/.*$/gm, "");
}

/** Top-level property names of an object-literal body (text after the `{`). */
function topLevelKeys(body: string): Set<string> {
    const keys = new Set<string>();
    let depth = 0;
    let quote: string | undefined;
    let entry = "";
    const flush = () => {
        const k = entry.trim().match(/^([A-Za-z_$][\w$]*)\s*(:|$)/);
        if (k) keys.add(k[1]);
        entry = "";
    };
    for (let j = 0; j < body.length; j++) {
        const c = body[j];
        if (quote) {
            entry += c;
            if (c === "\\") entry += body[++j] ?? "";
            else if (c === quote) quote = undefined;
            continue;
        }
        if (c === '"' || c === "'" || c === "`") {
            quote = c;
            entry += c;
            continue;
        }
        if (c === "(" || c === "{" || c === "[") depth++;
        else if (c === ")" || c === "}" || c === "]") depth--;
        if (depth === 0 && c === ",") flush();
        else entry += c;
    }
    flush();
    return keys;
}

/**
 * Scan `src` for runProjectBuild calls. Returns one problem string per call
 * site that is missing a required key or cannot be verified, plus the number
 * of call sites seen.
 */
export function scanRunProjectBuildCalls(
    src: string,
    label: string,
): { problems: string[]; calls: number } {
    const code = stripComments(src);
    const problems: string[] = [];
    let calls = 0;
    let from = 0;
    for (;;) {
        const at = code.indexOf(CALL, from);
        if (at === -1) break;
        from = at + CALL.length;
        calls++;
        const where = `${label}@${code.slice(0, at).split("\n").length}`;

        // Walk to the balancing `)`, tracking nesting and skipping strings.
        let depth = 1;
        let quote: string | undefined;
        let commaAtTop = false;
        let arg = "";
        for (let i = from; i < code.length && depth > 0; i++) {
            const c = code[i];
            if (quote) {
                arg += c;
                if (c === "\\") arg += code[++i] ?? "";
                else if (c === quote) quote = undefined;
                continue;
            }
            if (c === '"' || c === "'" || c === "`") {
                quote = c;
                arg += c;
                continue;
            }
            if (c === "(" || c === "{" || c === "[") depth++;
            else if (c === ")" || c === "}" || c === "]") depth--;
            if (depth === 1 && c === ",") commaAtTop = true;
            if (depth > 0) arg += c;
        }
        if (depth !== 0) {
            problems.push(`${where}: unparseable call (unbalanced)`);
            continue;
        }
        const trimmed = arg.trim();
        if (!trimmed.startsWith("{") || commaAtTop) {
            problems.push(`${where}: argument is not a single object literal`);
            continue;
        }
        // `arg` stops before the call's `)`, so the literal's closing `}` is
        // already consumed by the walk; the body is what follows the `{`.
        const body = trimmed.slice(1);
        if (/(^|[\s,{])\.\.\./.test(body)) {
            problems.push(`${where}: spread argument cannot be verified`);
            continue;
        }
        const keys = topLevelKeys(body);
        for (const key of REQUIRED_KEYS) {
            if (!keys.has(key)) problems.push(`${where}: missing ${key}`);
        }
    }
    return { problems, calls };
}

describe("scanRunProjectBuildCalls (the scanner itself)", () => {
    const ok = `runProjectBuild({
        requireEsm: (config.build ?? X) === "vinext",
        builderId: config.build ?? X,
        runtimeId: config.runtime ?? Y,
    });`;

    it("accepts a call carrying all three keys", () => {
        expect(scanRunProjectBuildCalls(ok, "t")).toEqual({
            problems: [],
            calls: 1,
        });
    });

    it("flags an omitted runtimeId", () => {
        const { problems } = scanRunProjectBuildCalls(
            "runProjectBuild({ requireEsm: true, builderId: 'x' });",
            "t",
        );
        expect(problems).toEqual(["t@1: missing runtimeId"]);
    });

    it("flags an omitted builderId", () => {
        const { problems } = scanRunProjectBuildCalls(
            "runProjectBuild({ requireEsm: true, runtimeId: 'x' });",
            "t",
        );
        expect(problems).toEqual(["t@1: missing builderId"]);
    });

    it("does not credit a key that only appears nested", () => {
        const { problems } = scanRunProjectBuildCalls(
            "runProjectBuild({ requireEsm: true, run: () => ({ runtimeId: 1, builderId: 2 }) });",
            "t",
        );
        expect(problems).toEqual([
            "t@1: missing runtimeId",
            "t@1: missing builderId",
        ]);
    });

    it("fails closed on a non-literal argument", () => {
        const { problems } = scanRunProjectBuildCalls(
            "runProjectBuild(opts);",
            "t",
        );
        expect(problems).toHaveLength(1);
    });

    it("fails closed on a spread argument", () => {
        const { problems } = scanRunProjectBuildCalls(
            "runProjectBuild({ ...base, requireEsm: true, runtimeId: 'a', builderId: 'b' });",
            "t",
        );
        expect(problems).toHaveLength(1);
    });

    it("fails closed on an unparseable (unbalanced) call", () => {
        const { problems } = scanRunProjectBuildCalls(
            "runProjectBuild({ requireEsm: true, ",
            "t",
        );
        expect(problems).toEqual(["t@1: unparseable call (unbalanced)"]);
    });

    it("ignores calls that appear only in comments", () => {
        const { calls } = scanRunProjectBuildCalls(
            "// runProjectBuild(opts)\n/* runProjectBuild(x) */",
            "t",
        );
        expect(calls).toBe(0);
    });
});

describe("every production runProjectBuild( call passes requireEsm, runtimeId and builderId", () => {
    it("scans the real src/cli sources", () => {
        const cliDir = join(
            resolve(dirname(fileURLToPath(import.meta.url)), ".."),
            "cli",
        );
        const problems: string[] = [];
        let calls = 0;
        for (const file of readdirSync(cliDir)) {
            if (!file.endsWith(".ts") || file === "project-build.ts") continue;
            if (/\.test\.ts$/.test(file)) continue;
            const r = scanRunProjectBuildCalls(
                readFileSync(join(cliDir, file), "utf8"),
                file,
            );
            calls += r.calls;
            problems.push(...r.problems);
        }
        // build, deploy and preview.
        expect(calls).toBeGreaterThanOrEqual(3);
        expect(
            problems,
            "pass requireEsm, runtimeId: config.runtime ?? DEFAULT_RUNTIME_ID and builderId: config.build ?? DEFAULT_BUILDER_ID",
        ).toEqual([]);
    });
});

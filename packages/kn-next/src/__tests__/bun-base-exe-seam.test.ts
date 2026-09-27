/**
 * #1452 — the `KNEXT_BUN_BASE_EXE` seam (CI-only patched Bun base executable).
 *
 * Three layers, each red on its own mutation:
 *   1. SCAN, not enumerate, on a real parser (TypeScript's, over the .mjs):
 *      every adapter script that references `Bun.build` or sets a `compile`
 *      property is a compile script; it must call `Bun.build` exactly once,
 *      directly, and every `compile` value must be an object literal that
 *      spreads `...BUN_BASE_EXE` exactly once and LAST — so a non-literal
 *      value, a second build, or a reordered seam is red (#1469 round 11).
 *      Round 12: the scan covers adapters/** recursively, every JS/TS
 *      extension, and exactly the two compile scripts may build; in them Bun is
 *      reachable only as the literal `Bun.<name>` — no `"bun"` module, no
 *      `globalThis`, no computed key or write outside a reviewed set, and a
 *      compile literal spreads only the seam and reviewed expressions.
 *      The seam must never be readable from config or CLI flags (CI-only).
 *   2. The fail-closed table of `bunBaseExeCompileOptions()`.
 *   3. Both real scripts, in default AND `--self-contained` mode, run as
 *      processes with `Bun.build` stubbed by a preload that records EVERY
 *      call, so the assertion is on what the scripts actually hand to
 *      Bun.build: exactly one shipped build; absent → no `executablePath` key
 *      at all; a verified base → `executablePath`; every bad state → exit 1
 *      before any Bun.build runs. The stub answers SUCCESS (round 12), so the
 *      scripts run to their last line and a build after the success check —
 *      in the script or in anything it imports — is recorded too.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmodSync,
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import {
    BUN_BASE_EXE_ENV,
    bunBaseExeCompileOptions,
} from "../adapters/bun-base-exe.mjs";

const ADAPTERS = resolve(import.meta.dir, "..", "adapters");
const SRC = resolve(import.meta.dir, "..");

const tempDirs: string[] = [];
afterAll(() => {
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix: string): string {
    // realpath: on macOS TMPDIR is under /var → /private/var, and compile-embed compares the
    // entry's path with the realpath'd embed root.
    const d = mkdtempSync(join(realpathSync(tmpdir()), prefix));
    tempDirs.push(d);
    return d;
}
function write(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
}
const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

/** A fake base executable with a valid sibling `.sha256`. */
function verifiedBase(): string {
    const dir = tmp("knext-bun-base-");
    const exe = join(dir, "bun");
    copyFileSync(process.execPath, exe);
    chmodSync(exe, 0o755);
    writeFileSync(`${exe}.sha256`, `${sha256(readFileSync(exe))}  bun\n`);
    return exe;
}

// ── 1. scan ──────────────────────────────────────────────────────────────────

/** One `compile` property as the PARSER sees it (TypeScript's, on the .mjs). */
type CompileSite = {
    line: number;
    /** Its value is an object literal (not an identifier, member, call, …). */
    literal: boolean;
    /** The value's syntax kind, for the failure message. */
    valueKind: string;
    /** `...BUN_BASE_EXE` spreads in the literal. */
    seams: number;
    /** `...BUN_BASE_EXE` is the literal's LAST element, so nothing after it can displace it. */
    seamLast: boolean;
    /** An `executablePath` key anywhere in it (the seam must be its only source). */
    execPath: boolean;
};
type ScriptScan = {
    compiles: CompileSite[];
    /** `{ compile }`, `compile() {}`, `get compile()` — a compile value the literal rule cannot see. */
    shorthand: number[];
    /** `x.compile = …` / `x["compile"] = …` — compile set after the literal. */
    writes: number[];
    /** A `"compile"` string anywhere else (`Object.defineProperty(o, "compile", …)`, `o[k]`). */
    compileStrings: number[];
    /** `Bun.build(…)` calls, and every reference to `Bun.build` (an alias is a second one). */
    buildCalls: number;
    buildRefs: number;
    /** `Bun` used other than as `Bun.<name>` or `typeof Bun` (`const B = Bun`, `Bun["build"]`, `{ build } = Bun`). */
    bunIndirect: number[];
    // ── round 12 (review-1469-r11 MEDIUM-1): the other ways to reach Bun.build ──
    /** The `"bun"` module: `import … from "bun"`, `export … from "bun"`, `import("bun")`, `require("bun")`
     *  — any call with the literal argument `"bun"` (`(await import("bun")).build === Bun.build`). */
    bunModule: number[];
    /** `import(x)` / `require(x)` with a specifier that is not a string literal (it can spell "bun"). */
    dynamicSpecifier: number[];
    /** `globalThis` / `self` / `global` / `window` as a value (`globalThis["Bun"]`, `globalThis.Bun`). */
    globalRefs: number[];
    /** `.Bun`, `["Bun"]` or a `"Bun"` string — Bun reached through some other object. */
    bunProp: number[];
    /** Anything named `build` other than the one `Bun.build`: `x.build`, `x["build"]`, a `"build"`
     *  string, `{ build }` destructuring. */
    buildNames: number[];
    /** A computed key that is not a string literal (`{ ["executable" + "Path"]: p }`, `{ [k]: v }`). */
    computedKeys: number[];
    /** `o[k] = …` with a key that is not a string literal (a computed write of any key). */
    computedWrites: string[];
    /** Per compile literal, its spreads other than the seam, as source text. */
    compileSpreads: string[];
};

/**
 * Parse a script and collect every compile site and every `Bun.build` reference. A regex over the
 * text saw only `compile: { … }` literals (#1469 round 10, MEDIUM-1): `compile: opts.compile`, a
 * second `Bun.build`, and a seam spread moved first all stayed green. The parser sees each of them.
 */
function scanScript(file: string, source: string): ScriptScan {
    const sf = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        /\.[mc]?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS,
    );
    const lineOf = (n: ts.Node) =>
        sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const nameOf = (n: ts.PropertyName | undefined): string | undefined => {
        if (!n) return undefined;
        if (
            ts.isIdentifier(n) ||
            ts.isStringLiteralLike(n) ||
            ts.isNumericLiteral(n)
        )
            return n.text;
        if (
            ts.isComputedPropertyName(n) &&
            ts.isStringLiteralLike(n.expression)
        )
            return n.expression.text;
        return undefined;
    };
    const isSeam = (e: ts.ObjectLiteralElementLike | undefined) =>
        !!e &&
        ts.isSpreadAssignment(e) &&
        ts.isIdentifier(e.expression) &&
        e.expression.text === "BUN_BASE_EXE";
    const hasExecPath = (n: ts.Node): boolean => {
        let hit = false;
        const visit = (m: ts.Node) => {
            if (
                (ts.isPropertyAssignment(m) ||
                    ts.isShorthandPropertyAssignment(m)) &&
                nameOf(m.name) === "executablePath"
            )
                hit = true;
            ts.forEachChild(m, visit);
        };
        visit(n);
        return hit;
    };
    const isBunBuild = (n: ts.Node): n is ts.PropertyAccessExpression =>
        ts.isPropertyAccessExpression(n) &&
        n.name.text === "build" &&
        ((ts.isIdentifier(n.expression) && n.expression.text === "Bun") ||
            (ts.isPropertyAccessExpression(n.expression) &&
                n.expression.name.text === "Bun"));

    const out: ScriptScan = {
        compiles: [],
        shorthand: [],
        writes: [],
        compileStrings: [],
        buildCalls: 0,
        buildRefs: 0,
        bunIndirect: [],
        bunModule: [],
        dynamicSpecifier: [],
        globalRefs: [],
        bunProp: [],
        buildNames: [],
        computedKeys: [],
        computedWrites: [],
        compileSpreads: [],
    };
    const isLit = (e: ts.Expression) =>
        ts.isStringLiteralLike(e) || ts.isNumericLiteral(e);
    const visit = (n: ts.Node) => {
        // ── round 12: every other road to Bun.build ──
        if (
            (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
            n.moduleSpecifier &&
            ts.isStringLiteralLike(n.moduleSpecifier) &&
            n.moduleSpecifier.text === "bun"
        )
            out.bunModule.push(lineOf(n));
        if (ts.isCallExpression(n)) {
            if (
                n.arguments.some(
                    (a) => ts.isStringLiteralLike(a) && a.text === "bun",
                )
            )
                out.bunModule.push(lineOf(n));
            const isImport = n.expression.kind === ts.SyntaxKind.ImportKeyword;
            const isRequire =
                ts.isIdentifier(n.expression) &&
                n.expression.text === "require";
            if (
                (isImport || isRequire) &&
                !(n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]))
            )
                out.dynamicSpecifier.push(lineOf(n));
        }
        if (
            ts.isIdentifier(n) &&
            ["globalThis", "self", "global", "window"].includes(n.text) &&
            !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) &&
            !(ts.isPropertyAssignment(n.parent) && n.parent.name === n)
        )
            out.globalRefs.push(lineOf(n));
        if (
            (ts.isPropertyAccessExpression(n) && n.name.text === "Bun") ||
            (ts.isStringLiteralLike(n) && n.text === "Bun")
        )
            out.bunProp.push(lineOf(n));
        if (
            (ts.isPropertyAccessExpression(n) &&
                n.name.text === "build" &&
                !isBunBuild(n)) ||
            (ts.isStringLiteralLike(n) && n.text === "build") ||
            (ts.isBindingElement(n) &&
                ((n.propertyName && nameOf(n.propertyName) === "build") ||
                    (!n.propertyName &&
                        ts.isIdentifier(n.name) &&
                        n.name.text === "build")))
        )
            out.buildNames.push(lineOf(n));
        if (ts.isComputedPropertyName(n) && !isLit(n.expression))
            out.computedKeys.push(lineOf(n));
        if (
            ts.isBinaryExpression(n) &&
            n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            n.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
            ts.isElementAccessExpression(n.left) &&
            !isLit(n.left.argumentExpression)
        )
            out.computedWrites.push(n.getText(sf));

        if (ts.isPropertyAssignment(n) && nameOf(n.name) === "compile") {
            const v = n.initializer;
            const literal = ts.isObjectLiteralExpression(v);
            const props = literal
                ? v.properties
                : ts.factory.createNodeArray<ts.ObjectLiteralElementLike>();
            for (const p of props)
                if (ts.isSpreadAssignment(p) && !isSeam(p))
                    out.compileSpreads.push(p.getText(sf));
            out.compiles.push({
                line: lineOf(n),
                literal,
                valueKind: ts.SyntaxKind[v.kind],
                seams: props.filter(isSeam).length,
                seamLast: isSeam(props[props.length - 1]),
                execPath: hasExecPath(v),
            });
        } else if (
            (ts.isShorthandPropertyAssignment(n) ||
                ts.isMethodDeclaration(n) ||
                ts.isGetAccessorDeclaration(n) ||
                ts.isSetAccessorDeclaration(n)) &&
            nameOf(n.name) === "compile"
        ) {
            out.shorthand.push(lineOf(n));
        } else if (
            ts.isBinaryExpression(n) &&
            n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            n.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
            ((ts.isPropertyAccessExpression(n.left) &&
                n.left.name.text === "compile") ||
                (ts.isElementAccessExpression(n.left) &&
                    ts.isStringLiteralLike(n.left.argumentExpression) &&
                    n.left.argumentExpression.text === "compile"))
        ) {
            out.writes.push(lineOf(n));
        }
        if (
            ts.isStringLiteralLike(n) &&
            n.text === "compile" &&
            !(ts.isPropertyAssignment(n.parent) && n.parent.name === n) &&
            !ts.isComputedPropertyName(n.parent)
        )
            out.compileStrings.push(lineOf(n));
        if (isBunBuild(n)) {
            out.buildRefs++;
            if (ts.isCallExpression(n.parent) && n.parent.expression === n)
                out.buildCalls++;
        }
        if (
            ts.isIdentifier(n) &&
            n.text === "Bun" &&
            !(
                ts.isPropertyAccessExpression(n.parent) &&
                n.parent.expression === n
            ) &&
            !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) &&
            !ts.isTypeOfExpression(n.parent)
        )
            out.bunIndirect.push(lineOf(n));
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
}

/**
 * Scripts that call `Bun.build(` but are not compile scripts. Each is reviewed: `compile-embed.mjs`
 * builds throwaway probe binaries (`detectCompileInclude`) to DETECT what stock Bun embeds — never a
 * shipped executable. Its probe calls are also filtered out of the end-to-end legs below by outfile.
 */
const NOT_A_COMPILE_SCRIPT_REVIEWED = new Set(["compile-embed.mjs"]);
/** How many compile objects each known compile script has (a dropped one is a lost seam). */
const COMPILE_SITES: Record<string, number> = {
    "vinext-compile.mjs": 2, // sidecar + self-contained
    "standalone-compile.mjs": 2, // base + self-contained
};

/** The spreads a compile literal may carry besides the seam, exactly (round 12): a spread of any
 *  other expression can carry an `executablePath` no key check sees — `...JSON.parse(env.X)`. */
const REVIEWED_COMPILE_SPREADS = new Set([
    "...(TARGET ? { target: TARGET } : {})",
    "...shape.compile",
    "...opts.compile",
    "...base.compile",
]);

/** Computed writes a compile script may make, exactly: its argv parser and a report tally. Neither
 *  object reaches Bun.build; any other `o[k] = …` (it can write `executablePath`) is red. */
const REVIEWED_COMPUTED_WRITES = new Set([
    "out[key.slice(2)] = argv[i + 1]",
    "kinds[ext] = (kinds[ext] ?? 0) + 1",
]);

/** Every JS/TS module under adapters/, recursively (round 12: `.mjs` in the top directory only let a
 *  second build live in `adapters/zz-rebuild.js`). Unit tests are not shipped and are skipped. */
function adapterModules(dir = ADAPTERS): string[] {
    const found: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name !== "__tests__") found.push(...adapterModules(p));
        } else if (/\.(mjs|js|cjs|ts|mts|cts)$/.test(e.name)) found.push(p);
    }
    return found;
}

describe("KNEXT_BUN_BASE_EXE seam — scan", () => {
    const all = adapterModules().map((p) => {
        const file = relative(ADAPTERS, p);
        const source = readFileSync(p, "utf8");
        return { file, source, scan: scanScript(file, source) };
    });
    // SCAN, not enumerate: a compile script is any script that references Bun.build or sets a
    // compile property, however it is shaped.
    const touches = all.filter(
        ({ scan }) =>
            scan.buildRefs > 0 ||
            scan.compiles.length > 0 ||
            scan.shorthand.length > 0 ||
            scan.writes.length > 0,
    );
    const scripts = touches.filter(
        ({ file }) => !NOT_A_COMPILE_SCRIPT_REVIEWED.has(file),
    );

    it("finds the compile scripts, and ONLY them (a new module that builds is red)", () => {
        expect(all.length).toBeGreaterThan(40);
        expect(all.some((s) => /\.ts$/.test(s.file))).toBe(true);
        expect(scripts.map((s) => s.file).sort()).toEqual(
            Object.keys(COMPILE_SITES).sort(),
        );
    });

    it("no other adapter module reaches Bun.build or the bun module (any extension, any depth)", () => {
        const offenders = all
            .filter(({ file }) => !(file in COMPILE_SITES))
            .map(({ file, scan }) => ({
                file,
                buildRefs: NOT_A_COMPILE_SCRIPT_REVIEWED.has(file)
                    ? 0
                    : scan.buildRefs,
                bunModule: scan.bunModule,
                buildNames: NOT_A_COMPILE_SCRIPT_REVIEWED.has(file)
                    ? []
                    : scan.buildNames,
            }))
            .filter(
                (o) =>
                    o.buildRefs > 0 ||
                    o.bunModule.length > 0 ||
                    o.buildNames.length > 0,
            );
        expect(offenders).toEqual([]);
    });

    it("the reviewed spreads and computed writes are each used (no stale entry)", () => {
        const spreads = new Set(scripts.flatMap((s) => s.scan.compileSpreads));
        const writes = new Set(scripts.flatMap((s) => s.scan.computedWrites));
        expect(
            [...REVIEWED_COMPILE_SPREADS].filter((x) => !spreads.has(x)),
        ).toEqual([]);
        expect(
            [...REVIEWED_COMPUTED_WRITES].filter((x) => !writes.has(x)),
        ).toEqual([]);
    });

    it("the reviewed non-compile exemption stays load-bearing (not a stale entry)", () => {
        for (const f of NOT_A_COMPILE_SCRIPT_REVIEWED)
            expect(touches.map((s) => s.file)).toContain(f);
    });

    it("counts every compile object in the known compile scripts (a dropped one is red)", () => {
        for (const [file, n] of Object.entries(COMPILE_SITES))
            expect({
                file,
                n: all.find((s) => s.file === file)?.scan.compiles.length,
            }).toEqual({
                file,
                n,
            });
    });

    for (const { file, source, scan } of scripts) {
        describe(file, () => {
            it("resolves the seam through bunBaseExeCompileOptions()", () => {
                expect(source).toContain(
                    'import { bunBaseExeCompileOptions } from "./bun-base-exe.mjs";',
                );
                expect(source).toMatch(
                    /BUN_BASE_EXE = bunBaseExeCompileOptions\(\);/,
                );
            });

            it("calls Bun.build exactly once, directly (no second build, no alias)", () => {
                expect({
                    calls: scan.buildCalls,
                    refs: scan.buildRefs,
                    bunIndirect: scan.bunIndirect,
                }).toEqual({ calls: 1, refs: 1, bunIndirect: [] });
            });

            it("reaches Bun only as the literal `Bun.<name>`: no bun module, no globalThis, no computed key or write", () => {
                expect({
                    bunModule: scan.bunModule,
                    dynamicSpecifier: scan.dynamicSpecifier,
                    globalRefs: scan.globalRefs,
                    bunProp: scan.bunProp,
                    buildNames: scan.buildNames,
                    computedKeys: scan.computedKeys,
                    computedWrites: scan.computedWrites.filter(
                        (w) => !REVIEWED_COMPUTED_WRITES.has(w),
                    ),
                }).toEqual({
                    bunModule: [],
                    dynamicSpecifier: [],
                    globalRefs: [],
                    bunProp: [],
                    buildNames: [],
                    computedKeys: [],
                    computedWrites: [],
                });
            });

            it("every compile literal spreads only the seam and the reviewed spreads", () => {
                expect(
                    scan.compileSpreads.filter(
                        (s) => !REVIEWED_COMPILE_SPREADS.has(s),
                    ),
                ).toEqual([]);
            });

            it("every compile value is an object literal, never an identifier/member/call", () => {
                expect(scan.compiles.length).toBeGreaterThan(0);
                expect(scan.compiles.filter((c) => !c.literal)).toEqual([]);
                expect({
                    shorthand: scan.shorthand,
                    writes: scan.writes,
                    compileStrings: scan.compileStrings,
                }).toEqual({ shorthand: [], writes: [], compileStrings: [] });
            });

            it("every compile literal spreads ...BUN_BASE_EXE exactly once, LAST, and is the only executablePath", () => {
                for (const c of scan.compiles)
                    expect({
                        line: c.line,
                        seams: c.seams,
                        seamLast: c.seamLast,
                        execPath: c.execPath,
                    }).toEqual({
                        line: c.line,
                        seams: 1,
                        seamLast: true,
                        execPath: false,
                    });
            });
        });
    }

    // The scanner itself, on inputs shaped like the round-10 bypasses: each must be seen.
    it.each<[string, string, (s: ScriptScan) => unknown, unknown]>([
        [
            "T4: compile: opts.compile (member)",
            "Bun.build({ compile: opts.compile });",
            (s) => s.compiles[0]?.literal,
            false,
        ],
        [
            "compile: c (identifier)",
            "Bun.build({ compile: c });",
            (s) => s.compiles[0]?.literal,
            false,
        ],
        [
            "compile: f() (call)",
            "Bun.build({ compile: f() });",
            (s) => s.compiles[0]?.literal,
            false,
        ],
        [
            "compile: true",
            "Bun.build({ compile: true });",
            (s) => s.compiles[0]?.literal,
            false,
        ],
        [
            "spread-only compile literal (no seam)",
            "Bun.build({ compile: { ...opts.compile } });",
            (s) => s.compiles[0]?.seams,
            0,
        ],
        [
            "T1: seam spread first",
            "Bun.build({ compile: { ...BUN_BASE_EXE, ...o } });",
            (s) => s.compiles[0]?.seamLast,
            false,
        ],
        [
            "seam then a key",
            "Bun.build({ compile: { ...BUN_BASE_EXE, outfile: x } });",
            (s) => s.compiles[0]?.seamLast,
            false,
        ],
        [
            "seam spread twice",
            "Bun.build({ compile: { ...BUN_BASE_EXE, ...BUN_BASE_EXE } });",
            (s) => s.compiles[0]?.seams,
            2,
        ],
        [
            "executablePath key",
            "Bun.build({ compile: { executablePath: p, ...BUN_BASE_EXE } });",
            (s) => s.compiles[0]?.execPath,
            true,
        ],
        [
            '"compile": quoted key',
            'Bun.build({ "compile": o.c });',
            (s) => s.compiles[0]?.literal,
            false,
        ],
        [
            '["compile"]: computed key',
            'Bun.build({ ["compile"]: o.c });',
            (s) => s.compiles[0]?.literal,
            false,
        ],
        [
            "{ compile } shorthand",
            "const compile = {}; Bun.build({ compile });",
            (s) => s.shorthand.length,
            1,
        ],
        [
            "o.compile = …",
            "o.compile = { outfile };",
            (s) => s.writes.length,
            1,
        ],
        [
            'o["compile"] = …',
            'o["compile"] = { outfile };',
            (s) => s.writes.length,
            1,
        ],
        [
            'Object.defineProperty(o, "compile", …)',
            'Object.defineProperty(o, "compile", { value: 1 });',
            (s) => s.compileStrings.length,
            1,
        ],
        [
            "T2/T6: a second Bun.build call",
            "await Bun.build(a); await Bun.build(b);",
            (s) => s.buildCalls,
            2,
        ],
        [
            "an alias of Bun.build",
            "const b = Bun.build; await b(a);",
            (s) => s.buildRefs - s.buildCalls,
            1,
        ],
        [
            "Bun['build']",
            "await Bun['build'](a);",
            (s) => s.bunIndirect.length,
            1,
        ],
        [
            "const { build } = Bun",
            "const { build } = Bun; await build(a);",
            (s) => s.bunIndirect.length,
            1,
        ],
        [
            "globalThis.Bun.build",
            "await globalThis.Bun.build(a);",
            (s) => s.buildCalls,
            1,
        ],
        // round 12 (review-1469-r11 MEDIUM-1): the roads the round-11 scan did not see
        [
            'S1p/S2p: (await import("bun")).build(…) after the success check',
            'const r2 = await (await import("bun")).build({ ...o, [k]: { ...o[k], ["executable" + "Path"]: undefined } });',
            (s) => ({
                bunModule: s.bunModule.length,
                computedKeys: s.computedKeys.length,
                buildNames: s.buildNames.length,
            }),
            { bunModule: 1, computedKeys: 2, buildNames: 1 },
        ],
        [
            'import { build } from "bun"',
            'import { build } from "bun"; await build(a);',
            (s) => s.bunModule.length,
            1,
        ],
        [
            'require("bun").build',
            'require("bun").build(a);',
            (s) => s.bunModule.length,
            1,
        ],
        [
            "import(spec) with a computed specifier",
            'await import("b" + "un");',
            (s) => s.dynamicSpecifier.length,
            1,
        ],
        [
            'S3: globalThis["Bun"].build',
            'await globalThis["Bun"].build(a);',
            (s) => ({ g: s.globalRefs.length, b: s.bunProp.length }),
            { g: 1, b: 1 },
        ],
        [
            "globalThis[k] (a computed global)",
            "const B = globalThis[k];",
            (s) => s.globalRefs.length,
            1,
        ],
        [
            "S5: a computed executablePath key",
            'const c = { ...(process.env.X ? { ["executable" + "Path"]: process.env.X } : {}), ...BUN_BASE_EXE };',
            (s) => s.computedKeys.length,
            1,
        ],
        [
            "o[k] = v (a computed write)",
            'o[k] = "/tmp/bun";',
            (s) => s.computedWrites.length,
            1,
        ],
        [
            "a compile spread outside the reviewed set",
            "Bun.build({ compile: { outfile, ...JSON.parse(process.env.X), ...BUN_BASE_EXE } });",
            (s) => s.compileSpreads,
            ["...JSON.parse(process.env.X)"],
        ],
        [
            "typeof Bun is not an indirect use",
            'if (typeof Bun === "undefined") throw 0;',
            (s) => s.bunIndirect.length,
            0,
        ],
    ])("the scan sees: %s", (_n, src, pick, want) => {
        expect(pick(scanScript("probe.mjs", src))).toEqual(want);
    });

    it("is never read from config or the CLI (CI-only by decision)", () => {
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const e of readdirSync(dir, { withFileTypes: true })) {
                const p = join(dir, e.name);
                if (e.isDirectory()) {
                    if (e.name !== "__tests__") walk(p);
                } else if (/\.(ts|mts|js|mjs|cjs)$/.test(e.name)) {
                    if (
                        p === join(ADAPTERS, "bun-base-exe.mjs") ||
                        p === join(ADAPTERS, "bun-base-exe.d.mts")
                    )
                        continue;
                    if (readFileSync(p, "utf8").includes(BUN_BASE_EXE_ENV))
                        offenders.push(p);
                }
            }
        };
        walk(SRC);
        expect(offenders).toEqual([]);
    });
});

// ── 2. fail-closed table ─────────────────────────────────────────────────────

/** The seam is CI-only: every positive case runs as a GitHub Actions job. */
const inCI = (value: string) => ({
    GITHUB_ACTIONS: "true",
    [BUN_BASE_EXE_ENV]: value,
});

describe("bunBaseExeCompileOptions — fail closed", () => {
    it("absent → {} with no own keys (compile options unchanged)", () => {
        for (const env of [{}, { GITHUB_ACTIONS: "true" }]) {
            const out = bunBaseExeCompileOptions(env);
            expect(Object.keys(out)).toEqual([]);
            const base = { outfile: "x", target: "bun-linux-x64" };
            expect({ ...base, ...out }).toStrictEqual(base);
        }
    });

    it("outside GitHub Actions → throws CI-only, even for a verified base", () => {
        const exe = verifiedBase();
        for (const gha of [undefined, "", "false", "1", "TRUE"]) {
            const env: Record<string, string | undefined> = {
                [BUN_BASE_EXE_ENV]: exe,
            };
            if (gha !== undefined) env.GITHUB_ACTIONS = gha;
            expect(() => bunBaseExeCompileOptions(env)).toThrow(/is CI-only/);
        }
    });

    it("a verified base → its absolute executablePath", () => {
        const exe = verifiedBase();
        expect(bunBaseExeCompileOptions(inCI(exe))).toEqual({
            executablePath: exe,
        });
    });

    it("accepts a bare-hex .sha256 as well as sha256sum format", () => {
        const exe = verifiedBase();
        writeFileSync(`${exe}.sha256`, sha256(readFileSync(exe)).toUpperCase());
        expect(bunBaseExeCompileOptions(inCI(exe)).executablePath).toBe(exe);
    });

    it("accepts sha256sum binary-mode (`*name`) and a trailing blank line", () => {
        const exe = verifiedBase();
        writeFileSync(`${exe}.sha256`, `${sha256(readFileSync(exe))} *bun\n\n`);
        expect(bunBaseExeCompileOptions(inCI(exe)).executablePath).toBe(exe);
    });

    const cases: Array<[string, () => string, RegExp]> = [
        ["set but empty", () => "", /set but empty/],
        ["whitespace only", () => "   ", /set but empty/],
        [
            "missing file",
            () => join(tmp("knext-bun-base-"), "nope"),
            /does not exist/,
        ],
        ["a directory", () => tmp("knext-bun-base-"), /not a regular file/],
        [
            "not executable",
            () => {
                const exe = verifiedBase();
                chmodSync(exe, 0o644);
                return exe;
            },
            /not executable/,
        ],
        [
            "missing .sha256",
            () => {
                const exe = verifiedBase();
                rmSync(`${exe}.sha256`);
                return exe;
            },
            /\.sha256 is missing/,
        ],
        [
            "malformed .sha256",
            () => {
                const exe = verifiedBase();
                writeFileSync(`${exe}.sha256`, "not-a-digest  bun\n");
                return exe;
            },
            /does not start with a sha256/,
        ],
        [
            "sha256 mismatch",
            () => {
                const exe = verifiedBase();
                writeFileSync(`${exe}.sha256`, `${"0".repeat(64)}  bun\n`);
                return exe;
            },
            /sha256 mismatch/,
        ],
        [
            ".sha256 names a different file",
            () => {
                const exe = verifiedBase();
                writeFileSync(
                    `${exe}.sha256`,
                    `${sha256(readFileSync(exe))}  bun-linux-aarch64-musl\n`,
                );
                return exe;
            },
            /names bun-linux-aarch64-musl, not bun/,
        ],
        [
            "multi-line .sha256 (a SHA256SUMS, not a per-file sum)",
            () => {
                const exe = verifiedBase();
                const h = sha256(readFileSync(exe));
                writeFileSync(`${exe}.sha256`, `${h}  bun\n${h}  other\n`);
                return exe;
            },
            /exactly one line, found 2/,
        ],
    ];
    for (const [name, value, message] of cases) {
        it(`${name} → throws`, () => {
            expect(() => bunBaseExeCompileOptions(inCI(value()))).toThrow(
                message,
            );
        });
    }
});

// ── 3. the real scripts, Bun.build stubbed ───────────────────────────────────

const STUB_MARK = "KNEXT_TEST_STUB_BUILD ";
const STUB_DONE = "KNEXT_TEST_STUB_DONE";

/**
 * The stub RECORDS EVERY `Bun.build` call and answers each shipped one with SUCCESS, writing an
 * outfile that passes the scripts' own bytecode proof (the entry marker from the call's banner under
 * a `// @bun @bytecode` pragma, plus a constant-pool copy; for a self-contained standalone build,
 * the route-chunk markers too). So the script runs PAST its `!result.success` exit to its last
 * line, and a second build anywhere after that exit — in the script or in a module it imports — is
 * recorded here (round 12, review-1469-r11 MEDIUM-1: a failing stub stopped the script at the exit,
 * and a seam-gated rebuild after it ran nowhere). `detectCompileInclude()` probe builds (not
 * shipped) still get a failed build, as before, so the probe reports inconclusive without running
 * a stub binary. A preload `beforeExit` hook prints STUB_DONE: the script reached its natural end.
 */
function stubPreload(): string {
    const p = join(tmp("knext-bun-base-stub-"), "stub.mjs");
    writeFileSync(
        p,
        `import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const PROBE = /[\\\\/]knext-include-detect-[^\\\\/]+[\\\\/]out-[A-Za-z]+[\\\\/]app$/;
process.on("beforeExit", () => console.log(${JSON.stringify(STUB_DONE)}));
Bun.build = async (o) => {
  const c = o == null ? null : o.compile === undefined ? null : o.compile;
  console.log(${JSON.stringify(STUB_MARK)} + JSON.stringify({ compile: c, naming: o != null && o.naming !== undefined }));
  const outfile = c && typeof c.outfile === "string" ? c.outfile : null;
  if (!outfile || PROBE.test(outfile)) return { success: false, logs: ["stub: probe build"], outputs: [] };
  const banner = String(o.banner ?? "");
  const m = /__knext(Vinext|Standalone)ExecMarker=("(?:[^"\\\\]|\\\\.)*")/.exec(banner);
  const marker = m ? JSON.parse(m[2]) : "";
  const markers = [marker];
  if (m && m[1] === "Standalone" && o.naming !== undefined)
    for (let n = 0; n < 64; n++) markers.push(marker + ":route:" + n + ":");
  const pool = markers.join("\\n") + "\\n" + " ".repeat(8192) + "\\n";
  const heads = markers.map((x) => "// @bun @bytecode @bun-cjs\\n" + x + "\\n").join("");
  mkdirSync(dirname(outfile), { recursive: true });
  writeFileSync(outfile, pool + heads);
  return { success: true, logs: [], outputs: [] };
};\n`,
    );
    return p;
}

function vinextFixture(): { argv: string[]; outfile: string } {
    const d = tmp("knext-bun-base-vinext-");
    const entry = join(d, ".output/server/index.mjs");
    write(entry, 'export default "ok";\n');
    write(join(d, ".output/public/favicon.txt"), "ok\n");
    const outfile = join(d, "exe");
    return {
        argv: [
            join(ADAPTERS, "vinext-compile.mjs"),
            "--entry",
            entry,
            "--outfile",
            outfile,
        ],
        outfile,
    };
}

function standaloneFixture(): { argv: string[]; outfile: string } {
    const d = tmp("knext-bun-base-standalone-");
    const s = join(d, ".next/standalone");
    write(
        join(s, "server.js"),
        `const path = require('path')

const dir = path.join(__dirname)

process.env.NODE_ENV = 'production'
process.chdir(__dirname)

const currentPort = parseInt(process.env.PORT, 10) || 3000
const nextConfig = {}

process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig)

require('next')
const { startServer } = require('next/dist/server/lib/start-server')

startServer({ dir, isDev: false, config: nextConfig, port: currentPort }).catch((err) => {
  console.error(err);
  process.exit(1);
});
`,
    );
    write(
        join(s, "node_modules/next/package.json"),
        '{"name":"next","version":"0.0.0","main":"index.js"}',
    );
    write(join(s, "node_modules/next/index.js"), "module.exports = {};");
    write(
        join(s, "node_modules/next/dist/server/lib/start-server.js"),
        "exports.startServer = async () => {};",
    );
    // A route chunk, so --self-contained has something to embed and prove bytecode on.
    write(join(s, ".next/server/app/page.js"), "module.exports = {};\n");
    const outfile = join(d, "exe");
    return {
        argv: [
            join(ADAPTERS, "standalone-compile.mjs"),
            "--server",
            join(s, "server.js"),
            "--outfile",
            outfile,
        ],
        outfile,
    };
}

/** A `detectCompileInclude()` probe build (compile-embed.mjs) — never a shipped executable. */
const isProbe = (c: unknown) =>
    !!c &&
    typeof c === "object" &&
    typeof (c as { outfile?: unknown }).outfile === "string" &&
    /[\\/]knext-include-detect-[^\\/]+[\\/]out-[A-Za-z]+[\\/]app$/.test(
        (c as { outfile: string }).outfile,
    );

function run(
    fx: { argv: string[]; outfile: string },
    base: string | undefined,
    gha = "true",
    extra: readonly string[] = [],
) {
    const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_ACTIONS: gha };
    delete env[BUN_BASE_EXE_ENV];
    if (base !== undefined) env[BUN_BASE_EXE_ENV] = base;
    const r = spawnSync(
        process.execPath,
        ["--preload", stubPreload(), ...fx.argv, ...extra],
        {
            env,
            encoding: "utf8",
            timeout: 180_000,
        },
    );
    const records = r.stdout
        .split("\n")
        .filter((l) => l.startsWith(STUB_MARK))
        .map(
            (l) =>
                JSON.parse(l.slice(STUB_MARK.length)) as {
                    compile: Record<string, unknown> | null;
                    naming: boolean;
                },
        );
    const calls = records.map((x) => x.compile);
    const shipped = calls.filter((c) => !isProbe(c));
    return {
        status: r.status,
        stderr: r.stderr,
        calls,
        shipped,
        /** Per shipped call: did it use the self-contained build shape (`naming` is set only there)? */
        shippedSelfContained: records
            .filter((x) => !isProbe(x.compile))
            .map((x) => x.naming),
        /** The one shipped compile — only when EVERY non-probe call is a compile of the requested outfile. */
        compile:
            shipped.length === 1 && shipped[0]?.outfile === fx.outfile
                ? shipped[0]
                : undefined,
        /** The script ran to its natural end (exit 0, the preload's beforeExit marker printed). */
        completed: r.status === 0 && r.stdout.includes(STUB_DONE),
    };
}

for (const [name, fixture] of [
    ["vinext-compile.mjs", vinextFixture],
    ["standalone-compile.mjs", standaloneFixture],
] as const) {
    for (const [mode, extra] of [
        ["default", [] as string[]],
        ["--self-contained", ["--self-contained", "1"]],
    ] as const) {
        describe(`${name} ${mode} — seam end to end (every Bun.build call recorded)`, () => {
            it("absent → exactly one shipped Bun.build, with no executablePath key", () => {
                const fx = fixture();
                const r = run(fx, undefined, "true", extra);
                // The WHOLE script ran (past its success check, to its last line), and still
                // made exactly one shipped build.
                expect({
                    shipped: r.shipped.length,
                    completed: r.completed,
                    stderr: r.completed ? "" : r.stderr,
                }).toEqual({
                    shipped: 1,
                    completed: true,
                    stderr: "",
                });
                expect(r.compile).toBeDefined();
                expect(Object.hasOwn(r.compile ?? {}, "executablePath")).toBe(
                    false,
                );
                // The leg really ran the mode it names (a flag the script ignored would test
                // the default build twice).
                expect(r.shippedSelfContained).toEqual([
                    mode === "--self-contained",
                ]);
            });

            it("a verified base → every shipped Bun.build gets it as compile.executablePath", () => {
                const fx = fixture();
                const exe = verifiedBase();
                const r = run(fx, exe, "true", extra);
                expect({
                    shipped: r.shipped.length,
                    completed: r.completed,
                    stderr: r.completed ? "" : r.stderr,
                }).toEqual({ shipped: 1, completed: true, stderr: "" });
                expect(r.shipped.map((c) => c?.executablePath)).toEqual([exe]);
                expect(r.compile?.executablePath).toBe(exe);
            });

            it("a bad base → exit 1 before any Bun.build, naming the variable", () => {
                const exe = verifiedBase();
                writeFileSync(`${exe}.sha256`, `${"0".repeat(64)}  bun\n`);
                const r = run(fixture(), exe, "true", extra);
                expect(r.status).toBe(1);
                expect(r.calls).toEqual([]);
                expect(r.stderr).toContain(
                    `${BUN_BASE_EXE_ENV}: sha256 mismatch`,
                );
            });

            it("a verified base outside GitHub Actions → exit 1, CI-only", () => {
                const r = run(fixture(), verifiedBase(), "false", extra);
                expect(r.status).toBe(1);
                expect(r.calls).toEqual([]);
                expect(r.stderr).toContain(`${BUN_BASE_EXE_ENV}: is CI-only`);
            });

            it("absent outside GitHub Actions → unaffected, reaches Bun.build", () => {
                const r = run(fixture(), undefined, "false", extra);
                expect(r.shipped.length).toBe(1);
                expect(
                    Object.hasOwn(
                        r.compile ?? { executablePath: 1 },
                        "executablePath",
                    ),
                ).toBe(false);
            });

            it("set but empty → exit 1 (no silent fallback to stock Bun)", () => {
                const r = run(fixture(), "", "true", extra);
                expect(r.status).toBe(1);
                expect(r.calls).toEqual([]);
            });
        });
    }
}

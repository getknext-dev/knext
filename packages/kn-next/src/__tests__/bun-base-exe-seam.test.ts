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
 *      Round 13 (review-1469-r12 MEDIUM-1): the round-12 literal-spread rule is
 *      replaced by a structural one. The seam value is a private frozen const
 *      in bun-base-exe.mjs, read only by `sealCompile()`; every `compile:` value
 *      is a direct `sealCompile(…)` call, and no other adapter module spells
 *      `executablePath` or a computed key outside a reviewed set.
 *      Round 14 (review-1469-r13): the scan covers the compile scripts' full static
 *      import closure, wherever it lives (checked against esbuild's bundle inputs),
 *      and reds any write to a global in it; `sealCompile()` uses only primordials
 *      captured at evaluation, and the seam module is each script's first import.
 *   2. The fail-closed table of `bunBaseExeCompileOptions()`, and `sealCompile()`
 *      refusing a foreign `executablePath` by every runtime route (own,
 *      inherited, non-enumerable, computed spelling, a lying Proxy).
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
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import {
    assertBunBaseExe,
    BUN_BASE_EXE_ENV,
    BunBaseExeError,
    bunBaseExeCompileOptions,
    sealBuild,
    sealCompile,
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
    /** Round 13: its value is a direct `sealCompile(…)` call — the only way to build a compile value. */
    sealed: boolean;
    /** The value's syntax kind, for the failure message. */
    valueKind: string;
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
    // ── round 13 (review-1469-r12 MEDIUM-1): the seam value is sealed in bun-base-exe.mjs ──
    /** Every identifier `sealCompile` (the import, each compile value's callee, and any other use). */
    sealRefs: number;
    /** Every identifier `sealBuild` (round 15: the import and each Bun.build call's callee). */
    sealBuildRefs: number;
    /** Per `Bun.build(...)` call, in order: is its single argument a direct `sealBuild(...)` call?
     *  (round 15, review-1469-r14 BLOCKER — the compile VALUE was sealed but nothing checked, at
     *  the `Bun.build` call, that the options still carried that exact value.) */
    buildArgSealed: boolean[];
    /** Every identifier `BUN_BASE_EXE` (the seam value — module-private to bun-base-exe.mjs). */
    seamRefs: number;
    /** Every identifier `bunBaseExeCompileOptions` (a compile script must not hold the raw value). */
    rawSeamRefs: number;
    /** A computed key that is not a string literal, as source text (for the adapters-wide rule). */
    computedKeyTexts: string[];
    /** `o[k]` READ with a key that is not a literal (`m[["bu", "ild"].join("")]` reaches build
     *  without spelling it — review-1469-r12 C1). Writes are in `computedWrites`. */
    computedReads: string[];
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
    const isSealCall = (e: ts.Expression) =>
        ts.isCallExpression(e) &&
        ts.isIdentifier(e.expression) &&
        e.expression.text === "sealCompile";
    const isSealBuildCall = (e: ts.Expression) =>
        ts.isCallExpression(e) &&
        ts.isIdentifier(e.expression) &&
        e.expression.text === "sealBuild";
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
        sealRefs: 0,
        sealBuildRefs: 0,
        buildArgSealed: [],
        seamRefs: 0,
        rawSeamRefs: 0,
        computedKeyTexts: [],
        computedReads: [],
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
            // Round 13 (review-1469-r12 C1): `import.meta.require(x)`, `module.require(x)` and
            // `createRequire(…)(x)` load a module just like `require(x)`.
            const isRequire =
                (ts.isIdentifier(n.expression) &&
                    n.expression.text === "require") ||
                (ts.isPropertyAccessExpression(n.expression) &&
                    n.expression.name.text === "require") ||
                (ts.isCallExpression(n.expression) &&
                    ts.isIdentifier(n.expression.expression) &&
                    n.expression.expression.text === "createRequire");
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
        if (ts.isComputedPropertyName(n) && !isLit(n.expression)) {
            out.computedKeys.push(lineOf(n));
            out.computedKeyTexts.push(n.getText(sf));
        }
        if (
            ts.isElementAccessExpression(n) &&
            !isLit(n.argumentExpression) &&
            !(
                ts.isBinaryExpression(n.parent) &&
                n.parent.left === n &&
                n.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
                n.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
            )
        )
            out.computedReads.push(n.getText(sf));
        if (ts.isIdentifier(n)) {
            if (n.text === "sealCompile") out.sealRefs++;
            if (n.text === "sealBuild") out.sealBuildRefs++;
            if (n.text === "BUN_BASE_EXE") out.seamRefs++;
            if (n.text === "bunBaseExeCompileOptions") out.rawSeamRefs++;
        }
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
            out.compiles.push({
                line: lineOf(n),
                sealed: isSealCall(v),
                valueKind: ts.SyntaxKind[v.kind],
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
            if (ts.isCallExpression(n.parent) && n.parent.expression === n) {
                out.buildCalls++;
                out.buildArgSealed.push(
                    n.parent.arguments.length === 1 &&
                        isSealBuildCall(n.parent.arguments[0]),
                );
            }
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
    "vinext-compile.mjs": 3, // sidecar + self-contained + compile.include (disk mode)
    "standalone-compile.mjs": 2, // base + self-contained
};

/**
 * Round 13 (review-1469-r12 MEDIUM-1): the seam lives in ONE module. `bun-base-exe.mjs` owns the
 * key and the value; every other adapter module (compile scripts, `compile-embed.mjs` — no
 * exemption — and everything else) must not spell `executablePath` at all, and must not use a
 * computed key outside this exact reviewed list (a computed key is how a key is spelled without
 * being written). Spellings the text ban cannot see (`"executable" + "Path"` in an
 * `Object.fromEntries`) are refused at RUNTIME by `sealCompile()`, which every compile value goes
 * through — the scan's job is to make "every compile value is a `sealCompile(…)` call" true.
 */
const SEAM_MODULES = new Set(["bun-base-exe.mjs", "bun-base-exe.d.mts"]);
const REVIEWED_COMPUTED_KEYS = new Set([
    "correlation-response.ts [CORRELATION_RESPONSE_INSTALLED]",
    "compile-embed.mjs [EMBED_PROBE_ENV]",
]);
/** Computed READS a compile script may make, exactly (round 13): argv parsing, the report tally and
 *  the embed plan's index. Any other `o[expr]` can reach `build` or `Bun` without spelling either. */
const REVIEWED_COMPUTED_READS = new Set([
    "argv[i]",
    "argv[i + 1]",
    "kinds[ext]",
    "plan.relpaths[i]",
]);
/** Every adapter module but the seam module that spells `executablePath` (anywhere in its text) or
 *  uses a computed key outside `REVIEWED_COMPUTED_KEYS`. */
function seamKeyOffenders(
    mods: ReadonlyArray<{ file: string; source: string; scan: ScriptScan }>,
): string[] {
    return mods
        .filter((m) => !SEAM_MODULES.has(m.file))
        .flatMap((m) => [
            ...(m.source.includes("executablePath")
                ? [`${m.file} spells executablePath`]
                : []),
            ...m.scan.computedKeyTexts
                .map((k) => `${m.file} ${k}`)
                .filter((k) => !REVIEWED_COMPUTED_KEYS.has(k)),
        ]);
}
/** The one import a compile script may take from the seam module, exactly. */
const SEAM_IMPORT =
    'import { assertBunBaseExe, sealBuild, sealCompile } from "./bun-base-exe.mjs";';

/**
 * The structure of `bun-base-exe.mjs` that makes the seam value unreachable from outside
 * `sealCompile`: `BUN_BASE_EXE` is declared exactly once, as a non-exported `const` initialised by
 * `Object.freeze(…)`, and every other reference sits inside `function sealCompile`.
 */
function seamModuleShape(source: string) {
    const sf = ts.createSourceFile(
        "bun-base-exe.mjs",
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
    );
    const decls: string[] = [];
    const outside: number[] = [];
    let inside = 0;
    const inSeal = (n: ts.Node): boolean => {
        for (let p: ts.Node | undefined = n.parent; p; p = p.parent)
            if (ts.isFunctionDeclaration(p) && p.name?.text === "sealCompile")
                return true;
        return false;
    };
    const visit = (n: ts.Node) => {
        if (ts.isIdentifier(n) && n.text === "BUN_BASE_EXE") {
            const d = n.parent;
            if (ts.isVariableDeclaration(d) && d.name === n) {
                const list = d.parent;
                const stmt = list.parent;
                const exported =
                    ts.isVariableStatement(stmt) &&
                    !!stmt.modifiers?.some(
                        (m) => m.kind === ts.SyntaxKind.ExportKeyword,
                    );
                const isConst =
                    ts.isVariableDeclarationList(list) &&
                    (list.flags & ts.NodeFlags.Const) !== 0;
                const frozen =
                    !!d.initializer &&
                    ts.isCallExpression(d.initializer) &&
                    d.initializer.expression.getText(sf) === "ObjectFreeze";
                decls.push(
                    `${isConst ? "const" : "mutable"} ${exported ? "exported" : "private"} ${frozen ? "frozen" : "unfrozen"}`,
                );
            } else if (inSeal(n)) inside++;
            else
                outside.push(
                    sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
                );
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return { decls, inside, outside };
}

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

/** Why a module that is NOT a compile script is an offender, or undefined: it references Bun.build
 *  (except the reviewed probe module), imports the "bun" module, or names `build` any other way. */
function nonCompileOffence(file: string, scan: ScriptScan) {
    const reviewed = NOT_A_COMPILE_SCRIPT_REVIEWED.has(file);
    const o = {
        file,
        buildRefs: reviewed ? 0 : scan.buildRefs,
        bunModule: scan.bunModule,
        buildNames: reviewed ? [] : scan.buildNames,
    };
    return o.buildRefs > 0 || o.bunModule.length > 0 || o.buildNames.length > 0
        ? o
        : undefined;
}

// ── round 14 (review-1469-r13 MEDIUM-2): the scan covers what the bundle covers ──

/** The compile scripts. `tsup.config.ts` makes each a bundle entry, so everything they import by a
 *  relative path is INLINED into `dist/adapters/<name>.js` — the file users' compiled builds run. */
const COMPILE_ENTRIES = ["vinext-compile.mjs", "standalone-compile.mjs"];
const JS_EXTS = [".mjs", ".js", ".cjs", ".ts", ".mts", ".cts"];

/** Every module specifier a file names with a literal: `import`/`export … from`, `import(…)`,
 *  `require(…)`, `x.require(…)` and `createRequire(…)(…)`. */
function moduleSpecifiers(file: string, source: string): string[] {
    const sf = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        /\.[mc]?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS,
    );
    const out: string[] = [];
    const visit = (n: ts.Node) => {
        if (
            (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
            n.moduleSpecifier &&
            ts.isStringLiteralLike(n.moduleSpecifier)
        )
            out.push(n.moduleSpecifier.text);
        if (
            ts.isCallExpression(n) &&
            n.arguments[0] &&
            ts.isStringLiteralLike(n.arguments[0]) &&
            (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(n.expression) &&
                    n.expression.text === "require") ||
                (ts.isPropertyAccessExpression(n.expression) &&
                    n.expression.name.text === "require") ||
                (ts.isCallExpression(n.expression) &&
                    ts.isIdentifier(n.expression.expression) &&
                    n.expression.expression.text === "createRequire"))
        )
            out.push(n.arguments[0].text);
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
}

/** A relative specifier as a bundler resolves it: the exact file, else with each JS/TS extension,
 *  else a directory's `index`. */
function resolveRelative(from: string, spec: string): string | undefined {
    const base = resolve(dirname(from), spec);
    const tries = [
        base,
        ...JS_EXTS.map((e) => base + e),
        ...JS_EXTS.map((e) => join(base, `index${e}`)),
    ];
    return tries.find((p) => existsSync(p) && statSync(p).isFile());
}

/**
 * The transitive static import closure of `roots`: every module a relative import reaches, at any
 * depth, in any directory, with any extension. `bare` is every non-relative specifier (a package
 * would be inlined unscanned, so the suite requires `node:` builtins only); `unresolved` is every
 * relative specifier that names no file (red — it cannot be scanned).
 */
function importClosure(roots: string[]): {
    files: string[];
    bare: string[];
    unresolved: string[];
} {
    const files: string[] = [];
    const bare = new Set<string>();
    const unresolved: string[] = [];
    const queue = [...roots];
    while (queue.length > 0) {
        const f = queue.shift() as string;
        if (files.includes(f)) continue;
        files.push(f);
        for (const spec of moduleSpecifiers(f, readFileSync(f, "utf8"))) {
            if (!spec.startsWith(".")) {
                bare.add(spec);
                continue;
            }
            const p = resolveRelative(f, spec);
            if (p === undefined) unresolved.push(`${f} → ${spec}`);
            else queue.push(p);
        }
    }
    return { files, bare: [...bare].sort(), unresolved };
}

/** Relative specifiers in source order (the first one is the first module whose body runs). */
function relativeImports(file: string, source: string): string[] {
    return moduleSpecifiers(file, source).filter((s) => s.startsWith("."));
}

/** Every global the runtime defines (scanned, not enumerated), plus the aliases of the global
 *  object. `undefined`, `NaN` and `Infinity` are read-only and are plain values in source. */
const GLOBAL_NAMES = new Set(
    [
        ...Object.getOwnPropertyNames(globalThis),
        "globalThis",
        "self",
        "global",
        "window",
    ].filter((n) => !["undefined", "NaN", "Infinity"].includes(n)),
);
/** `Object.*` / `Reflect.*` calls that write their first argument, and the legacy accessor writers. */
const PATCHING_METHODS = new Set([
    "defineProperty",
    "defineProperties",
    "setPrototypeOf",
    "assign",
    "set",
    "deleteProperty",
    "__defineGetter__",
    "__defineSetter__",
]);

/**
 * Round 14 (review-1469-r13 MEDIUM-1, H3/H3b/H3c): every write to a global in `source`: an
 * assignment (plain, compound, destructuring, `for…of`/`for…in` target), `++`/`--` or `delete`
 * whose target is rooted at a global name (`Object.freeze = …`, `globalThis.x = …`,
 * `Bun.build = …`, `process.env.X = …`) or passes through `.prototype`/`__proto__`
 * (`WeakSet.prototype.has = …`, `o.__proto__.x = …`); and an `Object.defineProperty`-family call
 * (or `x.__defineGetter__`) whose target is one. `sealCompile()` no longer looks anything up at
 * call time (primordials), so this rule is the belt to that braces: no module in the compile
 * closure patches the realm the compile runs in, however late.
 *
 * `serializedOnly` names functions whose body is never RUN in the compile process — it is
 * `.toString()`'d into the compiled output — so a patch inside one is skipped. The suite asserts
 * each such name is only ever used that way (`SERIALIZED_ONLY_REVIEWED`).
 */
function globalPatches(
    file: string,
    source: string,
    serializedOnly: ReadonlySet<string> = new Set(),
): string[] {
    const sf = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        /\.[mc]?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS,
    );
    const PROTO = ["prototype", "__proto__"];
    const isGlobalTarget = (e0: ts.Expression): boolean => {
        let e = e0;
        let proto = false;
        for (;;) {
            if (
                ts.isParenthesizedExpression(e) ||
                ts.isNonNullExpression(e) ||
                ts.isAsExpression(e)
            )
                e = e.expression;
            else if (ts.isPropertyAccessExpression(e)) {
                if (PROTO.includes(e.name.text)) proto = true;
                e = e.expression;
            } else if (ts.isElementAccessExpression(e)) {
                const a = e.argumentExpression;
                if (ts.isStringLiteralLike(a) && PROTO.includes(a.text))
                    proto = true;
                e = e.expression;
            } else if (ts.isCallExpression(e)) e = e.expression;
            else break;
        }
        return proto || (ts.isIdentifier(e) && GLOBAL_NAMES.has(e.text));
    };
    const targets = (e: ts.Expression): ts.Expression[] => {
        if (ts.isParenthesizedExpression(e)) return targets(e.expression);
        if (ts.isObjectLiteralExpression(e))
            return e.properties.flatMap((p) =>
                ts.isPropertyAssignment(p)
                    ? targets(p.initializer)
                    : ts.isShorthandPropertyAssignment(p)
                      ? [p.name]
                      : ts.isSpreadAssignment(p)
                        ? targets(p.expression)
                        : [],
            );
        if (ts.isArrayLiteralExpression(e))
            return e.elements.flatMap((x) =>
                ts.isOmittedExpression(x)
                    ? []
                    : ts.isSpreadElement(x)
                      ? targets(x.expression)
                      : targets(x),
            );
        if (
            ts.isBinaryExpression(e) &&
            e.operatorToken.kind === ts.SyntaxKind.EqualsToken
        )
            return targets(e.left);
        return [e];
    };
    const out: string[] = [];
    const hit = (n: ts.Node) =>
        out.push(
            `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${n.getText(sf)}`,
        );
    const visit = (n: ts.Node) => {
        let written: ts.Expression[] = [];
        if (
            ts.isBinaryExpression(n) &&
            n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        )
            written = targets(n.left);
        else if (
            (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
            (n.operator === ts.SyntaxKind.PlusPlusToken ||
                n.operator === ts.SyntaxKind.MinusMinusToken)
        )
            written = [n.operand];
        else if (ts.isDeleteExpression(n)) written = [n.expression];
        else if (
            (ts.isForOfStatement(n) || ts.isForInStatement(n)) &&
            !ts.isVariableDeclarationList(n.initializer)
        )
            written = targets(n.initializer);
        else if (
            ts.isCallExpression(n) &&
            ts.isPropertyAccessExpression(n.expression) &&
            PATCHING_METHODS.has(n.expression.name.text)
        ) {
            const callee = n.expression;
            const on = callee.expression;
            if (callee.name.text.startsWith("__define")) written = [on];
            else if (
                ts.isIdentifier(on) &&
                (on.text === "Object" || on.text === "Reflect") &&
                n.arguments[0]
            )
                written = [n.arguments[0]];
        }
        if (written.some(isGlobalTarget)) hit(n);
        if (
            !(
                ts.isFunctionDeclaration(n) &&
                n.name &&
                serializedOnly.has(n.name.text)
            )
        )
            ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
}

/** Functions that patch a global but are only ever serialised into the compiled executable's
 *  entry (`fn.toString()`), never run by the compile — each reviewed, per module. */
const SERIALIZED_ONLY_REVIEWED: Record<string, ReadonlySet<string>> = {
    // Module.prototype.require for embedded JSON on Bun 1.4.2 — runs inside the user's executable.
    "standalone-embed.mjs": new Set(["installEmbeddedJsonRequire"]),
};

/** Every use of `name` in `source` other than its declaration, an import/export specifier, or
 *  `name.toString()` — i.e. every place the compile process could RUN it. */
function serializedOnlyViolations(
    file: string,
    source: string,
    name: string,
): string[] {
    const sf = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
    );
    const out: string[] = [];
    const visit = (n: ts.Node) => {
        if (ts.isIdentifier(n) && n.text === name) {
            const p = n.parent;
            const ok =
                (ts.isFunctionDeclaration(p) && p.name === n) ||
                ts.isImportSpecifier(p) ||
                ts.isExportSpecifier(p) ||
                (ts.isPropertyAccessExpression(p) &&
                    p.expression === n &&
                    p.name.text === "toString" &&
                    ts.isCallExpression(p.parent) &&
                    p.parent.expression === p);
            if (!ok)
                out.push(
                    `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${p.getText(sf)}`,
                );
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
}

/**
 * Round 14: what `sealCompile`'s body looks up when it is CALLED. A method call (`x.y(…)`,
 * `x[k](…)`) resolves through a prototype a later patch can replace, and a global name
 * (`Object`, `WeakSet`, …) can be reassigned; the body must use only the primordials captured at
 * evaluation. Returns each offending expression's text.
 */
function sealLateLookups(source: string): string[] {
    const sf = ts.createSourceFile(
        "bun-base-exe.mjs",
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
    );
    const out: string[] = [];
    let bodies = 0;
    const inBody = (n: ts.Node) => {
        if (
            ts.isCallExpression(n) &&
            (ts.isPropertyAccessExpression(n.expression) ||
                ts.isElementAccessExpression(n.expression))
        )
            out.push(n.getText(sf));
        if (
            ts.isIdentifier(n) &&
            GLOBAL_NAMES.has(n.text) &&
            !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)
        )
            out.push(n.text);
        if (ts.isForOfStatement(n)) out.push("for…of (an iterator)");
        if (ts.isSpreadElement(n)) out.push("…spread (an iterator)");
        ts.forEachChild(n, inBody);
    };
    const visit = (n: ts.Node) => {
        if (
            ts.isFunctionDeclaration(n) &&
            n.name?.text === "sealCompile" &&
            n.body
        ) {
            bodies++;
            inBody(n.body);
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return bodies === 1 ? out : [`${bodies} sealCompile bodies`];
}

describe("KNEXT_BUN_BASE_EXE seam — scan", () => {
    // Round 14: every adapter module AND every module the compile scripts' bundles inline,
    // wherever it lives (review-1469-r13 H1: `src/zz-fast.mjs` was outside adapters/).
    const closure = importClosure(
        COMPILE_ENTRIES.map((f) => join(ADAPTERS, f)),
    );
    const all = [...new Set([...adapterModules(), ...closure.files])].map(
        (p) => {
            const file = relative(ADAPTERS, p);
            const source = readFileSync(p, "utf8");
            return { file, source, scan: scanScript(file, source) };
        },
    );
    const inClosure = all.filter((m) =>
        closure.files.includes(join(ADAPTERS, m.file)),
    );
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
            .map(({ file, scan }) => nonCompileOffence(file, scan))
            .filter((o) => o !== undefined);
        expect(offenders).toEqual([]);
    });

    it.each<[string, string, string]>([
        ["a Bun.build call", "m.js", "await Bun.build(o);"],
        ['the "bun" module', "m.ts", 'export const bun = await import("bun");'],
        [
            "a build reached through globalThis.Bun",
            "m.cjs",
            "const B = globalThis.Bun; B.build(o);",
        ],
        ["a destructured build", "m.mjs", "const { build } = globalThis.Bun;"],
    ])("a non-compile module is an offender on: %s", (_n, file, src) => {
        expect(nonCompileOffence(file, scanScript(file, src))).toBeDefined();
    });

    it("a non-compile module that only uses Bun.serve is not an offender", () => {
        expect(
            nonCompileOffence(
                "m.mjs",
                scanScript(
                    "m.mjs",
                    "const B = globalThis.Bun; B.serve({ fetch() {} });",
                ),
            ),
        ).toBeUndefined();
    });

    it("the module walk descends into subdirectories and skips __tests__", () => {
        const d = tmp("knext-bun-base-walk-");
        write(join(d, "a/b/deep.js"), "");
        write(join(d, "top.ts"), "");
        write(join(d, "__tests__/t.test.ts"), "");
        write(join(d, "notes.md"), "");
        expect(
            adapterModules(d)
                .map((p) => relative(d, p))
                .sort(),
        ).toEqual(["a/b/deep.js", "top.ts"]);
    });

    it("the reviewed computed writes and computed keys are each used (no stale entry)", () => {
        const writes = new Set(scripts.flatMap((s) => s.scan.computedWrites));
        const keys = new Set(
            all.flatMap((s) =>
                s.scan.computedKeyTexts.map((k) => `${s.file} ${k}`),
            ),
        );
        expect(
            [...REVIEWED_COMPUTED_WRITES].filter((x) => !writes.has(x)),
        ).toEqual([]);
        expect([...REVIEWED_COMPUTED_KEYS].filter((x) => !keys.has(x))).toEqual(
            [],
        );
        const reads = new Set(scripts.flatMap((s) => s.scan.computedReads));
        expect(
            [...REVIEWED_COMPUTED_READS].filter((x) => !reads.has(x)),
        ).toEqual([]);
    });

    // ── round 13 (review-1469-r12 MEDIUM-1, rows C4/C5/C7) ──
    it("C4/C5: BUN_BASE_EXE is one private frozen const, referenced only inside sealCompile", () => {
        const seam = all.find((s) => s.file === "bun-base-exe.mjs");
        expect(seam).toBeDefined();
        const shape = seamModuleShape(seam?.source ?? "");
        expect(shape.decls).toEqual(["const private frozen"]);
        expect(shape.outside).toEqual([]);
        expect(shape.inside).toBeGreaterThan(0);
        expect(seam?.source).not.toMatch(/export\s*\{[^}]*\bBUN_BASE_EXE\b/);
        // …and no other adapter module names it at all (a copy elsewhere is a second seam).
        expect(
            all
                .filter(
                    (s) => s.file !== "bun-base-exe.mjs" && s.scan.seamRefs > 0,
                )
                .map((s) => s.file),
        ).toEqual([]);
    });

    it("C7: no adapter module but the seam module spells executablePath, or a computed key outside the reviewed set", () => {
        expect(seamKeyOffenders(all)).toEqual([]);
    });

    it.each<[string, string, string, string[]]>([
        [
            "a literal executablePath key",
            "m.mjs",
            "const c = { executablePath: p };",
            ["m.mjs spells executablePath"],
        ],
        [
            "executablePath in a comment or string",
            "m.ts",
            '// "executablePath"',
            ["m.ts spells executablePath"],
        ],
        [
            "an unreviewed computed key",
            "m.js",
            "const c = { [k]: p };",
            ["m.js [k]"],
        ],
        [
            "the seam module itself is exempt",
            "bun-base-exe.mjs",
            "const c = { executablePath: p, [k]: 1 };",
            [],
        ],
    ])("the seam-key rule sees: %s", (_n, file, source, want) => {
        expect(
            seamKeyOffenders([
                { file, source, scan: scanScript(file, source) },
            ]),
        ).toEqual(want);
    });

    // ── round 14 (review-1469-r13 MEDIUM-1 / MEDIUM-2) ──
    it("the compile closure resolves every relative import, and imports nothing but node: builtins", () => {
        expect(closure.unresolved).toEqual([]);
        expect(closure.bare.filter((s) => !s.startsWith("node:"))).toEqual([]);
        // It reaches past the entries (a closure of just the two roots would scan nothing new).
        expect(closure.files.map((p) => relative(ADAPTERS, p)).sort()).toEqual(
            expect.arrayContaining([
                "bun-base-exe.mjs",
                "compile-embed.mjs",
                "sidecar-runtime.mjs",
                ...COMPILE_ENTRIES,
            ]),
        );
    });

    it("no module in the compile closure writes a global, a prototype, or defineProperty's one (H3/H3b/H3c)", () => {
        expect(
            inClosure.flatMap((m) =>
                globalPatches(
                    m.file,
                    m.source,
                    SERIALIZED_ONLY_REVIEWED[m.file],
                ),
            ),
        ).toEqual([]);
    });

    it("a serialized-only exemption is load-bearing, and its function is never run in the closure (only .toString()'d)", () => {
        for (const [file, names] of Object.entries(SERIALIZED_ONLY_REVIEWED)) {
            const m = inClosure.find((x) => x.file === file);
            expect(m).toBeDefined();
            // Without the exemption the rule sees the patch (not a stale entry).
            expect(globalPatches(file, m?.source ?? "").length).toBeGreaterThan(
                0,
            );
            for (const name of names)
                expect(
                    inClosure.flatMap((x) =>
                        serializedOnlyViolations(x.file, x.source, name),
                    ),
                ).toEqual([]);
        }
        expect(
            serializedOnlyViolations(
                "m.mjs",
                "import { f } from './x.mjs'; const s = '(' + f.toString() + ')()'; f(Module, fs, r);",
                "f",
            ),
        ).toEqual(["m.mjs:1 f(Module, fs, r)"]);
    });

    it("every closure module reaches Bun only as the literal `Bun.<name>` (no alias, no global object, no bun module, no computed specifier)", () => {
        expect(
            inClosure
                .map(({ file, scan }) => ({
                    file,
                    bunIndirect: scan.bunIndirect,
                    globalRefs: scan.globalRefs,
                    bunProp: scan.bunProp,
                    bunModule: scan.bunModule,
                    dynamicSpecifier: scan.dynamicSpecifier,
                }))
                .filter((o) =>
                    [
                        o.bunIndirect,
                        o.globalRefs,
                        o.bunProp,
                        o.bunModule,
                        o.dynamicSpecifier,
                    ].some((a) => a.length > 0),
                ),
        ).toEqual([]);
    });

    it("each compile script imports the seam module FIRST, and the seam module imports only node: builtins", () => {
        for (const f of COMPILE_ENTRIES) {
            const src = readFileSync(join(ADAPTERS, f), "utf8");
            expect({ f, first: relativeImports(f, src)[0] }).toEqual({
                f,
                first: "./bun-base-exe.mjs",
            });
        }
        const seamSrc = readFileSync(
            join(ADAPTERS, "bun-base-exe.mjs"),
            "utf8",
        );
        expect(
            moduleSpecifiers("bun-base-exe.mjs", seamSrc).filter(
                (s) => !s.startsWith("node:"),
            ),
        ).toEqual([]);
    });

    it("sealCompile's body looks nothing up at call time (primordials only; no method call, global or iterator)", () => {
        expect(
            sealLateLookups(
                readFileSync(join(ADAPTERS, "bun-base-exe.mjs"), "utf8"),
            ),
        ).toEqual([]);
    });

    it("esbuild (tsup's bundler) inlines exactly the scanned closure into each compile entry", async () => {
        const esbuild = await import("esbuild");
        for (const f of COMPILE_ENTRIES) {
            const entry = join(ADAPTERS, f);
            const r = await esbuild.build({
                entryPoints: [entry],
                bundle: true,
                platform: "node",
                format: "esm",
                write: false,
                metafile: true,
                logLevel: "silent",
                absWorkingDir: ADAPTERS,
            });
            const bundled = Object.keys(r.metafile.inputs)
                .map((p) => resolve(ADAPTERS, p))
                .sort();
            expect({ f, bundled }).toEqual({
                f,
                bundled: importClosure([entry]).files.sort(),
            });
        }
    });

    it.each<[string, string, string[]]>([
        [
            "H3: WeakSet.prototype.has = …",
            "WeakSet.prototype.has = () => true;",
            ["m.mjs:1 WeakSet.prototype.has = () => true"],
        ],
        [
            "Object.hasOwn = …",
            "Object.hasOwn = () => false;",
            ["m.mjs:1 Object.hasOwn = () => false"],
        ],
        [
            "H3c: Object.freeze = …",
            "Object.freeze = (o) => o;",
            ["m.mjs:1 Object.freeze = (o) => o"],
        ],
        [
            "globalThis.x = …",
            "globalThis.Bun = b;",
            ["m.mjs:1 globalThis.Bun = b"],
        ],
        [
            "Bun.build = … (a wrapper that adds a base)",
            "Bun.build = w;",
            ["m.mjs:1 Bun.build = w"],
        ],
        [
            'a computed write through ["prototype"]',
            'Array["prototype"][k] = f;',
            ['m.mjs:1 Array["prototype"][k] = f'],
        ],
        [
            "a local's __proto__",
            "o.__proto__.includes = f;",
            ["m.mjs:1 o.__proto__.includes = f"],
        ],
        [
            "a destructuring target",
            "[Object.keys] = [f];",
            ["m.mjs:1 [Object.keys] = [f]"],
        ],
        [
            "a compound assignment",
            "Object.x ??= f;",
            ["m.mjs:1 Object.x ??= f"],
        ],
        [
            "delete",
            "delete Object.prototype.x;",
            ["m.mjs:1 delete Object.prototype.x"],
        ],
        [
            "a for…of target",
            "for (Object.x of a);",
            ["m.mjs:1 for (Object.x of a);"],
        ],
        [
            "Object.defineProperty(Object, …)",
            'Object.defineProperty(Object, "hasOwn", { value: f });',
            ['m.mjs:1 Object.defineProperty(Object, "hasOwn", { value: f })'],
        ],
        [
            "Reflect.set(WeakSet.prototype, …)",
            'Reflect.set(WeakSet.prototype, "has", f);',
            ['m.mjs:1 Reflect.set(WeakSet.prototype, "has", f)'],
        ],
        [
            "Object.assign(Bun, …)",
            "Object.assign(Bun, o);",
            ["m.mjs:1 Object.assign(Bun, o)"],
        ],
        [
            "Object.setPrototypeOf(globalThis, …)",
            "Object.setPrototypeOf(globalThis, p);",
            ["m.mjs:1 Object.setPrototypeOf(globalThis, p)"],
        ],
        [
            "x.__defineGetter__ on a prototype",
            'Object.prototype.__defineGetter__("k", g);',
            ['m.mjs:1 Object.prototype.__defineGetter__("k", g)'],
        ],
        [
            "a local write is not a global patch",
            "let o = {}; o.x = 1; o.y += 2; delete o.x;",
            [],
        ],
        [
            "Object.assign into a local is not a global patch",
            "Object.assign(out, copy);",
            [],
        ],
        [
            "a read of a global is not a patch",
            "const k = Object.keys(o); const h = WeakSet.prototype.has;",
            [],
        ],
    ])("the global-patch rule sees: %s", (_n, src, want) => {
        expect(globalPatches("m.mjs", src)).toEqual(want);
    });

    it.each<[string, string, string[]]>([
        [
            "the primordial shape",
            "export function sealCompile(...parts) { for (let i = 0; i < parts.length; i++) ObjectAssign(out, parts[i]); return ObjectFreeze(out); }",
            [],
        ],
        [
            "G2: SEALED.has (a prototype lookup)",
            "export function sealCompile(p) { return SEALED.has(p); }",
            ["SEALED.has(p)"],
        ],
        [
            "Object.hasOwn (a global)",
            "export function sealCompile(o) { return ObjectHasOwn(o, k) || Object.hasOwn(o, k); }",
            ["Object.hasOwn(o, k)", "Object"],
        ],
        [
            "G3: Object.freeze",
            "export function sealCompile(o) { return Object.freeze(o); }",
            ["Object.freeze(o)", "Object"],
        ],
        [
            "a for…of over the parts",
            "export function sealCompile(...parts) { for (const p of parts) f(p); }",
            ["for…of (an iterator)"],
        ],
        [
            "an array spread",
            "export function sealCompile(...parts) { return f(...parts); }",
            ["…spread (an iterator)"],
        ],
        [
            "two sealCompile bodies",
            "export function sealCompile() {}\nfunction sealCompile() {}",
            ["2 sealCompile bodies"],
        ],
    ])("the late-lookup rule sees: %s", (_n, src, want) => {
        expect(sealLateLookups(src)).toEqual(want);
    });

    it("H1: a helper OUTSIDE adapters/, imported by a compile script, is in the closure and reds the Bun.build and key rules", () => {
        const d = tmp("knext-bun-base-h1-");
        write(
            join(d, "adapters/vinext-compile.mjs"),
            'import { assertBunBaseExe, sealCompile } from "./bun-base-exe.mjs";\nimport { fast } from "../zz-fast";\nif (process.env.FAST) await fast();\n',
        );
        write(join(d, "adapters/bun-base-exe.mjs"), "export {};\n");
        write(
            join(d, "zz-fast.mjs"),
            "export async function fast() { await Bun.build({ compile: { executablePath: process.env.FAST } }); }\n",
        );
        const c = importClosure([join(d, "adapters/vinext-compile.mjs")]);
        const mods = c.files.map((p) => {
            const file = relative(join(d, "adapters"), p);
            const source = readFileSync(p, "utf8");
            return { file, source, scan: scanScript(file, source) };
        });
        expect(mods.map((m) => m.file)).toContain("../zz-fast.mjs");
        const helper = mods.find((m) => m.file === "../zz-fast.mjs");
        expect(
            helper && nonCompileOffence(helper.file, helper.scan),
        ).toBeDefined();
        expect(seamKeyOffenders(mods)).toContain(
            "../zz-fast.mjs spells executablePath",
        );
    });

    it("H3: a helper outside adapters/ that patches an intrinsic reds the global-patch rule", () => {
        const d = tmp("knext-bun-base-h3-");
        write(
            join(d, "adapters/standalone-compile.mjs"),
            'import { sealCompile } from "./bun-base-exe.mjs";\nimport "../lib/patch.ts";\n',
        );
        write(join(d, "adapters/bun-base-exe.mjs"), "export {};\n");
        write(
            join(d, "lib/patch.ts"),
            "if (process.env.X) { WeakSet.prototype.has = () => true; Object.hasOwn = () => false; }\n",
        );
        const c = importClosure([join(d, "adapters/standalone-compile.mjs")]);
        expect(
            c.files.flatMap((p) =>
                globalPatches(relative(d, p), readFileSync(p, "utf8")),
            ),
        ).toEqual([
            "lib/patch.ts:1 WeakSet.prototype.has = () => true",
            "lib/patch.ts:1 Object.hasOwn = () => false",
        ]);
    });

    it("the closure walk: any extension, a directory index, a re-export, a require; an unresolved or bare import is reported", () => {
        const d = tmp("knext-bun-base-closure-");
        write(
            join(d, "a/root.mjs"),
            'import "./b";\nexport * from "../c/index.cts";\nconst m = require("./d.cjs");\nimport "pkg";\nimport "./missing";\n',
        );
        write(join(d, "a/b.ts"), 'import "../e";\n');
        write(join(d, "e/index.mts"), "");
        write(join(d, "c/index.cts"), "");
        write(join(d, "a/d.cjs"), "");
        const c = importClosure([join(d, "a/root.mjs")]);
        expect(c.files.map((p) => relative(d, p)).sort()).toEqual([
            "a/b.ts",
            "a/d.cjs",
            "a/root.mjs",
            "c/index.cts",
            "e/index.mts",
        ]);
        expect(c.bare).toEqual(["pkg"]);
        expect(c.unresolved).toEqual([`${join(d, "a/root.mjs")} → ./missing`]);
    });

    it("H3b: a patch placed IN a compile script reds the global-patch rule on the real script's text", () => {
        const src = readFileSync(join(ADAPTERS, "vinext-compile.mjs"), "utf8");
        const anchor = "assertBunBaseExe();";
        expect(src.split(anchor).length - 1).toBeGreaterThanOrEqual(1);
        const patched = src.replace(
            anchor,
            `${anchor}\nif (process.env.K) { WeakSet.prototype.has = () => true; Object.hasOwn = () => false; }`,
        );
        expect(globalPatches("vinext-compile.mjs", patched).length).toBe(2);
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
            it("reaches the seam only through assertBunBaseExe() and sealCompile() (never the raw value)", () => {
                expect(source).toContain(SEAM_IMPORT);
                expect(source).toMatch(/\bassertBunBaseExe\(\);/);
                expect({
                    seamRefs: scan.seamRefs,
                    rawSeamRefs: scan.rawSeamRefs,
                }).toEqual({ seamRefs: 0, rawSeamRefs: 0 });
            });

            it("calls Bun.build exactly once, directly (no second build, no alias)", () => {
                expect({
                    calls: scan.buildCalls,
                    refs: scan.buildRefs,
                    bunIndirect: scan.bunIndirect,
                }).toEqual({ calls: 1, refs: 1, bunIndirect: [] });
            });

            // Round 15 (review-1469-r14 BLOCKER): sealCompile sealed the compile VALUE, but nothing
            // checked, at the Bun.build call, that the options still carried that value — a helper
            // could overwrite opts.compile after sealing, or a spread placed after the compile: key
            // could displace it within the same literal, and every scan on the compile value alone
            // stayed green. sealBuild(...) is the backstop: it is the ONLY thing Bun.build may be
            // called with.
            it("Bun.build's single argument is a direct sealBuild(...) call (round 15)", () => {
                expect(scan.buildArgSealed).toEqual([true]);
            });

            it("sealBuild is used only as the import and the Bun.build call site (no alias, no shadow)", () => {
                expect(scan.sealBuildRefs).toBe(2);
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
                    computedReads: scan.computedReads.filter(
                        (r) => !REVIEWED_COMPUTED_READS.has(r),
                    ),
                }).toEqual({
                    computedReads: [],
                    bunModule: [],
                    dynamicSpecifier: [],
                    globalRefs: [],
                    bunProp: [],
                    buildNames: [],
                    computedKeys: [],
                    computedWrites: [],
                });
            });

            it("every compile value is a direct sealCompile(…) call, never a literal/identifier/member", () => {
                expect(scan.compiles.length).toBeGreaterThan(0);
                expect(
                    scan.compiles
                        .filter((c) => !c.sealed || c.execPath)
                        .map((c) => ({ line: c.line, valueKind: c.valueKind })),
                ).toEqual([]);
                expect({
                    shorthand: scan.shorthand,
                    writes: scan.writes,
                    compileStrings: scan.compileStrings,
                }).toEqual({ shorthand: [], writes: [], compileStrings: [] });
            });

            it("sealCompile is used only as the import and each compile value's callee (no alias, no shadow)", () => {
                expect(scan.sealRefs).toBe(scan.compiles.length + 1);
            });
        });
    }

    // The scanner itself, on inputs shaped like the round-10 bypasses: each must be seen.
    it.each<[string, string, (s: ScriptScan) => unknown, unknown]>([
        [
            "T4: compile: opts.compile (member)",
            "Bun.build({ compile: opts.compile });",
            (s) => s.compiles[0]?.sealed,
            false,
        ],
        [
            "compile: c (identifier)",
            "Bun.build({ compile: c });",
            (s) => s.compiles[0]?.sealed,
            false,
        ],
        [
            "compile: f() (a call that is not sealCompile)",
            "Bun.build({ compile: f() });",
            (s) => s.compiles[0]?.sealed,
            false,
        ],
        [
            "compile: o.sealCompile() (a member call, not the imported function)",
            "Bun.build({ compile: o.sealCompile({ outfile }) });",
            (s) => s.compiles[0]?.sealed,
            false,
        ],
        [
            "compile: a literal (round 12's shape, now unsealed)",
            "Bun.build({ compile: { outfile, ...BUN_BASE_EXE } });",
            (s) => ({ sealed: s.compiles[0]?.sealed, seamRefs: s.seamRefs }),
            { sealed: false, seamRefs: 1 },
        ],
        [
            "compile: sealCompile(…) (the one accepted shape)",
            "Bun.build({ compile: sealCompile({ outfile }) });",
            (s) => ({ sealed: s.compiles[0]?.sealed, sealRefs: s.sealRefs }),
            { sealed: true, sealRefs: 1 },
        ],
        [
            "an alias of sealCompile",
            "const seal = sealCompile; Bun.build({ compile: seal({ outfile }) });",
            (s) => ({ sealed: s.compiles[0]?.sealed, sealRefs: s.sealRefs }),
            { sealed: false, sealRefs: 1 },
        ],
        [
            "executablePath key inside sealCompile's arguments",
            "Bun.build({ compile: sealCompile({ executablePath: p }) });",
            (s) => s.compiles[0]?.execPath,
            true,
        ],
        [
            "the raw seam value in a compile script",
            "const x = bunBaseExeCompileOptions();",
            (s) => s.rawSeamRefs,
            1,
        ],
        [
            '"compile": quoted key',
            'Bun.build({ "compile": o.c });',
            (s) => s.compiles[0]?.sealed,
            false,
        ],
        [
            '["compile"]: computed key',
            'Bun.build({ ["compile"]: o.c });',
            (s) => s.compiles[0]?.sealed,
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
        // Round 15 (review-1469-r14 BLOCKER)
        [
            "Bun.build(sealBuild(o)) (the one accepted shape)",
            "Bun.build(sealBuild(o));",
            (s) => ({ arg: s.buildArgSealed, refs: s.sealBuildRefs }),
            { arg: [true], refs: 1 },
        ],
        [
            "Bun.build(o) — a bare argument, not sealBuild(...)",
            "Bun.build(o);",
            (s) => s.buildArgSealed,
            [false],
        ],
        [
            "Bun.build(o.sealBuild(o)) — a member call, not the imported function",
            "Bun.build(o.sealBuild(o));",
            (s) => s.buildArgSealed,
            [false],
        ],
        [
            "an alias of sealBuild",
            "const seal = sealBuild; Bun.build(seal(o));",
            (s) => ({ arg: s.buildArgSealed, refs: s.sealBuildRefs }),
            { arg: [false], refs: 1 },
        ],
        [
            "Bun.build(sealBuild(o), b) — a second argument alongside sealBuild(...)",
            "Bun.build(sealBuild(o), b);",
            (s) => s.buildArgSealed,
            [false],
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
            "a computed key's source text (for the adapters-wide reviewed set)",
            "const o = { [k]: 1 };",
            (s) => s.computedKeyTexts,
            ["[k]"],
        ],
        [
            "C1: import.meta.require with a computed specifier",
            'const m = import.meta.require(["b", "un"].join(""));',
            (s) => s.dynamicSpecifier.length,
            1,
        ],
        [
            "createRequire(u)(x) with a computed specifier",
            "const m = createRequire(import.meta.url)(x);",
            (s) => s.dynamicSpecifier.length,
            1,
        ],
        [
            "C1: a computed element read (reaches build without spelling it)",
            'await m[["bu", "ild"].join("")](o);',
            (s) => s.computedReads,
            ['m[["bu", "ild"].join("")]'],
        ],
        [
            "a computed write is not also a read",
            "o[k] = 1;",
            (s) => s.computedReads,
            [],
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

// ── 2b. sealCompile — the one way to build a compile value (round 13) ────────

describe("sealCompile — refuses a foreign executablePath by any route", () => {
    const key = ["executable", "Path"].join("");
    const refused: Array<[string, () => unknown]> = [
        ["an own literal key", () => ({ executablePath: "x" })],
        ["a computed spelling", () => Object.fromEntries([[key, "x"]])],
        [
            "an undefined value (the key itself is refused)",
            () => ({ [key]: undefined }),
        ],
        ["an inherited key", () => Object.create({ [key]: "x" })],
        [
            "an own non-enumerable key",
            () =>
                Object.defineProperty({}, key, {
                    value: "x",
                    enumerable: false,
                }),
        ],
        [
            "a Proxy that hides the key from ownKeys but answers `in`",
            () =>
                new Proxy(
                    {},
                    {
                        has: (_t, k) => k === key,
                        get: (_t, k) => (k === key ? "x" : undefined),
                    },
                ),
        ],
    ];
    // Shows the key only to the SECOND enumeration (the for…in), not to the copy or to `in`.
    refused.push([
        "a Proxy that shows the key only to a second enumeration (for…in)",
        () => {
            let n = 0;
            return new Proxy(
                {},
                {
                    ownKeys: (t) =>
                        n++ < 1
                            ? Reflect.ownKeys(t)
                            : [...Reflect.ownKeys(t), key],
                    getOwnPropertyDescriptor: (t, k) =>
                        k === key
                            ? {
                                  value: "x",
                                  enumerable: true,
                                  configurable: true,
                                  writable: true,
                              }
                            : Reflect.getOwnPropertyDescriptor(t, k),
                    has: () => false,
                },
            );
        },
    ]);
    for (const [name, part] of refused) {
        it(`${name} → throws`, () => {
            expect(() =>
                sealCompile(
                    { outfile: "o" },
                    part() as Record<string, unknown>,
                ),
            ).toThrow(/sealCompile: a compile part carries executablePath/);
        });
    }

    it('sealCompile({ executablePath: "x" }) throws (the round-13 acceptance row)', () => {
        expect(() => sealCompile({ executablePath: "x" })).toThrow(
            BunBaseExeError,
        );
    });

    it("a non-object part throws", () => {
        expect(() =>
            sealCompile("x" as unknown as Record<string, unknown>),
        ).toThrow(/must be an object/);
    });

    it("absent seam → a frozen, null-prototype merge of the parts, in order, with no executablePath", () => {
        assertBunBaseExe();
        const out = sealCompile({ outfile: "a", include: ["x"] }, undefined, {
            outfile: "b",
        });
        expect({ ...out }).toEqual({ outfile: "b", include: ["x"] });
        expect(Object.isFrozen(out)).toBe(true);
        expect(Object.getPrototypeOf(out)).toBeNull();
        expect(key in out).toBe(false);
        // A sealed value re-sealed with more fields is accepted (standalone's self-contained shape).
        expect({ ...sealCompile({ include: ["y"] }, out) }).toEqual({
            outfile: "b",
            include: ["x"],
        });
    });

    it("a Proxy cannot answer the check one way and the merge another (the checked copy is what merges)", () => {
        // Hides the key from the copy and the for…in (the first two ownKeys calls), then shows it to
        // anything that enumerates the ORIGINAL again — which the merge must never do.
        let n = 0;
        const flip = new Proxy(
            { outfile: "o" },
            {
                ownKeys: (t) =>
                    n++ < 2 ? Reflect.ownKeys(t) : [...Reflect.ownKeys(t), key],
                getOwnPropertyDescriptor: (t, k) =>
                    k === key
                        ? {
                              value: "x",
                              enumerable: true,
                              configurable: true,
                              writable: true,
                          }
                        : Reflect.getOwnPropertyDescriptor(t, k),
                get: (t, k) => (k === key ? "x" : Reflect.get(t, k)),
            },
        );
        const out = sealCompile(flip);
        expect({ ...out }).toEqual({ outfile: "o" });
        expect(key in out).toBe(false);
    });

    it("a verified seam is appended LAST, overriding nothing it did not own; a part carrying the SAME path still throws", () => {
        const exe = verifiedBase();
        const probe = join(tmp("knext-bun-base-seal-"), "probe.mjs");
        writeFileSync(
            probe,
            `import { sealCompile } from ${JSON.stringify(join(ADAPTERS, "bun-base-exe.mjs"))};
const a = sealCompile({ outfile: "a" }, { target: "t" });
const b = sealCompile({ include: ["i"] }, a);
let same = "no-throw";
try { sealCompile({ ${key}: ${JSON.stringify(exe)} }); } catch (e) { same = String(e.message); }
console.log(JSON.stringify({ a: Object.entries(a), b: Object.entries(b), same }));
`,
        );
        const r = spawnSync(process.execPath, [probe], {
            env: {
                ...process.env,
                GITHUB_ACTIONS: "true",
                [BUN_BASE_EXE_ENV]: exe,
            },
            encoding: "utf8",
        });
        expect(r.status).toBe(0);
        const got = JSON.parse(r.stdout.trim());
        expect(got.a).toEqual([
            ["outfile", "a"],
            ["target", "t"],
            [key, exe],
        ]);
        expect(got.b).toEqual([
            ["include", ["i"]],
            ["outfile", "a"],
            ["target", "t"],
            [key, exe],
        ]);
        expect(got.same).toMatch(/carries executablePath/);
    });

    it("G2/G3 (round 14): intrinsics patched AFTER import cannot make sealCompile accept a foreign base or leave its result writable", () => {
        const probe = join(tmp("knext-bun-base-g2-"), "probe.mjs");
        writeFileSync(
            probe,
            `import { sealCompile } from ${JSON.stringify(join(ADAPTERS, "bun-base-exe.mjs"))};
const key = ["executable", "Path"].join("");
const parts = [{ [key]: "/evil/bun" }, Object.fromEntries([[key, "/evil/bun"]]), Object.create({ [key]: "/evil/bun" })];
const good = { outfile: "o" };
const isFrozen = Object.isFrozen, entries = Object.entries, stringify = JSON.stringify, log = console.log;
WeakSet.prototype.has = () => true;
WeakSet.prototype.add = () => {};
Object.hasOwn = () => false;
Object.keys = () => [];
Object.freeze = (o) => o;
Object.assign = (t) => t;
Object.create = () => ({});
Reflect.ownKeys = () => [];
Array.prototype.includes = () => false;
Array.prototype[Symbol.iterator] = function* () {};
Function.prototype.call = function () { return true; };
const out = { refused: [] };
for (let i = 0; i < parts.length; i++) {
  try { sealCompile(parts[i]); out.refused.push("no-throw"); } catch (e) { out.refused.push(String(e.message).includes("carries " + key)); }
}
const s = sealCompile(good);
out.frozen = isFrozen(s);
try { s[key] = "/evil/bun"; out.write = "no-throw"; } catch (e) { out.write = e instanceof TypeError; }
out.entries = entries(s);
log(stringify(out));
`,
        );
        // The seam is ABSENT — every user's build — which is where G2 leaked a foreign base.
        const env = { ...process.env };
        delete env[BUN_BASE_EXE_ENV];
        const r = spawnSync(process.execPath, [probe], {
            env,
            encoding: "utf8",
        });
        expect(r.stderr).toBe("");
        expect(JSON.parse(r.stdout.trim())).toEqual({
            refused: [true, true, true],
            frozen: true,
            write: true,
            entries: [["outfile", "o"]],
        });
    });

    it("a bad seam → assertBunBaseExe() and sealCompile() both throw it (no fall back to stock Bun)", () => {
        const exe = verifiedBase();
        writeFileSync(`${exe}.sha256`, `${"0".repeat(64)}  bun\n`);
        const probe = join(tmp("knext-bun-base-seal-"), "probe.mjs");
        writeFileSync(
            probe,
            `import { assertBunBaseExe, sealCompile } from ${JSON.stringify(join(ADAPTERS, "bun-base-exe.mjs"))};
const out = [];
for (const f of [() => assertBunBaseExe(), () => sealCompile({ outfile: "a" })]) {
  try { f(); out.push("no-throw"); } catch (e) { out.push(String(e.message)); }
}
console.log(JSON.stringify(out));
`,
        );
        const r = spawnSync(process.execPath, [probe], {
            env: {
                ...process.env,
                GITHUB_ACTIONS: "true",
                [BUN_BASE_EXE_ENV]: exe,
            },
            encoding: "utf8",
        });
        expect(r.status).toBe(0);
        const got = JSON.parse(r.stdout.trim()) as string[];
        expect(got).toHaveLength(2);
        for (const m of got)
            expect(m).toContain(`${BUN_BASE_EXE_ENV}: sha256 mismatch`);
    });

    it.each<[string, string, string[]]>([
        [
            "the shipped shape",
            "const BUN_BASE_EXE = ObjectFreeze({});\nexport function sealCompile() { return BUN_BASE_EXE; }",
            ["const private frozen"],
        ],
        [
            "C5: a mutable binding",
            "let BUN_BASE_EXE = ObjectFreeze({});\nexport function sealCompile() { return BUN_BASE_EXE; }",
            ["mutable private frozen"],
        ],
        [
            "an exported binding",
            "export const BUN_BASE_EXE = ObjectFreeze({});\nexport function sealCompile() { return BUN_BASE_EXE; }",
            ["const exported frozen"],
        ],
        [
            "an unfrozen value",
            "const BUN_BASE_EXE = {};\nexport function sealCompile() { return BUN_BASE_EXE; }",
            ["const private unfrozen"],
        ],
        [
            "Object.freeze looked up at evaluation, not the captured primordial",
            "const BUN_BASE_EXE = Object.freeze({});\nexport function sealCompile() { return BUN_BASE_EXE; }",
            ["const private unfrozen"],
        ],
    ])("the seam-module shape sees: %s", (_n, src, want) => {
        expect(seamModuleShape(src).decls).toEqual(want);
    });

    it("the seam-module shape sees C4: a reference outside sealCompile", () => {
        const src =
            "const BUN_BASE_EXE = ObjectFreeze({});\nObject.assign(BUN_BASE_EXE, {});\nexport function sealCompile() { return BUN_BASE_EXE; }";
        expect(seamModuleShape(src)).toEqual({
            decls: ["const private frozen"],
            inside: 1,
            outside: [2],
        });
    });
});

// ── 2c. sealBuild — the one way to build the OPTIONS Bun.build receives (round 15) ────────
//
// review-1469-r14 BLOCKER: sealCompile() sealed the `compile` VALUE, but nothing checked, at the
// `Bun.build` call, that the options handed to it still carried that exact value. A helper in the
// compile scripts' import closure could overwrite `opts.compile` after sealing (X1, a member write;
// X1c, the same through `Object.assign`), or a spread placed AFTER the `compile:` key in the same
// object literal could displace it before the literal was ever built (X2) — every scan on the
// `compile` value alone (round 13/14) stayed green in all three cases, and CI was green while the
// shipped `Bun.build` received an attacker-chosen `executablePath`.
//
// `sealBuild(opts)` is the backstop: it is the ONLY thing the two compile scripts may pass to
// `Bun.build`, and it throws unless `opts.compile` is the exact object `sealCompile()` returned —
// checked by `SEALED` WeakSet membership (the same primordial `sealCompile` itself uses), never by
// re-inspecting the object's shape. All three round-14 leaks replace the reference outright, so
// none of them can pass.
describe("sealBuild — the compile-options gate (round 15, review-1469-r14 BLOCKER)", () => {
    it("returns a frozen, null-prototype copy when opts.compile is exactly what sealCompile returned", () => {
        const compile = sealCompile({ outfile: "x" });
        const out = sealBuild({ entrypoints: ["a"], compile });
        expect(out.compile).toBe(compile);
        expect(Object.isFrozen(out)).toBe(true);
        expect(Object.getPrototypeOf(out)).toBeNull();
        expect(out).toEqual({ entrypoints: ["a"], compile });
    });

    it("re-sealing compile through sealCompile again (the self-contained re-seal) still passes", () => {
        const inner = sealCompile({ outfile: "x" });
        const resealed = sealCompile(inner);
        const out = sealBuild({ entrypoints: ["a"], compile: resealed });
        expect(out.compile).toBe(resealed);
    });

    it("throws (naming the constraint) when opts.compile carries its own executablePath, never sealed", () => {
        expect(() => sealBuild({ compile: { executablePath: "x" } })).toThrow(
            BunBaseExeError,
        );
        expect(() => sealBuild({ compile: { executablePath: "x" } })).toThrow(
            /sealBuild: opts\.compile must be the exact object sealCompile\(\.\.\.\) returned/,
        );
    });

    it("throws when opts.compile is a JSON.parse'd plain object shaped exactly like a sealed one", () => {
        const compile = sealCompile({ outfile: "x" });
        // A forged object with the identical own keys/values — but never passed through
        // sealCompile, so it is not a member of the SEALED WeakSet.
        const forged = JSON.parse(JSON.stringify(compile));
        expect(() => sealBuild({ compile: forged })).toThrow(BunBaseExeError);
    });

    it("throws when opts.compile is missing, undefined, null, or a primitive", () => {
        for (const bad of [
            {},
            { compile: undefined },
            { compile: null },
            { compile: "x" },
            { compile: 1 },
        ]) {
            expect(() => sealBuild(bad as Record<string, unknown>)).toThrow(
                BunBaseExeError,
            );
        }
    });

    it("does not mutate or re-freeze the original opts object (a shallow copy, not the same reference)", () => {
        const compile = sealCompile({ outfile: "x" });
        const opts = { entrypoints: ["a"], compile };
        const out = sealBuild(opts);
        expect(out).not.toBe(opts);
        expect(Object.isFrozen(opts)).toBe(false);
    });

    // The three round-14 leak shapes, reproduced exactly (r14rev/x.json rows X1, X1c, X2): each
    // builds the corrupted `opts` a mutated compile script would have handed to `Bun.build`, and
    // `sealBuild` must reject every one of them — red by its own row name if it does not.
    it.each<[string, () => Record<string, unknown>]>([
        [
            "X1: compile-embed's tuneOptions(o) does o.compile = JSON.parse(escaped executablePath) before Bun.build",
            () => {
                const compile = sealCompile({ outfile: "x" });
                const o: Record<string, unknown> = {
                    entrypoints: ["a"],
                    compile,
                };
                // Exactly the round-14 mutation shape: a JSON.parse'd, unicode-escaped key.
                o.compile = JSON.parse(
                    `{"outfile":"x","executable\\u0050ath":"/evil/bun"}`,
                );
                return o;
            },
        ],
        [
            "X1c: the same leak through Object.assign(o, { compile: JSON.parse(...) }) — no member write",
            () => {
                const compile = sealCompile({ outfile: "x" });
                const o: Record<string, unknown> = {
                    entrypoints: ["a"],
                    compile,
                };
                Object.assign(o, {
                    compile: JSON.parse(
                        `{"outfile":"x","executable\\u0050ath":"/evil/bun"}`,
                    ),
                });
                return o;
            },
        ],
        [
            "X2: vinext spreads ...extraOpts() AFTER the compile: sealCompile(...) key in the same literal",
            () => {
                const extraOpts = () =>
                    JSON.parse(
                        `{"compile":{"outfile":"x","executable\\u0050ath":"/evil/bun"}}`,
                    );
                return {
                    entrypoints: ["a"],
                    compile: sealCompile({ outfile: "x" }),
                    ...extraOpts(),
                };
            },
        ],
    ])("rejects the round-14 leak shape: %s", (_name, build) => {
        expect(() => sealBuild(build())).toThrow(BunBaseExeError);
    });
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

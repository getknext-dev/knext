/**
 * The compiled vinext single executable must BUNDLE every package the nitro
 * entry loads through its `createRequire(import.meta.url)` helper (#1309).
 *
 * Root cause (measured on linux, Bun 1.4.0, PR #1311): vinext 1.0.0-beta.11
 * auto-adds every `@opentelemetry/*` dependency of the app's package.json to
 * `serverExternalPackages` (`dist/config/server-external-packages.js`,
 * `findOpenTelemetryPackages`). The file-manager app depends on
 * `@opentelemetry/api`, so nitro now leaves it EXTERNAL — and prom-client, which
 * is bundled as CJS, reaches it as
 *     `__require(\`@opentelemetry/api\`)` with `__require = createRequire(import.meta.url)`.
 * `Bun.build` only follows STATIC import/require specifiers, so that call is
 * invisible to it: the compiled binary never embeds `@opentelemetry/api` and
 * every request 500s with `Cannot find module '@opentelemetry/api' from
 * '<app>/.output/server/index.mjs'`. The compat fixtures have no OTel
 * dependency, which is why the compat lane stayed green on the same branch.
 *
 * The fix rewrites those literal, resolvable, bare, non-builtin calls into
 * static `require("<spec>")`, which `Bun.build` bundles.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
    analyzeServerModule,
    wrapRequireBindings,
} from "../adapters/entry-require-staticize.mjs";

const COMPILE = resolve(import.meta.dir, "../adapters/vinext-compile.mjs");

// Verbatim rolldown 1.2.6 shapes (see vinext-compile-chunk-requires.test.ts,
// which regenerates them with the real bundler end to end).
const ROLLDOWN_PLAIN =
    'import { createRequire } from "node:module";\n' +
    "var __require = /* #__PURE__ */ (() => createRequire(import.meta.url))();\n" +
    'var x = () => __require("@opentelemetry/api");\n';
const ROLLDOWN_MIN =
    'import{createRequire as e}from"node:module";var u=/* @__PURE__ */ e(import.meta.url);var x=()=>u(`@opentelemetry/api`);';
const ROLLDOWN_RUNTIME =
    'import{createRequire as e}from"node:module";var s=1,u=/* @__PURE__ */ e(import.meta.url);export{u as n,s as t};';
const ROLLDOWN_CONSUMER =
    'import{n as e,t as n}from"./rolldown-runtime.mjs";var r=()=>e(`chunk-dep`);export{r as default};';

describe("analyzeServerModule (unit)", () => {
    it("finds rolldown's IIFE require binding and its literal calls", () => {
        const a = analyzeServerModule(ROLLDOWN_PLAIN);
        expect(a.aliases).toEqual(["createRequire"]);
        expect(a.requireBindings).toEqual(["__require"]);
        expect([...(a.literalCalls.get("__require") ?? [])]).toEqual([
            "@opentelemetry/api",
        ]);
        expect(a.unrecognizedBinding).toBe(false);
    });

    it("finds the minified binding through the createRequire import alias", () => {
        const a = analyzeServerModule(ROLLDOWN_MIN);
        expect(a.aliases).toEqual(["e"]);
        expect(a.requireBindings).toEqual(["u"]);
        expect([...(a.literalCalls.get("u") ?? [])]).toEqual([
            "@opentelemetry/api",
        ]);
    });

    it("maps a hoisted binding's export and a consumer chunk's import alias", () => {
        const runtime = analyzeServerModule(ROLLDOWN_RUNTIME);
        expect(runtime.requireBindings).toEqual(["u"]);
        expect(runtime.exports.get("u")).toEqual(["n"]);
        const consumer = analyzeServerModule(ROLLDOWN_CONSUMER);
        expect(consumer.imports).toEqual([
            {
                from: "./rolldown-runtime.mjs",
                names: new Map([
                    ["n", "e"],
                    ["t", "n"],
                ]),
            },
        ]);
        expect([...(consumer.literalCalls.get("e") ?? [])]).toEqual([
            "chunk-dep",
        ]);
    });

    it("keeps the older direct form (`X = createRequire(import.meta.url)`) and any quote style", () => {
        const a = analyzeServerModule(
            'import { createRequire as createRequire$1 } from "module";\n' +
                "const req = createRequire$1(import.meta.url);\nreq('pkg-a'); req(\"@scope/pkg-b/sub\");",
        );
        expect(a.requireBindings).toEqual(["req"]);
        expect([...(a.literalCalls.get("req") ?? [])].sort()).toEqual([
            "@scope/pkg-b/sub",
            "pkg-a",
        ]);
    });

    it("ignores builtins, dynamic and interpolated specifiers, and member calls", () => {
        const a = analyzeServerModule(
            'import{createRequire}from"node:module";var r=createRequire(import.meta.url);' +
                // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal JS source under test, not a template
                "r(`util`);r(`node:fs`);r(name);r(`a-${b}`);o.r(`pkg`);",
        );
        expect(a.literalCalls.size).toBe(0);
    });

    it("counts declarations of a name (var list, function, parameters, catch), so a reused require name reads as ambiguous", () => {
        const a = analyzeServerModule(
            'import{createRequire as e}from"node:module";var t=1,u=e(import.meta.url);' +
                "function u(e,r){}var f=(u,x)=>u(x);var g=u=>u;try{}catch(u){}" +
                "var o={m(u){return u(1)}};",
        );
        expect(a.requireBindings).toEqual(["u"]);
        // binding + function + 2 arrow params + catch + method param
        expect(a.declarationCounts.get("u")).toBeGreaterThanOrEqual(6);
        expect(a.nonLiteralCallees.has("u")).toBe(true);
        // a name declared only as the binding stays unambiguous
        const b = analyzeServerModule(ROLLDOWN_MIN);
        expect(b.declarationCounts.get("u")).toBe(1);
    });

    it("counts function DECLARATIONS but not named function EXPRESSIONS (esbuild's __commonJS helper)", () => {
        const decl = (src: string, id: string) =>
            analyzeServerModule(src).declarationCounts.get(id) ?? 0;
        // expressions: after =>, =, (, ,, ?, :, return
        expect(decl("var c=(cb,mod)=>function u(){return 1};", "u")).toBe(0);
        expect(decl("var c=function u(){};", "u")).toBe(0);
        expect(decl("f(function u(){});g(1,function u(){});", "u")).toBe(0);
        expect(decl("var c=x?function u(){}:function u(){};", "u")).toBe(0);
        expect(decl("function g(){return function u(){}}", "u")).toBe(0);
        // declarations: file start, after ; { }, export / default / async, comments
        expect(decl("function u(){}", "u")).toBe(1);
        expect(decl("x=1;function u(){}", "u")).toBe(1);
        expect(decl("{function u(){}}", "u")).toBe(1);
        expect(decl("export function u(){}", "u")).toBe(1);
        expect(decl("export default async function u(){}", "u")).toBe(1);
        expect(decl("x=1;/* c */ function u(){}", "u")).toBe(1);
    });

    describe("only a positively identified function/method HEAD is not a call (#1384 round 5)", () => {
        const flagged = (src: string) =>
            analyzeServerModule(
                'import{createRequire}from"node:module";var __require=createRequire(import.meta.url);' +
                    src,
            ).nonLiteralCallees.has("__require");
        it("a call after `extends` is a call", () => {
            expect(flagged("class X extends __require(n) {}")).toBe(true);
        });
        it("a call followed by a block on the NEXT line (ASI) is a call", () => {
            expect(flagged("x=1;\n__require(n)\n{ y(); }")).toBe(true);
        });
        it("a string argument containing `) {` does not make a call a head", () => {
            expect(flagged('x=1;__require("a) {");')).toBe(true);
        });
        it("a call in expression position is a call", () => {
            expect(flagged("x=__require(n);")).toBe(true);
        });
        it("function, generator, method, object-method and getter heads are not calls", () => {
            expect(
                flagged("var c=(cb,mod)=>function __require() {return 1};"),
            ).toBe(false);
            expect(flagged("var g=function* __require(){};")).toBe(false);
            expect(flagged("class K { __require() { return 1; } }")).toBe(
                false,
            );
            expect(
                flagged("var o = { a: 1, __require(x) { return x; } };"),
            ).toBe(false);
            expect(flagged("var o = { get __require() { return 1; } };")).toBe(
                false,
            );
        });
        it("heads whose parameters hold nested parens are still heads", () => {
            expect(flagged("function __require(a = g()) { }")).toBe(false);
            expect(flagged("var o = { __require(a = g(1)) { } };")).toBe(false);
        });
        it("a function head is a head even with its `{` on the next line", () => {
            expect(flagged("var c=function __require()\n{return 1};")).toBe(
                false,
            );
            expect(flagged("var g=function* __require()\n{};")).toBe(false);
        });
        it("a class member after another member's `}` is a head", () => {
            expect(flagged("class K{a(){}__require(n){return n}}")).toBe(false);
        });
        it("a same-line comment between a method's `)` and `{` keeps it a head", () => {
            expect(
                flagged("class K { __require(x) /* c */ { return x; } }"),
            ).toBe(false);
        });
        it("a call in an if/while/for condition followed by a block stays a call", () => {
            expect(flagged("if (__require(n)) { y(); }")).toBe(true);
            expect(flagged("while (__require(n)) { y(); }")).toBe(true);
            expect(flagged("for (;__require(n);) { y(); }")).toBe(true);
            expect(flagged("if(__require(n)){y()}")).toBe(true);
        });
        it("a quote inside a regex literal in the argument list cannot pair with a later string's `) {`", () => {
            expect(
                flagged(`x=[0,__require(n.replace(/'/g,""))];a('x');b(')) {')`),
            ).toBe(true);
        });
        it("a quote inside a comment in the argument list cannot pair with a later string's `) {`", () => {
            expect(
                flagged(`x = [0, __require(n /* it's */)]; a('x'); b(') {')`),
            ).toBe(true);
        });
        it("a quote inside a template's `${…}` cannot close the template early and pair with a later `) {` (#1384 round 8)", () => {
            // Real rolldown 1.2.6 output for `require(n + `${c ? "`" : ""}`)`.
            expect(
                flagged(
                    'x = f(0, __require(n + `${c ? "`" : ""}`), String(") {"));',
                ),
            ).toBe(true);
        });
        it("an escaped quote inside a string argument does not end the string early and pair with a later `) {` (#1384 round 9)", () => {
            // Without the escape-skip in skipStringLiteral, the string
            // `"\") {"` is (mis)read as closing right after the escaped
            // quote, so the remaining `) {` on the same line pairs with the
            // call's own `(` and misidentifies this call as a head — hiding
            // a dynamic require instead of flagging it.
            expect(flagged('x = [0, __require(n + "\\") {")];')).toBe(true);
        });
        it("a `${` in a real method's parameter list makes it a call (fail safe)", () => {
            expect(
                flagged("class K { __require(a = `${b}`) { return a; } }"),
            ).toBe(true);
        });
        it("a `/` in a real method's parameter list makes it a call (fail safe)", () => {
            expect(
                flagged("class K { __require(a = 1 / 2) { return a; } }"),
            ).toBe(true);
        });
    });

    it("one comment cannot span code into the next: `/* a */ n /* b */` hides no argument", () => {
        const a = analyzeServerModule(
            'import{createRequire}from"node:module";var __require=createRequire(import.meta.url);' +
                'x=__require(/* a */ n /* b */ "pkg");',
        );
        expect(a.nonLiteralCallees.has("__require")).toBe(true);
    });

    it("flags a createRequire(import.meta.url) call it cannot attribute to a binding", () => {
        const a = analyzeServerModule(
            'import{createRequire as e}from"node:module";use(e(import.meta.url));',
        );
        expect(a.unrecognizedBinding).toBe(true);
    });

    it("does not treat a createRequire anchored anywhere but import.meta.url as a require binding (sharp's own loader)", () => {
        const a = analyzeServerModule(
            'import{createRequire as e}from"node:module";let Rh=e(join(p,`x`));Rh(`sharp`);',
        );
        expect(a.requireBindings).toEqual([]);
        expect(a.unrecognizedBinding).toBe(false);
    });
});

describe("wrapRequireBindings (unit)", () => {
    it("wraps only the binding expression, embedding the given specifiers as static requires", () => {
        const out = wrapRequireBindings(
            ROLLDOWN_MIN,
            ["e"],
            ["@opentelemetry/api"],
        );
        expect(out.count).toBe(1);
        expect(out.contents).toContain(
            'case "@opentelemetry/api":return require("@opentelemetry/api");',
        );
        // the call site is untouched: callers of any name get the embedded copy
        expect(out.contents).toContain("var x=()=>u(`@opentelemetry/api`);");
        // the original require is the fallback for everything else
        expect(out.contents).toContain("return __knextBase(__knextSpec)");
        expect(out.contents).toContain("(e(import.meta.url))");
    });

    it("is a no-op with no aliases or nothing to embed", () => {
        expect(wrapRequireBindings(ROLLDOWN_MIN, [], ["x"]).contents).toBe(
            ROLLDOWN_MIN,
        );
        expect(wrapRequireBindings(ROLLDOWN_MIN, ["e"], []).contents).toBe(
            ROLLDOWN_MIN,
        );
    });

    it("does not touch a same-named member call or a longer identifier", () => {
        const src = "o.e(import.meta.url);ee(import.meta.url);";
        expect(wrapRequireBindings(src, ["e"], ["pkg"]).count).toBe(0);
    });
});

// ── the regression, end to end: compile a nitro-shaped entry and prove the
// externalised package is INSIDE the binary and works with no node_modules.
const MARKER = "KNEXT_1309_BUNDLED_MARKER_7f3a91";
// realpath: macOS tmpdir is a /var -> /private/var symlink, and vinext-compile
// matches its entry by resolved path.
const work = realpathSync(mkdtempSync(join(tmpdir(), "knext-1309-")));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("vinext-compile bundles the entry's createRequire(import.meta.url) packages (#1309)", () => {
    it("the compiled exec embeds and loads an externalised package with .output/server/node_modules gone", () => {
        const server = join(work, ".output", "server");
        const pkg = join(server, "node_modules", "fake-otel-api");
        mkdirSync(pkg, { recursive: true });
        writeFileSync(
            join(pkg, "package.json"),
            JSON.stringify({
                name: "fake-otel-api",
                version: "1.0.0",
                main: "index.js",
            }),
        );
        writeFileSync(
            join(pkg, "index.js"),
            `module.exports = { marker: ${JSON.stringify(MARKER)} };`,
        );
        // The exact shape nitro/rolldown emits for a CJS dependency reaching an
        // external: a module-scope `__require` bound to the entry's location.
        writeFileSync(
            join(server, "index.mjs"),
            'import { createRequire } from "node:module";\n' +
                "var __require = createRequire(import.meta.url);\n" +
                "var Bh = __require(`fake-otel-api`);\n" +
                // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal JS source under test, not a template
                "console.log(`LOADED:${Bh.marker}`);\n",
        );
        const exe = join(work, "knext-1309-exec");
        const build = spawnSync(
            process.execPath,
            [COMPILE, "--entry", join(server, "index.mjs"), "--outfile", exe],
            { cwd: work, encoding: "utf8" },
        );
        expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
        expect(build.stdout).toContain("fake-otel-api");

        // Production images copy only the binary + .output/public — the traced
        // server node_modules is NOT there. Remove it so a runtime resolution
        // cannot mask a missing bundle.
        rmSync(join(server, "node_modules"), { recursive: true, force: true });

        // Platform-independent proof: the package source is inside the binary.
        expect(readFileSync(exe).includes(Buffer.from(MARKER))).toBe(true);

        // Behavioural proof: the binary loads it.
        const run = spawnSync(exe, [], {
            cwd: work,
            encoding: "utf8",
            timeout: 30_000,
        });
        if (
            process.platform === "darwin" &&
            run.signal === "SIGKILL" &&
            Bun.version === "1.4.0"
        ) {
            // Bun 1.4.0's freshly-built ad-hoc-signed macOS executables are
            // SIGKILLed by the OS before running (#1227) — an environment fault,
            // not this fix's. CI (linux) always runs the behavioural half.
            // Scoped to 1.4.0 only: 1.4.2 (the pin since #1310) signs validly
            // on darwin-arm64, so a SIGKILL there is a real failure.
            return;
        }
        expect(run.stdout, `${run.stdout}\n${run.stderr}`).toContain(
            `LOADED:${MARKER}`,
        );
    }, 120_000);
});

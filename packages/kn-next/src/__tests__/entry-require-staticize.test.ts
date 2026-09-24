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
import { staticizeEntryRequires } from "../adapters/entry-require-staticize.mjs";

const COMPILE = resolve(import.meta.dir, "../adapters/vinext-compile.mjs");
const all = () => true;

describe("staticizeEntryRequires (unit)", () => {
    it("rewrites nitro's createRequire(import.meta.url) call for an external package into a static require", () => {
        const src =
            'import{createRequire}from"node:module";var __require=createRequire(import.meta.url);' +
            "var x=(()=>{var Bh=__require(`@opentelemetry/api`);return Bh})();";
        const out = staticizeEntryRequires(src, all);
        expect(out.contents).toContain('require("@opentelemetry/api")');
        expect(out.contents).not.toContain("__require(`@opentelemetry/api`)");
        expect(out.rewritten).toEqual(["@opentelemetry/api"]);
        // The binding itself is untouched — builtins still go through it.
        expect(out.contents).toContain(
            "__require=createRequire(import.meta.url)",
        );
    });

    it("handles quoted forms and any binding name (declared with const, aliased createRequire)", () => {
        const src =
            "const req = createRequire$1(import.meta.url);\n" +
            "const a = req('pkg-a'); const b = req(\"@scope/pkg-b/sub\");";
        const out = staticizeEntryRequires(src, all);
        expect(out.contents).toContain('require("pkg-a")');
        expect(out.contents).toContain('require("@scope/pkg-b/sub")');
        expect(out.rewritten.sort()).toEqual(["@scope/pkg-b/sub", "pkg-a"]);
    });

    it("leaves node builtins on the runtime require", () => {
        const src =
            "var __require=createRequire(import.meta.url);__require(`util`);__require(`node:string_decoder`);";
        const out = staticizeEntryRequires(src, all);
        expect(out.contents).toBe(src);
        expect(out.rewritten).toEqual([]);
    });

    it("leaves a specifier it cannot resolve untouched and reports it (never breaks the build on an optional dep)", () => {
        const src =
            "var __require=createRequire(import.meta.url);__require(`optional-missing`);";
        const out = staticizeEntryRequires(src, () => false);
        expect(out.contents).toBe(src);
        expect(out.unresolved).toEqual(["optional-missing"]);
    });

    it("does not touch a createRequire anchored anywhere but import.meta.url (sharp's own loader)", () => {
        const src = "let Rh=createRequire$1(join(p,`x`));Rh(`sharp`);";
        const out = staticizeEntryRequires(src, all);
        expect(out.contents).toBe(src);
    });

    it("does not touch dynamic (non-literal) or interpolated specifiers", () => {
        const src =
            // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal JS source under test, not a template
            "var __require=createRequire(import.meta.url);__require(name);__require(`a-${b}`);";
        expect(staticizeEntryRequires(src, all).contents).toBe(src);
    });

    it("does not rewrite a same-named member call (obj.__require) or a longer identifier", () => {
        const src =
            "var __require=createRequire(import.meta.url);o.__require(`pkg`);my__require(`pkg`);";
        expect(staticizeEntryRequires(src, all).contents).toBe(src);
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

/**
 * In-process Rust (Beta) — the image side of ADR-0069 D14 and the D17
 * zero-diff guarantee.
 *
 *  1. The staged `Dockerfile.standalone` gains exactly one line,
 *     `COPY native /app/.next/standalone/native`, directly after the
 *     `standalone-bun` stage's exec COPY — only when `knext.ffi.json` exists.
 *     Without it, byte-identical to the template. A moved or duplicated anchor
 *     fails the staging.
 *  2. Nested (monorepo tracing-root) layout: the line is inserted BEFORE
 *     nesting and rewritten by a NEST_RULES entry present only when opted in,
 *     so `native/` lands beside the nested exec; a non-ffi app's nested
 *     Dockerfile is exactly what nesting produced before.
 *  3. The standalone compile (`compileArtifactForDeploy`, turbopack × bun)
 *     writes `native/.integrity.json` over the staged `native/ffi/**` when
 *     opted in, and creates no `native/` at all otherwise.
 *  4. vinext's sharp staging (`stageSharpNative`) leaves `native/ffi/` alone
 *     for an opted-in app — on a first build (no manifest yet) and on a
 *     rebuild (the previous manifest lists `ffi/**`) — and its manifest covers
 *     it. Once the app opts OUT (deletes `knext.ffi.json`), the old
 *     `native/ffi/` is cleared like any other staged entry, so neither the
 *     manifest nor the image (the vinext Dockerfile COPYs `native/` whole)
 *     carries a library nothing calls.
 */

import { afterAll, describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const roots: string[] = [];
afterAll(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
});

// The real executable build shells out to `bun build --compile`; these tests
// are about what is staged around it, so write a placeholder.
const realExec = { ...(await import("../cli/standalone-exec-build")) };
mock.module("../cli/standalone-exec-build", () => ({
    ...realExec,
    buildStandaloneExecutable: (opts: { cwd: string; arch: string }) => {
        const out = join(opts.cwd, realExec.standaloneExecFileName(opts.arch));
        writeFileSync(out, "binary");
        return out;
    },
}));

const { compileArtifactForDeploy } = await import("../cli/build-artifact");
const {
    FFI_NATIVE_COPY,
    nestStandaloneDockerfile,
    runtimeStandaloneTemplateDir,
    stageStandaloneBuildContext,
} = await import("../cli/runtime-image");
const { stageSharpNative } = await import("../cli/vinext-build");

function tree(files: Record<string, string>): string {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "knext-ffi-img-")));
    roots.push(base);
    for (const [rel, contents] of Object.entries(files)) {
        const abs = join(base, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, contents);
    }
    return base;
}

const TEMPLATE_DIR = runtimeStandaloneTemplateDir();
const TEMPLATE = readFileSync(
    join(TEMPLATE_DIR, "Dockerfile.standalone.hbs"),
    "utf8",
);
const ANCHOR =
    "COPY knext-standalone-exec-linux-x64 /app/.next/standalone/knext-standalone-exec";
const TRIPLE = "x86_64-unknown-linux-musl";
const OPT_IN = { "knext.ffi.json": '{ "version": 1 }\n' };
const sha = (b: Uint8Array | string) =>
    createHash("sha256").update(b).digest("hex");

/** Instruction lines of one stage (comments/blanks dropped). */
function stage(dockerfile: string, name: string): string[] {
    const start = dockerfile.search(new RegExp(`^FROM .* AS ${name}$`, "m"));
    expect(start, `no ${name} stage`).toBeGreaterThan(-1);
    const rest = dockerfile.slice(start);
    const next = rest.indexOf("\nFROM ", 1);
    return (next === -1 ? rest : rest.slice(0, next))
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "" && !l.startsWith("#"));
}

function stageFlat(files: Record<string, string>, templateDir?: string) {
    const app = tree({ "package.json": "{}", ...files });
    const { dockerfile } = stageStandaloneBuildContext({
        cwd: app,
        buildContext: app,
        ...(templateDir ? { templateDir } : {}),
    });
    return readFileSync(dockerfile, "utf8");
}

const WEB_CONFIG = `const path = require("node:path");
module.exports = {
    output: "standalone",
    outputFileTracingRoot: path.join(__dirname, "..", ".."),
    turbopack: { root: path.join(__dirname, "..", "..") },
};
`;

function stageNested(files: Record<string, string>) {
    const root = tree({
        "package.json": "{}",
        "apps/web/package.json": "{}",
        "apps/web/next.config.js": WEB_CONFIG,
        ...files,
    });
    const { dockerfile } = stageStandaloneBuildContext({
        cwd: join(root, "apps", "web"),
        buildContext: root,
    });
    return readFileSync(dockerfile, "utf8");
}

/** A template directory whose Dockerfile is `edit(TEMPLATE)`. */
function templateWith(edit: (t: string) => string): string {
    const dir = tree({});
    for (const f of readdirSync(TEMPLATE_DIR)) {
        writeFileSync(join(dir, f), readFileSync(join(TEMPLATE_DIR, f)));
    }
    writeFileSync(join(dir, "Dockerfile.standalone.hbs"), edit(TEMPLATE));
    return dir;
}

describe("the staged Dockerfile — flat layout", () => {
    it("D17 zero-diff: without knext.ffi.json it is byte-identical to the template", () => {
        expect(stageFlat({})).toBe(TEMPLATE);
    });

    it("opted in: exactly one line is added, directly after the standalone-bun exec COPY", () => {
        const text = stageFlat(OPT_IN);
        expect(FFI_NATIVE_COPY).toBe(
            "COPY native /app/.next/standalone/native",
        );
        const lines = stage(text, "standalone-bun");
        const at = lines.indexOf(ANCHOR);
        expect(at).toBeGreaterThan(-1);
        expect(lines[at + 1]).toBe(FFI_NATIVE_COPY);
        // Nothing else changed: removing the one line gives the template back.
        const added = text
            .split("\n")
            .filter((l) => !TEMPLATE.split("\n").includes(l));
        expect(added).toEqual([FFI_NATIVE_COPY]);
        expect(text.split("\n").length).toBe(TEMPLATE.split("\n").length + 1);
        // No other stage ships native/.
        for (const s of ["standalone-bun-self-contained", "standalone-node"]) {
            expect(stage(text, s).join("\n")).not.toContain("COPY native");
        }
    });

    it("a missing anchor fails the staging when opted in", () => {
        const dir = templateWith((t) => t.replace(`${ANCHOR}\n`, ""));
        expect(() => stageFlat(OPT_IN, dir)).toThrow(/exactly once/);
        // ...and is irrelevant when not opted in.
        expect(() => stageFlat({}, dir)).not.toThrow();
    });

    it("a duplicated anchor fails the staging when opted in", () => {
        const dir = templateWith((t) =>
            t.replace(ANCHOR, `${ANCHOR}\n${ANCHOR}`),
        );
        expect(() => stageFlat(OPT_IN, dir)).toThrow(/exactly once/);
    });

    it("an anchor moved out of the standalone-bun stage fails the staging", () => {
        const dir = templateWith((t) =>
            t
                .replace(`${ANCHOR}\n`, "")
                .replace(
                    "COPY knext-standalone-exec-linux-x64 /app/knext-standalone-exec",
                    `COPY knext-standalone-exec-linux-x64 /app/knext-standalone-exec\n${ANCHOR}`,
                ),
        );
        expect(() => stageFlat(OPT_IN, dir)).toThrow(/standalone-bun/);
    });
});

describe("the staged Dockerfile — nested (monorepo root) layout", () => {
    it("opted in: the inserted line is rewritten so native/ sits beside the nested exec", () => {
        const text = stageNested({ "apps/web/knext.ffi.json": "{}\n" });
        const lines = stage(text, "standalone-bun");
        const at = lines.indexOf(
            "COPY apps/web/knext-standalone-exec-linux-x64 /app/.next/standalone/apps/web/knext-standalone-exec",
        );
        expect(at).toBeGreaterThan(-1);
        expect(lines[at + 1]).toBe(
            "COPY apps/web/native /app/.next/standalone/apps/web/native",
        );
        expect(text).not.toContain(FFI_NATIVE_COPY);
    });

    it("not opted in: byte-identical to nesting without the ffi rule, and no native line", () => {
        const text = stageNested({});
        expect(text).toBe(
            nestStandaloneDockerfile(TEMPLATE, {
                contextPrefix: "apps/web/",
                coreSrc: "apps/web/node_modules/@getknext/core",
            }),
        );
        expect(text).not.toMatch(/^COPY \S*native /m);
    });
});

// ---------------------------------------------------------------------------
// The integrity manifest on the standalone compile (turbopack × bun).
// ---------------------------------------------------------------------------

const bunCfg = {
    name: "zone",
    registry: "r",
    build: "turbopack",
    runtime: "bun",
} as never;

function standaloneApp(files: Record<string, string> = {}) {
    return tree({
        "package.json": "{}",
        "next.config.js": 'module.exports = { output: "standalone" };\n',
        ".next/standalone/server.js": "// flat\n",
        ".next/standalone/package.json": "{}",
        ...files,
    });
}

describe("compileArtifactForDeploy — native/.integrity.json over native/ffi", () => {
    it("opted in: lists ffi/<triple>/lib<name>.so and provenance.json with their sha256", () => {
        const lib = "\u007fELF fake library bytes";
        const prov = '{ "target": "x86_64-unknown-linux-musl" }\n';
        const app = standaloneApp({
            ...OPT_IN,
            [`native/ffi/${TRIPLE}/libzone.so`]: lib,
            [`native/ffi/${TRIPLE}/provenance.json`]: prov,
        });
        const result = compileArtifactForDeploy(bunCfg, app);
        expect(result.compiled).toBe(true);
        const manifest = JSON.parse(
            readFileSync(join(app, "native", ".integrity.json"), "utf8"),
        );
        expect(manifest.version).toBe(1);
        expect(manifest.algorithm).toBe("sha256");
        expect(manifest.files).toEqual({
            [`ffi/${TRIPLE}/libzone.so`]: sha(lib),
            [`ffi/${TRIPLE}/provenance.json`]: sha(prov),
        });
    });

    it("opted in with nothing staged for the image arch: refuses rather than ship an image without its library", () => {
        const app = standaloneApp(OPT_IN);
        expect(() => compileArtifactForDeploy(bunCfg, app)).toThrow(
            /native\/ffi\/x86_64-unknown-linux-musl/,
        );
        expect(existsSync(join(app, "native", ".integrity.json"))).toBe(false);
    });

    it("D17 zero-diff: without knext.ffi.json no native/ tree is created", () => {
        const app = standaloneApp();
        compileArtifactForDeploy(bunCfg, app);
        expect(existsSync(join(app, "native"))).toBe(false);
    });

    it("D17 zero-diff: without knext.ffi.json a leftover native/ffi is neither hashed nor shipped", () => {
        // An app that opted out keeps a stale tree on disk; nothing re-hashes
        // it, and the Dockerfile does not COPY it (the condition is the file).
        const app = standaloneApp({
            [`native/ffi/${TRIPLE}/libzone.so`]: "stale",
        });
        compileArtifactForDeploy(bunCfg, app);
        expect(existsSync(join(app, "native", ".integrity.json"))).toBe(false);
        expect(stageFlat({})).not.toContain("COPY native");
    });
});

// ---------------------------------------------------------------------------
// vinext's native/ clean-up keeps its hands off native/ffi/.
// ---------------------------------------------------------------------------

describe("stageSharpNative (vinext × bun) leaves native/ffi/ alone when opted in", () => {
    const LIB = `native/ffi/${TRIPLE}/libzone.so`;

    it("first build: native/ffi/ staged before any manifest exists is kept and hashed", () => {
        const app = tree({ "package.json": "{}", ...OPT_IN, [LIB]: "lib-v1" });
        stageSharpNative(app, { arch: "linux-x64" });
        expect(readFileSync(join(app, LIB), "utf8")).toBe("lib-v1");
        const files = JSON.parse(
            readFileSync(join(app, "native", ".integrity.json"), "utf8"),
        ).files;
        expect(files).toEqual({ [`ffi/${TRIPLE}/libzone.so`]: sha("lib-v1") });
    });

    it("rebuild: the previous manifest lists ffi/**, and the freshly staged library still survives", () => {
        const app = tree({ "package.json": "{}", ...OPT_IN, [LIB]: "lib-v1" });
        stageSharpNative(app, { arch: "linux-x64" });
        // The next build's `knext ffi build` replaces native/ffi/ first.
        writeFileSync(join(app, LIB), "lib-v2");
        stageSharpNative(app, { arch: "linux-x64" });
        expect(readFileSync(join(app, LIB), "utf8")).toBe("lib-v2");
        const files = JSON.parse(
            readFileSync(join(app, "native", ".integrity.json"), "utf8"),
        ).files;
        expect(files[`ffi/${TRIPLE}/libzone.so`]).toBe(sha("lib-v2"));
    });

    it("a hand-written file outside native/ffi/ with no manifest is still refused (unchanged)", () => {
        const app = tree({
            "package.json": "{}",
            ...OPT_IN,
            [LIB]: "lib",
            "native/mine.txt": "do not delete",
        });
        expect(() => stageSharpNative(app, { arch: "linux-x64" })).toThrow(
            /Refusing to stage/,
        );
        expect(readFileSync(join(app, "native", "mine.txt"), "utf8")).toBe(
            "do not delete",
        );
    });
});

describe("stageSharpNative (vinext) clears a stale native/ffi/ once the app opts out", () => {
    const LIB = `native/ffi/${TRIPLE}/libzone.so`;

    it("the vinext image ships native/ whole, so what is on disk is what ships", () => {
        const vinextDockerfile = readFileSync(
            join(dirname(TEMPLATE_DIR), "app", "Dockerfile.hbs"),
            "utf8",
        );
        expect(vinextDockerfile).toMatch(/^COPY native \/app\/native$/m);
    });

    it("opted out after an opted-in build: native/ffi/ is removed and the manifest no longer lists it", () => {
        const app = tree({ "package.json": "{}", ...OPT_IN, [LIB]: "lib-v1" });
        stageSharpNative(app, { arch: "linux-x64" });
        const before = JSON.parse(
            readFileSync(join(app, "native", ".integrity.json"), "utf8"),
        ).files;
        expect(Object.keys(before)).toContain(`ffi/${TRIPLE}/libzone.so`);

        rmSync(join(app, "knext.ffi.json"));
        stageSharpNative(app, { arch: "linux-x64" });

        expect(existsSync(join(app, "native", "ffi"))).toBe(false);
        const after = JSON.parse(
            readFileSync(join(app, "native", ".integrity.json"), "utf8"),
        ).files;
        expect(after).toEqual({});
        expect(readdirSync(join(app, "native"))).toEqual([".integrity.json"]);
    });

    it("opted in: the same rebuild keeps native/ffi/ (the control for the case above)", () => {
        const app = tree({ "package.json": "{}", ...OPT_IN, [LIB]: "lib-v1" });
        stageSharpNative(app, { arch: "linux-x64" });
        stageSharpNative(app, { arch: "linux-x64" });
        expect(readFileSync(join(app, LIB), "utf8")).toBe("lib-v1");
    });

    it("opted out with a native/ffi/ no manifest accounts for: refused, not deleted", () => {
        // Not provably knext's (no ownership record), so the usual refusal.
        const app = tree({ "package.json": "{}", [LIB]: "lib" });
        expect(() => stageSharpNative(app, { arch: "linux-x64" })).toThrow(
            /Refusing to stage/,
        );
        expect(readFileSync(join(app, LIB), "utf8")).toBe("lib");
    });
});

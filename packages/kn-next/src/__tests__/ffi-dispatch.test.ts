/**
 * Core's lazy dispatch to the optional `@getknext/ffi` package (`knext ffi …`,
 * ADR-0069 D12), and the core-vs-app boundary of D18.
 *
 * The boundary: everything that knows Rust lives in `@getknext/ffi` and the
 * knext-ffi crates, never in core. Core may only LOAD the package, lazily,
 * when `knext ffi` is typed — no static import, no dependency, nothing bundled
 * into the bin, no `bun:ffi`, no cargo tooling — and must refuse a mismatched
 * pair with a message that names both versions.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { KNOWN_VERBS, resolveInvocation } from "../cli/dispatch";
import {
    coreVersion,
    dispatchFfiVerb,
    FFI_PACKAGE,
    FFI_VERBS,
    type FfiCliModule,
    ffiMain,
} from "../cli/ffi-dispatch";
import { CLI_HELP } from "../cli/help";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..", "..");
const srcRoot = join(pkgRoot, "src");
const distBin = join(pkgRoot, "dist", "cli", "kn-next.js");

const scratchDirs: string[] = [];
afterAll(() => {
    for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
});
function scratch(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), `knext-ffi-dispatch-${prefix}-`));
    scratchDirs.push(dir);
    return dir;
}

/** Every core source file (tests excluded), recursively. */
function sources(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
            if (name !== "__tests__") out.push(...sources(p));
        } else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name)) {
            out.push(p);
        }
    }
    return out;
}

function capture() {
    let out = "";
    let err = "";
    return {
        io: {
            stdout: (s: string) => {
                out += s;
            },
            stderr: (s: string) => {
                err += s;
            },
        },
        out: () => out,
        err: () => err,
    };
}

function fakeModule(over: Partial<FfiCliModule> = {}): {
    mod: FfiCliModule;
    calls: string[];
} {
    const calls: string[] = [];
    return {
        calls,
        mod: {
            DISPATCH_PROTOCOL: 1,
            FFI_VERSION: "0.1.0",
            CORE_PEER_RANGE: ">=2.0.0-0 <3.0.0",
            helpText: (sub: string) =>
                `knext ffi ${sub || "<group>"} — full help`,
            run: async (verb: string, argv: readonly string[]) => {
                calls.push([verb, ...argv].join(" "));
                return 7;
            },
            ...over,
        },
    };
}

// ---------------------------------------------------------------------------
// D18 — the boundary guard. Scans core source; does not enumerate files.
// ---------------------------------------------------------------------------

/** An import/require of a specifier matching `spec`, in any static or literal dynamic form. */
const importOf = (spec: string) =>
    new RegExp(
        `(?:from\\s*|import\\s*\\(\\s*|import\\s+|require\\s*\\(\\s*|getBuiltinModule\\s*\\(\\s*)["'\`]${spec}`,
    );

/** The guard as a function, so the mutation test can prove it sees a violation. */
function boundaryViolations(files: { path: string; text: string }[]): string[] {
    const out: string[] = [];
    for (const { path, text } of files) {
        if (importOf("@getknext/ffi").test(text))
            out.push(`${path}: imports @getknext/ffi`);
        if (importOf("bun:ffi").test(text))
            out.push(`${path}: imports bun:ffi`);
        if (importOf("[^\"'`]*(?:cargo|zigbuild)").test(text)) {
            out.push(`${path}: imports cargo tooling`);
        }
        // Running cargo / zig from core: a quoted program name is how a spawn names it.
        if (/["'`](?:cargo|cargo-zigbuild|zig|zigbuild)["'`]/.test(text)) {
            out.push(`${path}: names cargo tooling as a program`);
        }
    }
    return out;
}

describe("D18 — core never depends on Rust or imports @getknext/ffi", () => {
    const files = sources(srcRoot).map((path) => ({
        path: relative(srcRoot, path),
        text: readFileSync(path, "utf8"),
    }));

    it("scans a non-trivial tree", () => {
        expect(files.length).toBeGreaterThan(100);
    });

    it("no static or dynamic import of @getknext/ffi, bun:ffi or cargo tooling, and no cargo program name, anywhere in core source", () => {
        expect(boundaryViolations(files)).toEqual([]);
    });

    it("the guard sees each kind of violation (it is not decoration)", () => {
        const bad = [
            'import { run } from "@getknext/ffi/cli";',
            "const m = await import('@getknext/ffi/cli');",
            'import { dlopen } from "bun:ffi";',
            "process.getBuiltinModule('bun:ffi');",
            'require("cargo-zigbuild-wrapper");',
            'spawnSync("cargo", ["build"]);',
            "spawnSync('zig', ['version']);",
        ];
        for (const text of bad) {
            expect(
                boundaryViolations([{ path: "x.ts", text }]),
                text,
            ).not.toEqual([]);
        }
    });

    it("the only mention of the package in core source is the lazy dispatcher", () => {
        expect(
            files
                .filter((f) => f.text.includes(FFI_PACKAGE))
                .map((f) => f.path),
        ).toEqual([join("cli", "ffi-dispatch.ts")]);
    });

    it("core does not depend on the package in any dependency field", () => {
        const pkg = JSON.parse(
            readFileSync(join(pkgRoot, "package.json"), "utf8"),
        ) as Record<string, Record<string, string> | undefined>;
        for (const field of [
            "dependencies",
            "devDependencies",
            "peerDependencies",
            "optionalDependencies",
        ]) {
            expect(Object.keys(pkg[field] ?? {}), field).not.toContain(
                FFI_PACKAGE,
            );
        }
    });

    it("the built bin carries none of the package's code", () => {
        expect(
            existsSync(distBin),
            `${distBin} missing — build core first`,
        ).toBe(true);
        for (const f of readdirSync(join(pkgRoot, "dist", "cli"))) {
            if (!f.endsWith(".js")) continue;
            const text = readFileSync(join(pkgRoot, "dist", "cli", f), "utf8");
            expect(text, f).not.toContain("KNEXTFFI1");
            expect(text, f).not.toContain("knext_ffi_v1_");
            expect(text, f).not.toContain("renderModule");
        }
    });
});

// ---------------------------------------------------------------------------

describe("the dispatcher routes `knext ffi`, and nothing else", () => {
    it("owns exactly `ffi`, which the bin knows and the help lists", () => {
        expect([...FFI_VERBS]).toEqual(["ffi"]);
        expect(KNOWN_VERBS.has("ffi")).toBe(true);
        expect(resolveInvocation("ffi")).toEqual({ kind: "verb", verb: "ffi" });
        expect(CLI_HELP).toContain(
            "In-process Rust (Beta, Bun only, optional package):",
        );
        for (const sub of ["init", "generate", "check"]) {
            expect(CLI_HELP).toContain(`  ffi ${sub}`);
        }
    });

    it("delegates to the module's run() with the verb and its argv", async () => {
        const { mod, calls } = fakeModule();
        const c = capture();
        const code = await dispatchFfiVerb("ffi", ["check"], "2.0.0", {
            load: async () => mod,
            ...c.io,
        });
        expect(code).toBe(7);
        expect(calls).toEqual(["ffi check"]);
    });

    it("--help asks the module for the subcommand's help", async () => {
        const { mod, calls } = fakeModule();
        const c = capture();
        expect(
            await dispatchFfiVerb("ffi", ["generate", "--help"], "2.0.0", {
                load: async () => mod,
                ...c.io,
            }),
        ).toBe(0);
        expect(c.out()).toContain("knext ffi generate — full help");
        expect(calls).toEqual([]);
        const g = capture();
        await dispatchFfiVerb("ffi", ["-h"], "2.0.0", {
            load: async () => mod,
            ...g.io,
        });
        expect(g.out()).toContain("knext ffi <group> — full help");
    });

    it("ffiMain answers --help in-process when the package is absent", async () => {
        const writes: string[] = [];
        const original = process.stdout.write.bind(process.stdout);
        process.stdout.write = ((chunk: string | Uint8Array) => {
            writes.push(String(chunk));
            return true;
        }) as typeof process.stdout.write;
        try {
            expect(await ffiMain(["--help"])).toBe(0);
        } finally {
            process.stdout.write = original;
        }
        expect(writes.join("")).toContain("knext ffi");
        expect(writes.join("")).toContain("Beta");
    });

    it("the default loader finds the package from the app directory", async () => {
        const app = scratch("inproc-installed");
        const dir = join(app, "node_modules", "@getknext", "ffi");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "package.json"),
            JSON.stringify({
                name: "@getknext/ffi",
                version: "0.1.0",
                type: "module",
                exports: { "./cli": { default: "./cli.js" } },
            }),
        );
        writeFileSync(
            join(dir, "cli.js"),
            [
                "export const DISPATCH_PROTOCOL = 1;",
                'export const FFI_VERSION = "0.1.0";',
                'export const CORE_PEER_RANGE = ">=0.0.0";',
                "export const helpText = () => '';",
                "export async function run() { return 9; }",
            ].join("\n"),
        );
        const cwd = process.cwd();
        process.chdir(app);
        try {
            expect(await ffiMain(["check"])).toBe(9);
        } finally {
            process.chdir(cwd);
        }
    });
});

describe("the Beta label is visible wherever a user meets the feature (ADR-0069 D2)", () => {
    it("PUBLIC_API.md lists `knext ffi` among the experimental surfaces, once", () => {
        const doc = readFileSync(
            resolve(pkgRoot, "..", "..", "docs", "PUBLIC_API.md"),
            "utf8",
        );
        const section = doc.slice(
            doc.indexOf("## Experimental surfaces"),
            doc.indexOf("### The `NextApp` CRD is versioned separately"),
        );
        expect(
            section.split("- **`knext ffi` (in-process Rust, Beta, Bun only)**").length - 1,
        ).toBe(1);
    });

    it("the CLI help group says Beta and Bun only", () => {
        expect(CLI_HELP).toContain("In-process Rust (Beta, Bun only, optional package):");
    });
});
describe("coreVersion finds @getknext/core from the source AND from a bundled chunk", () => {
    const version = (
        JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as {
            version: string;
        }
    ).version;

    it("from src/cli/ffi-dispatch.ts (two levels below package.json)", () => {
        expect(coreVersion()).toBe(version);
    });

    it("from a chunk at dist/ (one level below), where a fixed ../../ read 0.0.0", () => {
        expect(coreVersion(pathToFileURL(join(pkgRoot, "dist", "chunk.js")).href)).toBe(version);
    });

    it("from dist/cli/ (two levels below)", () => {
        expect(
            coreVersion(pathToFileURL(join(pkgRoot, "dist", "cli", "x.js")).href),
        ).toBe(version);
    });
});
describe("version and protocol checks name both versions", () => {
    it("refuses a core outside the module's peer range", async () => {
        const { mod, calls } = fakeModule();
        const c = capture();
        const code = await dispatchFfiVerb("ffi", ["generate"], "1.3.0", {
            load: async () => mod,
            ...c.io,
        });
        expect(code).toBe(1);
        expect(calls).toEqual([]);
        expect(c.err()).toContain("@getknext/ffi 0.1.0");
        expect(c.err()).toContain(">=2.0.0-0 <3.0.0");
        expect(c.err()).toContain("@getknext/core 1.3.0");
    });

    it("refuses a module that speaks another dispatch protocol", async () => {
        const { mod, calls } = fakeModule({ DISPATCH_PROTOCOL: 2 });
        const c = capture();
        expect(
            await dispatchFfiVerb("ffi", ["generate"], "2.0.0", {
                load: async () => mod,
                ...c.io,
            }),
        ).toBe(1);
        expect(calls).toEqual([]);
        expect(c.err()).toContain("@getknext/ffi 0.1.0");
        expect(c.err()).toContain("@getknext/core 2.0.0");
    });

    it("fails closed on a peer range it cannot read", async () => {
        const { mod } = fakeModule({ CORE_PEER_RANGE: "2.x || 3.x" });
        const c = capture();
        expect(
            await dispatchFfiVerb("ffi", ["check"], "2.0.0", {
                load: async () => mod,
                ...c.io,
            }),
        ).toBe(1);
        expect(c.err()).toContain("2.x || 3.x");
    });

    it("--help works on a mismatched pair, and does no work", async () => {
        const { mod, calls } = fakeModule();
        const c = capture();
        expect(
            await dispatchFfiVerb("ffi", ["--help"], "1.3.0", {
                load: async () => mod,
                ...c.io,
            }),
        ).toBe(0);
        expect(calls).toEqual([]);
    });

    it("a module whose run() throws is a plain message, exit 1", async () => {
        const { mod } = fakeModule({
            run: async () => {
                throw new Error("kaboom");
            },
        });
        const c = capture();
        expect(
            await dispatchFfiVerb("ffi", ["check"], "2.0.0", {
                load: async () => mod,
                ...c.io,
            }),
        ).toBe(1);
        expect(c.err()).toContain("knext ffi check failed: kaboom");
    });
});

describe("when @getknext/ffi is not installed", () => {
    const missing = async (): Promise<FfiCliModule> => {
        const err = new Error("Cannot find module '@getknext/ffi/cli'");
        Object.assign(err, { code: "MODULE_NOT_FOUND" });
        throw err;
    };

    it("--help still exits 0, lists the subcommands and says how to install it", async () => {
        for (const argv of [["--help"], ["init", "--help"], ["-h"]]) {
            const c = capture();
            expect(
                await dispatchFfiVerb("ffi", argv, "2.0.0", {
                    load: missing,
                    ...c.io,
                }),
            ).toBe(0);
            for (const s of [
                "knext ffi init",
                "knext ffi generate",
                "knext ffi check",
            ]) {
                expect(c.out()).toContain(s);
            }
            expect(c.out()).toContain("npm install --save-dev @getknext/ffi");
            expect(c.out()).toContain("Bun only");
        }
    });

    it("anything else exits 1 with the install hint, naming what was typed", async () => {
        const c = capture();
        expect(
            await dispatchFfiVerb("ffi", ["generate"], "2.0.0", {
                load: missing,
                ...c.io,
            }),
        ).toBe(1);
        expect(c.err()).toContain("knext ffi generate");
        expect(c.err()).toContain("@getknext/ffi");
        expect(c.err()).not.toMatch(/\n\s+at\s/);
    });

    it("a load failure that is not 'not installed' is reported as such", async () => {
        const c = capture();
        expect(
            await dispatchFfiVerb("ffi", ["check"], "2.0.0", {
                load: async () => {
                    throw new SyntaxError("Unexpected token");
                },
                ...c.io,
            }),
        ).toBe(1);
        expect(c.err()).toContain("could not load @getknext/ffi");
        expect(c.err()).toContain("Unexpected token");
    });
});

describe("the built bin routes `knext ffi` to the package, never to deploy", () => {
    function runBin(args: string[], cwd: string) {
        // Plain node, like a user's `npx knext`: the bin must not need bun.
        return spawnSync("node", [distBin, ...args], {
            cwd,
            encoding: "utf8",
            env: { ...process.env, NODE_OPTIONS: "", NO_COLOR: "1" },
            timeout: 30_000,
        });
    }

    it("`knext ffi --help` exits 0 without the package installed", () => {
        const r = runBin(["ffi", "--help"], scratch("bin-help"));
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout).toContain("knext ffi init");
    });

    it("without the package installed, `knext ffi check` explains and exits 1", () => {
        const r = runBin(["ffi", "check"], scratch("bin-missing"));
        expect(r.status).toBe(1);
        const all = `${r.stdout}${r.stderr}`;
        expect(all).toContain("@getknext/ffi");
        expect(all).not.toContain("No knext.config.ts found");
        expect(all).not.toContain("FATAL");
    });

    it("loads the package from the app's own node_modules and hands it the argv", () => {
        const app = scratch("bin-installed");
        const dir = join(app, "node_modules", "@getknext", "ffi");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "package.json"),
            JSON.stringify({
                name: "@getknext/ffi",
                version: "0.1.0",
                type: "module",
                exports: { "./cli": { default: "./cli.js" } },
            }),
        );
        const core = JSON.parse(
            readFileSync(join(pkgRoot, "package.json"), "utf8"),
        ) as { version: string };
        writeFileSync(
            join(dir, "cli.js"),
            [
                "export const DISPATCH_PROTOCOL = 1;",
                'export const FFI_VERSION = "0.1.0";',
                `export const CORE_PEER_RANGE = "=${core.version}";`,
                "export const helpText = (s) => `knext ffi ${s} help`;",
                "export async function run(verb, argv) {",
                '  process.stdout.write(`fake-ffi ${verb} ${argv.join(" ")}\\n`);',
                "  return 5;",
                "}",
            ].join("\n"),
        );
        const r = runBin(["ffi", "generate"], app);
        expect(r.stdout, r.stderr).toContain("fake-ffi ffi generate");
        expect(r.status).toBe(5);
        const h = runBin(["ffi", "init", "--help"], app);
        expect(h.status).toBe(0);
        expect(h.stdout).toContain("knext ffi init help");
    });

    it("a mismatched installed pair is refused through the bin, naming both versions", () => {
        const app = scratch("bin-mismatch");
        const dir = join(app, "node_modules", "@getknext", "ffi");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "package.json"),
            JSON.stringify({
                name: "@getknext/ffi",
                version: "9.9.9",
                type: "module",
                exports: { "./cli": { default: "./cli.js" } },
            }),
        );
        writeFileSync(
            join(dir, "cli.js"),
            [
                "export const DISPATCH_PROTOCOL = 1;",
                'export const FFI_VERSION = "9.9.9";',
                'export const CORE_PEER_RANGE = ">=99.0.0";',
                "export const helpText = () => '';",
                "export async function run() { return 0; }",
            ].join("\n"),
        );
        const r = runBin(["ffi", "check"], app);
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("@getknext/ffi 9.9.9");
        expect(r.stderr).toMatch(/@getknext\/core \d+\.\d+\.\d+/);
    });
});

/**
 * Core's lazy dispatch to the optional `@getknext/grpc` package
 * (`knext generate`, `knext add function`).
 *
 * The boundary this guards: zone-function orchestration lives in
 * `@getknext/grpc`, never in core. Core may only LOAD that package, lazily,
 * when one of its verbs is typed — no static import, no dependency, nothing
 * bundled into the bin — and must refuse a mismatched pair with a message that
 * names both versions.
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
import { fileURLToPath } from "node:url";
import { KNOWN_VERBS } from "../cli/dispatch";
import {
    addMain,
    dispatchGrpcVerb,
    GRPC_PACKAGE,
    GRPC_VERBS,
    type GrpcCliModule,
    generateMain,
    satisfiesRange,
} from "../cli/grpc-dispatch";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..", "..");
const srcRoot = join(pkgRoot, "src");
const distBin = join(pkgRoot, "dist", "cli", "kn-next.js");

const scratchDirs: string[] = [];
afterAll(() => {
    for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
});
function scratch(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), `knext-grpc-dispatch-${prefix}-`));
    scratchDirs.push(dir);
    return dir;
}

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

function fakeModule(over: Partial<GrpcCliModule> = {}): {
    mod: GrpcCliModule;
    calls: string[];
} {
    const calls: string[] = [];
    return {
        calls,
        mod: {
            DISPATCH_PROTOCOL: 1,
            GRPC_VERSION: "0.1.0",
            CORE_PEER_RANGE: ">=2.0.0-0 <3.0.0",
            helpText: (verb: string) => `knext ${verb} — full help`,
            run: async (verb: string, argv: readonly string[]) => {
                calls.push([verb, ...argv].join(" "));
                return 7;
            },
            ...over,
        },
    };
}

describe("core never imports @getknext/grpc eagerly", () => {
    it("the only mention of the package in core source is the lazy dispatcher", () => {
        const files = sources(srcRoot).filter((f) =>
            readFileSync(f, "utf8").includes(GRPC_PACKAGE),
        );
        expect(files.map((f) => relative(srcRoot, f))).toEqual([
            join("cli", "grpc-dispatch.ts"),
        ]);
    });

    it("no static or literal dynamic import of the package anywhere in core source", () => {
        const importRe =
            /(?:from\s*|import\s*\(\s*|import\s+|require\s*\(\s*)["'`]@getknext\/grpc/;
        for (const f of sources(srcRoot)) {
            expect(
                importRe.test(readFileSync(f, "utf8")),
                relative(srcRoot, f),
            ).toBe(false);
        }
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
                GRPC_PACKAGE,
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
            expect(text, f).not.toContain("protoc-gen-knext");
            expect(text, f).not.toContain("defineFunctionClient");
            expect(text, f).not.toContain("@bufbuild/");
        }
    });
});

describe("the dispatcher routes generate and add, and nothing else", () => {
    it("owns exactly generate and add, both in the shipped verb list", () => {
        expect([...GRPC_VERBS].sort()).toEqual(["add", "generate"]);
        for (const verb of GRPC_VERBS) expect(KNOWN_VERBS.has(verb)).toBe(true);
    });

    it("delegates to the module's run() with the verb and its argv", async () => {
        const { mod, calls } = fakeModule();
        const c = capture();
        const code = await dispatchGrpcVerb("generate", ["--check"], "2.0.0", {
            load: async () => mod,
            ...c.io,
        });
        expect(code).toBe(7);
        expect(calls).toEqual(["generate --check"]);
    });

    it("generateMain and addMain answer --help in-process when the package is absent", async () => {
        // The repo root has no @getknext/grpc in reach of core (core does not
        // depend on it), so the default loader reports "not installed".
        const writes: string[] = [];
        const original = process.stdout.write.bind(process.stdout);
        process.stdout.write = ((chunk: string | Uint8Array) => {
            writes.push(String(chunk));
            return true;
        }) as typeof process.stdout.write;
        try {
            expect(await generateMain(["--help"])).toBe(0);
            expect(await addMain(["-h"])).toBe(0);
        } finally {
            process.stdout.write = original;
        }
        expect(writes.join("")).toContain("knext generate");
        expect(writes.join("")).toContain("knext add function");
    });

    it("the default loader finds the package from the app directory", async () => {
        const app = scratch("inproc-installed");
        const dir = join(app, "node_modules", "@getknext", "grpc");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "package.json"),
            JSON.stringify({
                name: "@getknext/grpc",
                version: "0.1.0",
                type: "module",
                exports: { "./cli": { default: "./cli.js" } },
            }),
        );
        writeFileSync(
            join(dir, "cli.js"),
            [
                "export const DISPATCH_PROTOCOL = 1;",
                'export const GRPC_VERSION = "0.1.0";',
                'export const CORE_PEER_RANGE = ">=0.0.0";',
                "export const helpText = () => '';",
                "export async function run() { return 9; }",
            ].join("\n"),
        );
        const cwd = process.cwd();
        process.chdir(app);
        try {
            expect(await generateMain(["--check"])).toBe(9);
        } finally {
            process.chdir(cwd);
        }
    });
});

describe("version and protocol checks name both versions", () => {
    it("refuses a core outside the module's peer range", async () => {
        const { mod, calls } = fakeModule();
        const c = capture();
        const code = await dispatchGrpcVerb("generate", [], "1.3.0", {
            load: async () => mod,
            ...c.io,
        });
        expect(code).toBe(1);
        expect(calls).toEqual([]);
        expect(c.err()).toContain("@getknext/grpc 0.1.0");
        expect(c.err()).toContain(">=2.0.0-0 <3.0.0");
        expect(c.err()).toContain("@getknext/core 1.3.0");
    });

    it("accepts a 2.x prerelease and a 2.x release", async () => {
        for (const core of ["2.0.0-next.3", "2.0.0", "2.9.1"]) {
            const { mod } = fakeModule();
            expect(
                await dispatchGrpcVerb("add", [], core, {
                    load: async () => mod,
                    ...capture().io,
                }),
                core,
            ).toBe(7);
        }
    });

    it("refuses a module that speaks another dispatch protocol", async () => {
        const { mod, calls } = fakeModule({ DISPATCH_PROTOCOL: 2 });
        const c = capture();
        expect(
            await dispatchGrpcVerb("generate", [], "2.0.0", {
                load: async () => mod,
                ...c.io,
            }),
        ).toBe(1);
        expect(calls).toEqual([]);
        expect(c.err()).toContain("0.1.0");
        expect(c.err()).toContain("2.0.0");
    });

    it("fails closed on a peer range it cannot read", async () => {
        const { mod } = fakeModule({ CORE_PEER_RANGE: "2.x || 3.x" });
        const c = capture();
        expect(
            await dispatchGrpcVerb("generate", [], "2.0.0", {
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
            await dispatchGrpcVerb("generate", ["--help"], "1.3.0", {
                load: async () => mod,
                ...c.io,
            }),
        ).toBe(0);
        expect(calls).toEqual([]);
        expect(c.out()).toContain("knext generate — full help");
    });
});

describe("when @getknext/grpc is not installed", () => {
    const missing = async (): Promise<GrpcCliModule> => {
        const err = new Error("Cannot find module '@getknext/grpc/cli'");
        Object.assign(err, { code: "MODULE_NOT_FOUND" });
        throw err;
    };

    it("--help still exits 0 and says how to install it", async () => {
        for (const verb of ["generate", "add"]) {
            const c = capture();
            expect(
                await dispatchGrpcVerb(verb, ["--help"], "2.0.0", {
                    load: missing,
                    ...c.io,
                }),
            ).toBe(0);
            expect(c.out()).toContain(`knext ${verb}`);
            expect(c.out()).toContain("npm install --save-dev @getknext/grpc");
        }
    });

    it("anything else exits 1 with the install hint, naming what was typed", async () => {
        const c = capture();
        expect(
            await dispatchGrpcVerb(
                "generate",
                ["--zzz-not-a-real-flag"],
                "2.0.0",
                {
                    load: missing,
                    ...c.io,
                },
            ),
        ).toBe(1);
        expect(c.err()).toContain("knext generate --zzz-not-a-real-flag");
        expect(c.err()).toContain("@getknext/grpc");
        expect(c.err()).not.toMatch(/\n\s+at\s/);
    });

    it("a load failure that is not 'not installed' is reported as such", async () => {
        const c = capture();
        expect(
            await dispatchGrpcVerb("generate", [], "2.0.0", {
                load: async () => {
                    throw new SyntaxError("Unexpected token");
                },
                ...c.io,
            }),
        ).toBe(1);
        expect(c.err()).toContain("could not load @getknext/grpc");
        expect(c.err()).toContain("Unexpected token");
    });
});

describe("semver range check (the grammar core accepts)", () => {
    it.each([
        ["2.0.0", ">=2.0.0-0 <3.0.0", true],
        ["2.0.0-next.0", ">=2.0.0-0 <3.0.0", true],
        ["1.3.0", ">=2.0.0-0 <3.0.0", false],
        ["3.0.0", ">=2.0.0-0 <3.0.0", false],
        ["2.4.1", "^2.0.0", true],
        ["3.0.0", "^2.0.0", false],
        ["0.2.5", "^0.2.0", true],
        ["0.3.0", "^0.2.0", false],
        ["2.0.0", "=2.0.0", true],
        ["2.0.1", "2.0.0", false],
        ["2.0.0", ">2.0.0", false],
        ["2.0.0", "<=2.0.0", true],
    ])("%s satisfies %s: %s", (version, range, expected) => {
        expect(satisfiesRange(version, range)).toBe(expected);
    });

    it("returns undefined for a grammar it does not implement, or a non-version", () => {
        for (const range of ["2.x", "~2.0.0", "2.0.0 || 3.0.0", "*", ""]) {
            expect(satisfiesRange("2.0.0", range), range).toBeUndefined();
        }
        expect(satisfiesRange("latest", ">=2.0.0")).toBeUndefined();
    });
});

describe("the built bin routes generate and add to the package, never to deploy", () => {
    function runBin(args: string[], cwd: string) {
        // Plain node, like a user's `npx knext`: the bin must not need bun.
        return spawnSync("node", [distBin, ...args], {
            cwd,
            encoding: "utf8",
            env: { ...process.env, NODE_OPTIONS: "", NO_COLOR: "1" },
            timeout: 30_000,
        });
    }

    it("without the package installed, `knext generate --check` explains and exits 1", () => {
        const r = runBin(["generate", "--check"], scratch("bin-missing"));
        expect(r.status).toBe(1);
        const all = `${r.stdout}${r.stderr}`;
        expect(all).toContain("@getknext/grpc");
        expect(all).not.toContain("No knext.config.ts found");
        expect(all).not.toContain("FATAL");
    });

    it("loads the package from the app's own node_modules and hands it the argv", () => {
        const app = scratch("bin-installed");
        const dir = join(app, "node_modules", "@getknext", "grpc");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "package.json"),
            JSON.stringify({
                name: "@getknext/grpc",
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
                'export const GRPC_VERSION = "0.1.0";',
                `export const CORE_PEER_RANGE = "=${core.version}";`,
                "export const helpText = (v) => `knext ${v} help`;",
                "export async function run(verb, argv) {",
                '  process.stdout.write(`fake-grpc ${verb} ${argv.join(" ")}\\n`);',
                "  return 5;",
                "}",
            ].join("\n"),
        );
        const r = runBin(["add", "function", "orders", "--lang", "go"], app);
        expect(r.stdout).toContain("fake-grpc add function orders --lang go");
        expect(r.status).toBe(5);
    });
});

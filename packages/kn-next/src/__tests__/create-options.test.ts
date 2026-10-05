/**
 * `knext create` asks for the runtime, builder, cache, storage provider and
 * React Compiler (founder-directed 2026-10-03), and every answer has a flag.
 *
 * Three properties carry the feature, and each has its own block below:
 *
 * 1. GOLDEN — the defaults reproduce today's scaffold byte for byte. "Today's
 *    scaffold" is the raw template rendering (`renderScaffold`, which this
 *    feature does not touch): the option layer must be the identity at the
 *    defaults, for both template families.
 * 2. MAPPING — each non-default answer changes exactly the files it should,
 *    and nothing else. A Node app gets `ioredis` (at the range
 *    @getknext/core itself declares) through renderScaffold's `runtime`
 *    option — the one seam for it; a Bun app gets nothing extra.
 * 3. NO HANG — no TTY, `CI`, `--yes` or any flag means no prompt, ever. Proven
 *    in-process (an asker that throws if called) AND with a real subprocess
 *    whose stdin is an open pipe that is never written: if it prompted, it
 *    would wait forever and the test would time out.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { spawn } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
    cliVersion,
    createMain,
    renderScaffold,
    resolveLayout,
} from "../cli/create";
import {
    applyCreateChoices,
    type CreateChoices,
    choicesToFlags,
    DEFAULT_CREATE_CHOICES,
    type PromptIO,
    parseChoiceFlags,
    promptCreateChoices,
    shouldPrompt,
    templateBuilderFor,
    VINEXT_REACT_COMPILER_DEV_DEPS,
} from "../cli/create-options";
import { validateConfig } from "../cli/validate";
import type { KnativeNextConfig } from "../config";

const PKG_ROOT = resolve(import.meta.dirname, "..", "..");
const CORE_MANIFEST = JSON.parse(
    readFileSync(join(PKG_ROOT, "package.json"), "utf8"),
) as { dependencies: Record<string, string> };

let root: string;
const savedRegistry = process.env.npm_config_registry;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knext-create-options-"));
    // createMain probes the registry for the scaffold's pins after writing;
    // a closed local port keeps these tests offline (connection refused is
    // the probe's silent path).
    process.env.npm_config_registry = "http://127.0.0.1:9";
});
afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (savedRegistry === undefined) delete process.env.npm_config_registry;
    else process.env.npm_config_registry = savedRegistry;
});

function render(choices: Partial<CreateChoices> = {}): Map<string, string> {
    const c = { ...DEFAULT_CREATE_CHOICES, ...choices };
    const files = renderScaffold({
        name: "hello-knext",
        version: "1.3.0",
        builder: templateBuilderFor(c.builder),
        // The runtime goes through renderScaffold's own option — the single
        // seam that adds the Node Redis client — exactly as writeScaffold does.
        runtime: c.runtime,
    });
    return applyCreateChoices(files, c);
}

function pkgOf(files: Map<string, string>): {
    scripts: Record<string, string>;
    dependencies: Record<string, string | undefined>;
    devDependencies: Record<string, string | undefined>;
} {
    return JSON.parse(files.get("package.json") ?? "");
}

/** Active (uncommented) `<key>:` property lines in a TS source. */
function activeKey(source: string, key: string): RegExpMatchArray | null {
    return source.match(new RegExp(`^\\s*${key}\\s*:`, "gm"));
}

/** Capture what createMain writes for one invocation. */
async function capture(
    argv: string[],
    deps: Parameters<typeof createMain>[1] = { stdinIsTTY: false },
): Promise<{ code: number; out: string; err: string }> {
    let out = "";
    let err = "";
    const o = spyOn(process.stdout, "write").mockImplementation((c) => {
        out += String(c);
        return true;
    });
    const e = spyOn(process.stderr, "write").mockImplementation((c) => {
        err += String(c);
        return true;
    });
    try {
        return { code: await createMain(argv, deps), out, err };
    } finally {
        o.mockRestore();
        e.mockRestore();
    }
}

/** Scripted answers; throws if asked more questions than scripted. */
function scripted(answers: string[]): PromptIO & { asked: string[] } {
    const asked: string[] = [];
    let i = 0;
    return {
        asked,
        write() {},
        async ask(q: string) {
            asked.push(q);
            if (i >= answers.length) throw new Error(`unscripted prompt: ${q}`);
            return answers[i++];
        },
    };
}

const NEVER_ASK: PromptIO = {
    write() {},
    ask() {
        throw new Error("prompted on a path that must never prompt");
    },
};

/**
 * Re-baselined (founder-directed, 1.3 line): React Compiler is ON by default,
 * so the default scaffold is today's scaffold PLUS exactly the React Compiler
 * edits — and with it off, byte-identical to today's.
 */
const RC_FILES = {
    turbopack: ["next.config.ts", "package.json"],
    vinext: ["package.json", "vite.config.ts"],
} as const;

describe("golden: the defaults are today's scaffold plus React Compiler, nothing else", () => {
    for (const builder of ["turbopack", "vinext"] as const) {
        const raw = () =>
            renderScaffold({
                name: "hello-knext",
                version: "1.3.0",
                builder: templateBuilderFor(builder),
            });

        it(`${builder}: with React Compiler off, the option layer is the identity`, () => {
            const base = raw();
            const out = applyCreateChoices(new Map(base), {
                ...DEFAULT_CREATE_CHOICES,
                builder,
                reactCompiler: false,
            });
            expect([...out.keys()].sort()).toEqual([...base.keys()].sort());
            for (const [rel, content] of base)
                expect(out.get(rel)).toBe(content);
        });

        it(`${builder}: the defaults change only the React Compiler files`, () => {
            const base = raw();
            const out = applyCreateChoices(new Map(base), {
                ...DEFAULT_CREATE_CHOICES,
                builder,
            });
            const changed = [...out.keys()]
                .filter((rel) => out.get(rel) !== base.get(rel))
                .sort();
            expect(changed).toEqual([...RC_FILES[builder]]);
        });
    }

    it("the default choices are bun / turbopack / no cache / no storage / React Compiler on", () => {
        expect(DEFAULT_CREATE_CHOICES).toEqual({
            runtime: "bun",
            builder: "turbopack",
            cache: "none",
            storage: "none",
            reactCompiler: true,
        });
    });

    it("createMain with no flags and no TTY writes the raw rendering plus React Compiler", async () => {
        const appDir = join(root, "golden-app");
        mkdirSync(appDir);
        // No flags at all (the name comes from the directory), no TTY.
        const { code } = await capture([appDir]);
        expect(code).toBe(0);
        // What the pre-feature CLI wrote: the raw template rendering with the
        // same name, version pin and install command…
        const raw = renderScaffold({
            name: "golden-app",
            version: cliVersion(),
            installCmd: resolveLayout(appDir).installCmd,
        });
        expect(raw.size).toBeGreaterThan(10);
        // …plus the React Compiler edits in exactly these two files.
        const withRc = applyCreateChoices(raw, DEFAULT_CREATE_CHOICES);
        for (const [rel, content] of raw) {
            const got = readFileSync(join(appDir, rel), "utf8");
            if ((RC_FILES.turbopack as readonly string[]).includes(rel)) {
                expect(got).not.toBe(content);
                expect(got).toBe(withRc.get(rel) ?? "");
            } else {
                expect(got).toBe(content);
            }
        }
    });

    it("createMain --no-react-compiler writes exactly the raw template rendering", async () => {
        const appDir = join(root, "golden-off");
        mkdirSync(appDir);
        const { code } = await capture([appDir, "--no-react-compiler"]);
        expect(code).toBe(0);
        const raw = renderScaffold({
            name: "golden-off",
            version: cliVersion(),
            installCmd: resolveLayout(appDir).installCmd,
        });
        for (const [rel, content] of raw) {
            expect(readFileSync(join(appDir, rel), "utf8")).toBe(content);
        }
    });
});

describe("mapping: each answer changes exactly what it should", () => {
    it("each answer touches only its own files", () => {
        const cases: [Partial<CreateChoices>, string[]][] = [
            [{ runtime: "node" }, ["knext.config.ts", "package.json"]],
            [{ cache: "redis" }, ["knext.config.ts"]],
            [
                { runtime: "node", cache: "redis" },
                ["knext.config.ts", "package.json"],
            ],
            [{ builder: "webpack" }, ["knext.config.ts", "package.json"]],
            [{ storage: "gcs" }, ["knext.config.ts"]],
            [{ reactCompiler: true }, ["next.config.ts", "package.json"]],
            [
                { builder: "vinext", reactCompiler: true },
                ["package.json", "vite.config.ts"],
            ],
            [
                { builder: "vinext", runtime: "node" },
                ["knext.config.ts", "package.json"],
            ],
        ];
        for (const [choice, expected] of cases) {
            // Compared against the all-defaults render (React Compiler off) of
            // the same template family (webpack shares turbopack's).
            const base = render({
                builder: choice.builder === "vinext" ? "vinext" : "turbopack",
                reactCompiler: false,
            });
            const out = render({ reactCompiler: false, ...choice });
            const changed = [...out.keys()]
                .filter((rel) => out.get(rel) !== base.get(rel))
                .sort();
            expect({ choice, changed }).toEqual({ choice, changed: expected });
        }
    });

    it('runtime node writes runtime: "node"; bun writes no runtime line', () => {
        expect(render({ runtime: "node" }).get("knext.config.ts")).toContain(
            'runtime: "node",',
        );
        expect(
            activeKey(render().get("knext.config.ts") ?? "", "runtime"),
        ).toBeNull();
        expect(
            activeKey(
                render({ runtime: "node" }).get("knext.config.ts") ?? "",
                "runtime",
            ),
        ).toHaveLength(1);
    });

    it("node (with or without the redis cache) gets ioredis at the range @getknext/core declares", () => {
        const range = CORE_MANIFEST.dependencies.ioredis;
        expect(range).toMatch(/^\^5\./);
        for (const cache of ["redis", "none"] as const) {
            const pkg = pkgOf(render({ runtime: "node", cache }));
            expect(pkg.dependencies.ioredis).toBe(range);
        }
    });

    it("bun adds nothing extra, with or without the redis cache", () => {
        const base = pkgOf(render());
        for (const cache of ["redis", "none"] as const) {
            const pkg = pkgOf(render({ runtime: "bun", cache }));
            expect(pkg.dependencies.ioredis).toBeUndefined();
            expect(pkg.dependencies).toEqual(base.dependencies);
        }
    });

    it("one seam: the option layer never adds ioredis itself", () => {
        // Rendered for bun (no client), then given node + redis answers: if the
        // option layer had its own ioredis path, it would add the client here.
        const bunRendered = renderScaffold({
            name: "hello-knext",
            version: "1.3.0",
            runtime: "bun",
        });
        const out = applyCreateChoices(bunRendered, {
            ...DEFAULT_CREATE_CHOICES,
            runtime: "node",
            cache: "redis",
        });
        expect(pkgOf(out).dependencies.ioredis).toBeUndefined();
    });

    it("node + redis on vinext also gets ioredis and a node start script", () => {
        const pkg = pkgOf(
            render({ builder: "vinext", runtime: "node", cache: "redis" }),
        );
        expect(pkg.dependencies.ioredis).toBe(
            CORE_MANIFEST.dependencies.ioredis,
        );
        expect(pkg.scripts.start).toBe("node .output/server/index.mjs");
        expect(pkgOf(render({ builder: "vinext" })).scripts.start).toBe(
            "bun .output/server/index.mjs",
        );
    });

    it("cache redis writes an active cache block reading REDIS_URL; none writes none", () => {
        const cfg = render({ cache: "redis" }).get("knext.config.ts") ?? "";
        expect(activeKey(cfg, "cache")).toHaveLength(1);
        expect(cfg).toContain('provider: "redis",');
        expect(cfg).toContain("process.env.REDIS_URL");
        expect(
            activeKey(render().get("knext.config.ts") ?? "", "cache"),
        ).toBeNull();
    });

    it('webpack builds with next build --webpack and pins build: "webpack"', () => {
        const files = render({ builder: "webpack" });
        expect(pkgOf(files).scripts.build).toBe("next build --webpack");
        expect(
            activeKey(files.get("knext.config.ts") ?? "", "build"),
        ).toHaveLength(1);
        expect(files.get("knext.config.ts")).toContain('build: "webpack",');
        // Same standalone template family as turbopack.
        expect(files.has("next-adapter.ts")).toBe(true);
        expect(files.has("vite.config.ts")).toBe(false);
        expect(pkgOf(render()).scripts.build).toBe("next build");
    });

    it("vinext scaffolds the vinext template family", () => {
        const files = render({ builder: "vinext" });
        expect(files.has("vite.config.ts")).toBe(true);
        expect(files.get("knext.config.ts")).toContain('build: "vinext",');
    });

    for (const provider of ["gcs", "s3", "minio", "azure"] as const) {
        it(`storage ${provider} writes an active storage block for that provider`, () => {
            const cfg =
                render({ storage: provider }).get("knext.config.ts") ?? "";
            expect(activeKey(cfg, "storage")).toHaveLength(1);
            expect(cfg).toContain(`provider: "${provider}",`);
            // Placeholders, never invented values: deploy's preflight names them.
            expect(cfg).toMatch(/bucket: "<your-[\w-]+>"/);
        });
    }

    it("storage none keeps the block commented out", () => {
        expect(
            activeKey(render().get("knext.config.ts") ?? "", "storage"),
        ).toBeNull();
    });

    for (const builder of ["turbopack", "webpack"] as const) {
        it(`${builder}: React Compiler (on by default) sets reactCompiler and adds the Babel plugin`, () => {
            const files = render({ builder });
            expect(
                activeKey(files.get("next.config.ts") ?? "", "reactCompiler"),
            ).toHaveLength(1);
            expect(files.get("next.config.ts")).toContain(
                "    reactCompiler: true,\n",
            );
            expect(
                pkgOf(files).devDependencies["babel-plugin-react-compiler"],
            ).toBe("^1.0.0");
            const off = render({ builder, reactCompiler: false });
            expect(off.get("next.config.ts")).not.toContain("reactCompiler");
            expect(
                pkgOf(off).devDependencies["babel-plugin-react-compiler"],
            ).toBeUndefined();
        });
    }

    it("vinext: React Compiler (on by default) uses the vite plugin option and the four packages", () => {
        const files = render({ builder: "vinext" });
        const vite = files.get("vite.config.ts") ?? "";
        expect(vite.match(/^\s*react: \{ compiler: true \},$/gm)).toHaveLength(
            1,
        );
        // Inside the vinext(...) plugin call, not some other object.
        expect(vite).toMatch(
            /vinext\(\{\n(\s*\/\/.*\n)*\s*react: \{ compiler: true \},/,
        );
        const dev = pkgOf(files).devDependencies;
        expect(dev["@vitejs/plugin-react"]).toBe("6.1.2");
        expect(dev["babel-plugin-react-compiler"]).toBe("^1.0.0");
        expect(dev["@rolldown/plugin-babel"]).toBe("^0.2.0");
        expect(dev["oxc-transform-react"]).toBe("^0.152.0");
        // vinext ignores next.config's key, so it is not written there.
        expect(files.get("next.config.ts")).not.toContain("reactCompiler");

        const off = render({ builder: "vinext", reactCompiler: false });
        expect(off.get("vite.config.ts")).not.toContain("compiler: true");
        const offDev = pkgOf(off).devDependencies;
        expect(offDev["@vitejs/plugin-react"]).toBe("^6.0.0");
        expect(offDev["babel-plugin-react-compiler"]).toBeUndefined();
        expect(offDev["@rolldown/plugin-babel"]).toBeUndefined();
        expect(offDev["oxc-transform-react"]).toBeUndefined();
    });

    it("a template anchor that is missing or duplicated fails loudly instead of dropping the answer", () => {
        const raw = renderScaffold({ name: "hello-knext", version: "1.3.0" });
        const cfg = raw.get("knext.config.ts") ?? "";
        const registry = '  registry: "ghcr.io/<your-user>",\n';
        const twice = new Map(raw).set(
            "knext.config.ts",
            cfg.replace(registry, registry + registry),
        );
        const none = new Map(raw).set(
            "knext.config.ts",
            cfg.replace(registry, ""),
        );
        const node = { ...DEFAULT_CREATE_CHOICES, runtime: "node" as const };
        expect(() => applyCreateChoices(twice, node)).toThrow(
            /2 copies of the anchor/,
        );
        expect(() => applyCreateChoices(none, node)).toThrow(
            /0 copies of the anchor/,
        );
    });

    it("vinext's React Compiler packages match the documented recipe", () => {
        expect(VINEXT_REACT_COMPILER_DEV_DEPS).toEqual({
            "@vitejs/plugin-react": "6.1.2",
            "babel-plugin-react-compiler": "^1.0.0",
            "@rolldown/plugin-babel": "^0.2.0",
            "oxc-transform-react": "^0.152.0",
        });
        const doc = readFileSync(
            join(
                PKG_ROOT,
                "..",
                "..",
                "apps",
                "docs",
                "content",
                "docs",
                "react-compiler.mdx",
            ),
            "utf8",
        );
        for (const name of Object.keys(VINEXT_REACT_COMPILER_DEV_DEPS))
            expect(doc).toContain(name);
    });

    // @vitejs/plugin-react declares `oxc-transform-react` as a peer at one
    // 0.x MINOR (a caret on 0.x pins the minor), and has moved that minor in
    // a PATCH release (6.1.1 -> 6.1.2 went ^0.145.0 -> ^0.152.0). A caret on
    // the plugin therefore lets npm pick a newer patch whose peer range no
    // longer accepts the scaffold's oxc pin, and `npm install` fails with
    // ERESOLVE on every new vinext app. Pin the plugin exactly so the pair
    // only moves together, in a reviewed change.
    it("vinext's React Compiler pins @vitejs/plugin-react exactly, since its oxc-transform-react peer is a 0.x minor", () => {
        const plugin = VINEXT_REACT_COMPILER_DEV_DEPS["@vitejs/plugin-react"];
        expect(plugin).toMatch(/^\d+\.\d+\.\d+$/);
        expect(VINEXT_REACT_COMPILER_DEV_DEPS["oxc-transform-react"]).toMatch(
            /^\^0\.\d+\.\d+$/,
        );
        const dev = pkgOf(render({ builder: "vinext" })).devDependencies;
        expect(dev["@vitejs/plugin-react"]).toBe(plugin);
    });

    it("every emitted package.json is valid JSON ending in a newline", () => {
        for (const c of [
            { runtime: "node", cache: "redis", reactCompiler: true },
            { builder: "webpack", storage: "s3" },
            { builder: "vinext", runtime: "node", cache: "redis" },
        ] as Partial<CreateChoices>[]) {
            const src = render(c).get("package.json") ?? "";
            expect(() => JSON.parse(src)).not.toThrow();
            expect(src.endsWith("}\n")).toBe(true);
        }
    });
});

describe("mapping: every combination emits a config the validator accepts", () => {
    const runtimes = ["bun", "node"] as const;
    const builders = ["turbopack", "webpack", "vinext"] as const;
    const caches = ["none", "redis"] as const;
    const storages = ["none", "gcs", "s3", "minio", "azure"] as const;
    const savedRedis = process.env.REDIS_URL;
    afterEach(() => {
        if (savedRedis === undefined) delete process.env.REDIS_URL;
        else process.env.REDIS_URL = savedRedis;
    });

    it("every flag combination (120: runtime × builder × cache × storage × React Compiler) loads and validates", async () => {
        process.env.REDIS_URL = "redis://redis.example.svc:6379";
        let n = 0;
        for (const runtime of runtimes)
            for (const builder of builders)
                for (const cache of caches)
                    for (const storage of storages)
                        for (const rc of [true, false]) {
                            // Through the real flag parser, as the CLI does.
                            const c = parseChoiceFlags({
                                runtime,
                                builder,
                                cache,
                                storage,
                                "react-compiler": rc,
                                "no-react-compiler": !rc,
                            });
                            const files = render(c);
                            const dir = join(root, `combo-${n++}`);
                            mkdirSync(dir);
                            const file = join(dir, "knext.config.ts");
                            writeFileSync(
                                file,
                                files.get("knext.config.ts") ?? "",
                            );
                            const cfg = (await import(pathToFileURL(file).href))
                                .default as KnativeNextConfig;
                            expect(() => validateConfig(cfg)).not.toThrow();
                            expect(cfg.runtime).toBe(
                                runtime === "node" ? "node" : undefined,
                            );
                            expect(cfg.build).toBe(
                                builder === "turbopack" ? undefined : builder,
                            );
                            expect(cfg.cache?.provider).toBe(
                                cache === "redis" ? "redis" : undefined,
                            );
                            expect(cfg.storage?.provider).toBe(
                                storage === "none" ? undefined : storage,
                            );
                            const pkg = pkgOf(files);
                            expect(pkg.dependencies.ioredis).toBe(
                                runtime === "node"
                                    ? CORE_MANIFEST.dependencies.ioredis
                                    : undefined,
                            );
                            expect(
                                pkg.devDependencies[
                                    "babel-plugin-react-compiler"
                                ],
                            ).toBe(rc ? "^1.0.0" : undefined);
                        }
        expect(n).toBe(120);
    });

    it("redis without REDIS_URL fails validation loudly instead of deploying a cacheless app", async () => {
        delete process.env.REDIS_URL;
        const file = join(root, "knext.config.ts");
        writeFileSync(
            file,
            render({ cache: "redis" }).get("knext.config.ts") ?? "",
        );
        const cfg = (await import(`${pathToFileURL(file).href}?nourl`))
            .default as KnativeNextConfig;
        expect(() => validateConfig(cfg)).toThrow(/cache\.url/);
    });
});

describe("prompts", () => {
    it("Enter on every prompt takes the defaults", async () => {
        const io = scripted(["", "", "", "", ""]);
        expect(await promptCreateChoices(io)).toEqual(DEFAULT_CREATE_CHOICES);
        expect(io.asked).toHaveLength(5);
    });

    it("answers by number or by name map onto the choices", async () => {
        const io = scripted(["2", "webpack", "redis", "4", "y"]);
        expect(await promptCreateChoices(io)).toEqual({
            runtime: "node",
            builder: "webpack",
            cache: "redis",
            storage: "minio",
            reactCompiler: true,
        });
    });

    it("runtime offers node, and bun is the default", async () => {
        const lines: string[] = [];
        const io: PromptIO = {
            write: (t) => void lines.push(t),
            ask: async () => "",
        };
        await promptCreateChoices(io);
        const text = lines.join("");
        expect(text).toMatch(/bun.*\(default\)/);
        expect(text).toContain("node");
        expect(text).toMatch(/vinext.*Beta/);
    });

    it("an invalid answer is asked again, never guessed", async () => {
        const io = scripted(["deno", "node", "", "", "", ""]);
        const c = await promptCreateChoices(io);
        expect(c.runtime).toBe("node");
        expect(io.asked).toHaveLength(6);
    });

    it("the React Compiler question is asked on vinext too, defaulting to yes", async () => {
        const io = scripted(["", "vinext", "", "", ""]);
        const c = await promptCreateChoices(io);
        expect(c.builder).toBe("vinext");
        expect(c.reactCompiler).toBe(true);
        expect(io.asked).toHaveLength(5);
        expect(io.asked[4]).toContain("[Y/n]");
    });

    it("answering n turns React Compiler off", async () => {
        const c = await promptCreateChoices(scripted(["", "", "", "", "n"]));
        expect(c.reactCompiler).toBe(false);
    });

    for (const reactCompiler of [true, false]) {
        it(`the equivalent flags reproduce the answers non-interactively (React Compiler ${reactCompiler ? "on" : "off"})`, () => {
            const c: CreateChoices = {
                runtime: "node",
                builder: "webpack",
                cache: "redis",
                storage: "s3",
                reactCompiler,
            };
            const flags = choicesToFlags(c).split(" ");
            const parsed = parseChoiceFlags({
                runtime: flags[1],
                builder: flags[3],
                cache: flags[5],
                storage: flags[7],
                "react-compiler": flags[8] === "--react-compiler",
                "no-react-compiler": flags[8] === "--no-react-compiler",
            });
            expect(parsed).toEqual(c);
        });
    }
});

describe("flags", () => {
    it("--builder default stays a backward-compatible alias for turbopack", () => {
        expect(parseChoiceFlags({ builder: "default" }).builder).toBe(
            "turbopack",
        );
    });

    for (const [flag, bad] of [
        ["runtime", "deno"],
        ["builder", "rspack"],
        ["cache", "memcached"],
        ["storage", "r2"],
    ] as const) {
        it(`an unknown --${flag} value is a hard error`, async () => {
            const { code, err } = await capture([root, `--${flag}`, bad]);
            expect(code).toBe(1);
            expect(err).toContain(`--${flag}`);
            expect(existsSync(join(root, "package.json"))).toBe(false);
        });
    }

    it("React Compiler defaults on; --no-react-compiler turns it off; both together is an error", async () => {
        expect(parseChoiceFlags({}).reactCompiler).toBe(true);
        expect(parseChoiceFlags({ "react-compiler": true }).reactCompiler).toBe(
            true,
        );
        expect(
            parseChoiceFlags({ "no-react-compiler": true }).reactCompiler,
        ).toBe(false);
        const { code, err } = await capture([
            root,
            "--react-compiler",
            "--no-react-compiler",
        ]);
        expect(code).toBe(1);
        expect(err).toContain("--no-react-compiler");
        expect(existsSync(join(root, "package.json"))).toBe(false);
    });

    it("--help documents every prompt flag and --yes", async () => {
        const { code, out } = await capture(["--help"]);
        expect(code).toBe(0);
        for (const f of [
            "--runtime",
            "--builder",
            "--cache",
            "--storage",
            "--react-compiler",
            "--no-react-compiler",
            "--yes",
        ])
            expect(out).toContain(f);
    });
});

describe("no TTY / CI never prompts", () => {
    it("shouldPrompt: only a TTY on both ends, no CI, and no flags", () => {
        const tty = { stdinIsTTY: true, stdoutIsTTY: true, env: {} };
        expect(shouldPrompt({ ...tty, flagsGiven: false })).toBe(true);
        expect(shouldPrompt({ ...tty, flagsGiven: true })).toBe(false);
        expect(
            shouldPrompt({ ...tty, stdinIsTTY: false, flagsGiven: false }),
        ).toBe(false);
        expect(
            shouldPrompt({ ...tty, stdoutIsTTY: false, flagsGiven: false }),
        ).toBe(false);
        expect(
            shouldPrompt({ ...tty, env: { CI: "true" }, flagsGiven: false }),
        ).toBe(false);
        expect(
            shouldPrompt({ ...tty, env: { CI: "" }, flagsGiven: false }),
        ).toBe(true);
        expect(
            shouldPrompt({ ...tty, env: { CI: "0" }, flagsGiven: false }),
        ).toBe(true);
    });

    it("a TTY with no flags prompts, and the answers land on disk", async () => {
        const appDir = join(root, "asked");
        mkdirSync(appDir);
        const io = scripted(["node", "", "redis", "", ""]);
        const { code, out } = await capture([appDir], {
            stdinIsTTY: true,
            stdoutIsTTY: true,
            env: {},
            prompt: io,
        });
        expect(code).toBe(0);
        expect(io.asked).toHaveLength(5);
        expect(readFileSync(join(appDir, "knext.config.ts"), "utf8")).toContain(
            'runtime: "node",',
        );
        // The equivalent non-interactive command is printed for CI reuse.
        expect(out).toContain("--runtime node");
    });

    for (const [label, argv, deps] of [
        ["no TTY", [], { stdinIsTTY: false, stdoutIsTTY: false, env: {} }],
        [
            "CI=true",
            [],
            { stdinIsTTY: true, stdoutIsTTY: true, env: { CI: "true" } },
        ],
        ["--yes", ["--yes"], { stdinIsTTY: true, stdoutIsTTY: true, env: {} }],
        ["-y", ["-y"], { stdinIsTTY: true, stdoutIsTTY: true, env: {} }],
        [
            "a flag",
            ["--name", "flagged"],
            { stdinIsTTY: true, stdoutIsTTY: true, env: {} },
        ],
    ] as const) {
        it(`${label}: uses the defaults without asking`, async () => {
            const appDir = join(root, "quiet");
            mkdirSync(appDir);
            const { code } = await capture([appDir, ...argv], {
                ...deps,
                prompt: NEVER_ASK,
            });
            expect(code).toBe(0);
            expect(
                activeKey(
                    readFileSync(join(appDir, "knext.config.ts"), "utf8"),
                    "runtime",
                ),
            ).toBeNull();
        });
    }

    it("a real subprocess with an open, silent stdin pipe exits instead of hanging", async () => {
        const appDir = join(root, "subproc");
        mkdirSync(appDir);
        // stdin is a pipe (not a TTY) that stays OPEN and is never written:
        // a prompt would wait on it forever, and the kill below would fire.
        const child = spawn(
            process.execPath,
            [join(PKG_ROOT, "src", "cli", "deploy.ts"), "create", appDir],
            {
                stdio: ["pipe", "pipe", "pipe"],
                env: {
                    ...process.env,
                    CI: "",
                    npm_config_registry: "http://127.0.0.1:9",
                },
            },
        );
        let killed = false;
        const timer = setTimeout(() => {
            killed = true;
            child.kill("SIGKILL");
        }, 60_000);
        const status = await new Promise<number | null>((res) =>
            child.on("exit", (code) => res(code)),
        );
        clearTimeout(timer);
        child.stdin?.destroy();
        expect(killed).toBe(false);
        expect(status).toBe(0);
        expect(existsSync(join(appDir, "knext.config.ts"))).toBe(true);
    }, 90_000);
});

describe("e2e scaffold: runtime × cache (files only, no deploy)", () => {
    for (const runtime of ["bun", "node"] as const)
        for (const cache of ["none", "redis"] as const) {
            it(`--runtime ${runtime} --cache ${cache}`, async () => {
                const appDir = join(root, `${runtime}-${cache}`);
                mkdirSync(appDir);
                const { code } = await capture([
                    appDir,
                    "--runtime",
                    runtime,
                    "--cache",
                    cache,
                ]);
                expect(code).toBe(0);
                const cfg = readFileSync(
                    join(appDir, "knext.config.ts"),
                    "utf8",
                );
                const pkg = JSON.parse(
                    readFileSync(join(appDir, "package.json"), "utf8"),
                ) as { dependencies: Record<string, string | undefined> };
                expect(activeKey(cfg, "runtime")?.length ?? 0).toBe(
                    runtime === "node" ? 1 : 0,
                );
                expect(activeKey(cfg, "cache")?.length ?? 0).toBe(
                    cache === "redis" ? 1 : 0,
                );
                expect(pkg.dependencies.ioredis).toBe(
                    runtime === "node"
                        ? CORE_MANIFEST.dependencies.ioredis
                        : undefined,
                );
                // The rest of the scaffold is the standard one.
                for (const f of [
                    "next.config.ts",
                    "next-adapter.ts",
                    "src/instrumentation.ts",
                    "cache-handler.js",
                ])
                    expect(existsSync(join(appDir, f))).toBe(true);
            });
        }
});

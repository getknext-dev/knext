/**
 * The routing artifact end to end (ADR-0068 D4.1 condition 10): the adapter's
 * `onBuildComplete` writes it from the OFFICIAL outputs (never Next's internal
 * manifests), the build stages it into the standalone tree, the compiled
 * executable embeds it, and the preload reads it back — from the EMBEDDED root,
 * not from a file on disk next to the binary.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
    buildCdnRoutingArtifact,
    CDN_ROUTING_ARTIFACT_NAME,
    stageCdnRoutingArtifact,
    writeCdnRoutingArtifact,
} from "../adapters/cdn-routing-artifact";
import adapter from "../adapters/next-adapter";
import { classifyDistFiles } from "../adapters/standalone-embed.mjs";
import { edge } from "./cdn-edge-untyped";

/** A minimal ctx: the adapter reads only these fields. */
type BuildCompleteCtx = Parameters<
    NonNullable<typeof adapter.onBuildComplete>
>[0];

const dirs: string[] = [];
function tmp(name: string): string {
    const d = mkdtempSync(join(tmpdir(), `knext-cdn-${name}-`));
    dirs.push(d);
    return d;
}
afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("buildCdnRoutingArtifact", () => {
    it('no middleware output -> middleware "none"', () => {
        expect(
            buildCdnRoutingArtifact({ config: {}, outputs: {}, routing: {} }),
        ).toEqual({
            version: 1,
            basePath: "",
            i18n: null,
            middleware: "none",
            conditional: [],
        });
    });
    it("no routing output at all is recorded as unknown, not as empty", () => {
        expect(
            buildCdnRoutingArtifact({ config: {}, outputs: {} }).conditional,
        ).toBe("unknown");
    });
    it("middleware with matchers -> source + sourceRegex only (has/missing dropped)", () => {
        const a = buildCdnRoutingArtifact({
            config: { basePath: "/app" },
            outputs: {
                middleware: {
                    config: {
                        matchers: [
                            {
                                source: "/dashboard/:path*",
                                sourceRegex: "^/dashboard(?:/.*)?$",
                                // Next's has/missing: dropped by the writer.
                                has: [{ type: "cookie", key: "s" }],
                            },
                        ],
                    },
                },
            },
        });
        expect(a.basePath).toBe("/app");
        expect(a.middleware).toEqual([
            {
                source: "/dashboard/:path*",
                sourceRegex: "^/dashboard(?:/.*)?$",
            },
        ]);
    });
    it("middleware present with NO matchers -> one match-all matcher", () => {
        for (const config of [undefined, {}, { matchers: [] }]) {
            const a = buildCdnRoutingArtifact({
                config: {},
                outputs: { middleware: { config } },
            });
            expect(a.middleware).toEqual([
                { source: "/:path*", sourceRegex: "^.*$" },
            ]);
        }
    });
    it("a matcher with no regexp is widened to match-all, never dropped", () => {
        const a = buildCdnRoutingArtifact({
            config: {},
            outputs: {
                middleware: { config: { matchers: [{ source: "/x" }] } },
            },
        });
        expect(a.middleware).toEqual([
            { source: "/:path*", sourceRegex: "^.*$" },
        ]);
    });
    it("records the i18n locales", () => {
        expect(
            buildCdnRoutingArtifact({
                config: { i18n: { locales: ["en", "fr"] } },
                outputs: {},
            }).i18n,
        ).toEqual({ locales: ["en", "fr"] });
    });
    it("what it writes, the runtime reader accepts, and the verdicts agree", () => {
        const none = edge.parseRoutingArtifact(
            JSON.stringify(
                buildCdnRoutingArtifact({
                    config: {},
                    outputs: {},
                    routing: {},
                }),
            ),
        );
        expect(none).toMatchObject({ ok: true, none: true });
        const all = edge.parseRoutingArtifact(
            JSON.stringify(
                buildCdnRoutingArtifact({
                    config: {},
                    outputs: { middleware: {} },
                    routing: {},
                }),
            ),
        );
        expect(all.ok).toBe(true);
        expect(edge.middlewareMatches(all, "/anything")).toBe(true);
        const some = edge.parseRoutingArtifact(
            JSON.stringify(
                buildCdnRoutingArtifact({
                    config: {},
                    routing: {},
                    outputs: {
                        middleware: {
                            config: {
                                matchers: [
                                    { source: "/d", sourceRegex: "^/d$" },
                                ],
                            },
                        },
                    },
                }),
            ),
        );
        expect(edge.middlewareMatches(some, "/d")).toBe(true);
        expect(edge.middlewareMatches(some, "/e")).toBe(false);
    });
});

describe("onBuildComplete writes the artifact — always", () => {
    const base = {
        buildId: "b1",
        nextVersion: "16.4.0",
        outputs: {
            pages: [],
            appPages: [],
            appRoutes: [],
            pagesApi: [],
            prerenders: [],
            staticFiles: [],
        },
        routing: {},
    };
    it("writes it even for an app with no middleware and no CDN", async () => {
        const distDir = tmp("dist");
        await adapter.onBuildComplete?.({
            ...base,
            distDir,
            config: {},
        } as unknown as BuildCompleteCtx);
        const path = join(distDir, CDN_ROUTING_ARTIFACT_NAME);
        expect(existsSync(path)).toBe(true);
        expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
            version: 1,
            middleware: "none",
        });
    });
    it("records the middleware matchers it is handed", async () => {
        const distDir = tmp("dist");
        await adapter.onBuildComplete?.({
            ...base,
            distDir,
            config: { basePath: "/app" },
            outputs: {
                ...base.outputs,
                middleware: {
                    config: {
                        matchers: [{ source: "/a", sourceRegex: "^/a$" }],
                    },
                },
            },
        } as unknown as BuildCompleteCtx);
        const doc = JSON.parse(
            readFileSync(join(distDir, CDN_ROUTING_ARTIFACT_NAME), "utf8"),
        );
        expect(doc.basePath).toBe("/app");
        expect(doc.middleware).toEqual([{ source: "/a", sourceRegex: "^/a$" }]);
    });
});

describe("stageCdnRoutingArtifact", () => {
    it("copies the artifact next to BUILD_ID in the standalone tree", () => {
        const project = tmp("proj");
        const serverDir = tmp("standalone");
        writeCdnRoutingArtifact(join(project, ".next"), {
            config: {},
            outputs: {},
        });
        expect(stageCdnRoutingArtifact(join(project, ".next"), serverDir)).toBe(
            true,
        );
        expect(
            JSON.parse(
                readFileSync(
                    join(serverDir, ".next", CDN_ROUTING_ARTIFACT_NAME),
                    "utf8",
                ),
            ).version,
        ).toBe(1);
    });
    it("reports false (and writes nothing) when the build produced none", () => {
        const project = tmp("proj");
        const serverDir = tmp("standalone");
        mkdirSync(join(project, ".next"));
        expect(stageCdnRoutingArtifact(join(project, ".next"), serverDir)).toBe(
            false,
        );
        expect(existsSync(join(serverDir, ".next"))).toBe(false);
    });
});

describe("the compiled executable embeds it (D11)", () => {
    it("classifies knext-cdn-routing.json as an embedded fs-read asset, not disk", () => {
        const cls = classifyDistFiles([
            "BUILD_ID",
            CDN_ROUTING_ARTIFACT_NAME,
            "server/app/page.js",
            "static/a.js",
        ]);
        expect(cls.assets).toContain(CDN_ROUTING_ARTIFACT_NAME);
        expect(cls.disk).not.toContain(CDN_ROUTING_ARTIFACT_NAME);
        expect(cls.unknownKinds).not.toContain(CDN_ROUTING_ARTIFACT_NAME);
    });

    it("a compiled binary run from an EMPTY dir reads the artifact from the embedded $bunfs root", async () => {
        const src = tmp("src");
        mkdirSync(join(src, ".next"), { recursive: true });
        writeCdnRoutingArtifact(join(src, ".next"), {
            config: {},
            routing: {},
            outputs: {
                middleware: {
                    config: {
                        matchers: [{ source: "/d", sourceRegex: "^/d$" }],
                    },
                },
            },
        });
        writeFileSync(join(src, ".next", "BUILD_ID"), "build-embedded");
        // The assets entry: every fs-read file under .next, as `type: "file"` imports
        // (the mechanism standalone-compile.mjs uses). The BUILD_ID has no extension,
        // so Bun names it `BUILD_ID.`; the preload tries both spellings.
        writeFileSync(
            join(src, "assets.mjs"),
            `import a from "./.next/${CDN_ROUTING_ARTIFACT_NAME}" with { type: "file" };\n` +
                'import b from "./.next/BUILD_ID" with { type: "file" };\n' +
                "export default [a, b];\n",
        );
        const cdnEdge = resolve(
            import.meta.dirname,
            "../adapters/cdn-edge.cjs",
        );
        writeFileSync(
            join(src, "main.cjs"),
            `const edge = require(${JSON.stringify(cdnEdge)});\n` +
                "const c = edge.createController({ env: { KNEXT_CDN_PROVIDER: 'cloudflare', KNEXT_CDN_TAG_PREFIX: 'abcdef012345' },\n" +
                "  log: () => {}, warn: () => {} });\n" +
                "const a = c.ensureArtifact();\n" +
                "console.log('RESULT ' + JSON.stringify({ argv1: process.argv[1], ok: a.ok, none: a.none, matchAll: a.matchAll,\n" +
                "  matches: a.ok ? edge.middlewareMatches(a, '/d') : null, other: a.ok ? edge.middlewareMatches(a, '/e') : null }));\n",
        );
        const out = tmp("out");
        const built = await Bun.build({
            entrypoints: [join(src, "main.cjs"), join(src, "assets.mjs")],
            root: src,
            naming: {
                entry: "[dir]/[name].[ext]",
                asset: "[dir]/[name].[ext]",
            },
            target: "bun",
            format: "cjs",
            compile: { outfile: join(out, "app") },
        });
        expect(built.success).toBe(true);
        const runDir = tmp("run");
        const binary = join(runDir, "app");
        copyFileSync(join(out, "app"), binary);
        rmSync(src, { recursive: true, force: true }); // nothing on disk to find
        expect(existsSync(join(runDir, ".next"))).toBe(false);
        const r = spawnSync(binary, [], {
            cwd: runDir,
            encoding: "utf8",
            timeout: 60_000,
            env: {
                PATH: process.env.PATH ?? "",
                TMPDIR: runDir,
            } as unknown as NodeJS.ProcessEnv,
        });
        expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
        const result = JSON.parse(
            /^RESULT (.*)$/m.exec(r.stdout)?.[1] ?? "null",
        );
        expect(result.argv1).toMatch(/\$bunfs\/root\//); // it really ran from the embedded fs
        expect(result).toMatchObject({
            ok: true,
            none: false,
            matches: true,
            other: false,
        });
    }, 120_000);

    it("the same binary with NO artifact embedded fails closed", async () => {
        const src = tmp("src");
        mkdirSync(join(src, ".next"), { recursive: true });
        const cdnEdge = resolve(
            import.meta.dirname,
            "../adapters/cdn-edge.cjs",
        );
        writeFileSync(
            join(src, "main.cjs"),
            `const edge = require(${JSON.stringify(cdnEdge)});\n` +
                "const c = edge.createController({ env: { KNEXT_CDN_PROVIDER: 'cloudflare', KNEXT_CDN_TAG_PREFIX: 'abcdef012345' },\n" +
                "  log: () => {}, warn: () => {} });\n" +
                "console.log('RESULT ' + JSON.stringify(c.ensureArtifact()));\n",
        );
        const out = tmp("out");
        const built = await Bun.build({
            entrypoints: [join(src, "main.cjs")],
            root: src,
            naming: "[dir]/[name].[ext]",
            target: "bun",
            format: "cjs",
            compile: { outfile: join(out, "app") },
        });
        expect(built.success).toBe(true);
        const runDir = tmp("run");
        const r = spawnSync(join(out, "app"), [], {
            cwd: runDir,
            encoding: "utf8",
            timeout: 60_000,
            env: {
                PATH: process.env.PATH ?? "",
            } as unknown as NodeJS.ProcessEnv,
        });
        expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
        expect(
            JSON.parse(/^RESULT (.*)$/m.exec(r.stdout)?.[1] ?? "null"),
        ).toMatchObject({ ok: false });
    }, 120_000);
});

/**
 * The standalone runtime image under a deliberate monorepo root.
 *
 * The Docker build context is the tracing root (the workspace root), and the
 * traced tree mirrors it: the app's server lives at
 * `.next/standalone/<app path>/server.js`, with its `.next/static`, `public` and
 * compiled executable beside it. The staged `Dockerfile.standalone` therefore
 * has to name the app's path in every COPY source, in the destination that puts
 * static assets and public files next to the server, and in the paths the
 * supervisor and the compile-cache bake start from.
 *
 * Flat staging is pinned the other way round: BYTE-IDENTICAL to the template.
 * That is what "the flat layout's behaviour is unchanged" means for an image
 * recipe, and it is why nesting is done by an anchored rewrite at staging time
 * rather than by a template variable (the flat template carries no placeholders,
 * and every guard that reads it stays valid).
 */

import { afterAll, describe, expect, it } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    nestStandaloneDockerfile,
    runtimeStandaloneTemplateDir,
    stageStandaloneBuildContext,
    standaloneDockerignore,
} from "../cli/runtime-image";

const tempRoots: string[] = [];
afterAll(() => {
    for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "knext-img-nested-")));
    tempRoots.push(base);
    for (const [rel, contents] of Object.entries(files)) {
        const abs = join(base, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, contents);
    }
    return base;
}

const TEMPLATE = readFileSync(
    join(runtimeStandaloneTemplateDir(), "Dockerfile.standalone.hbs"),
    "utf8",
);

const WEB_CONFIG = `const path = require("node:path");
module.exports = {
    output: "standalone",
    outputFileTracingRoot: path.join(__dirname, "..", ".."),
    turbopack: { root: path.join(__dirname, "..", "..") },
};
`;

/** The instruction lines (comments and blanks dropped, continuations joined) of one stage. */
function stage(dockerfile: string, name: string): string[] {
    const start = dockerfile.search(new RegExp(`^FROM .* AS ${name}$`, "m"));
    expect(start, `no ${name} stage`).toBeGreaterThan(-1);
    const rest = dockerfile.slice(start);
    const next = rest.indexOf("\nFROM ", 1);
    const body = next === -1 ? rest : rest.slice(0, next);
    return body
        .replace(/\\\n/g, " ")
        .split("\n")
        .map((l) => l.replace(/\s+/g, " ").trim())
        .filter((l) => l !== "" && !l.startsWith("#"));
}

function stageNested(files: Record<string, string> = {}) {
    const root = tree({
        "package.json": "{}",
        "apps/web/package.json": "{}",
        "apps/web/next.config.js": WEB_CONFIG,
        ...files,
    });
    const app = join(root, "apps", "web");
    const { dockerfile } = stageStandaloneBuildContext({
        cwd: app,
        buildContext: root,
    });
    return { root, app, dockerfile, text: readFileSync(dockerfile, "utf8") };
}

describe("staging the standalone Dockerfile for a monorepo root", () => {
    it("standalone-bun: every COPY source carries the app's path, and static/public/exec land beside the nested server", () => {
        const { text } = stageNested();
        const lines = stage(text, "standalone-bun");
        expect(lines).toContain(
            "COPY apps/web/.next/standalone /app/.next/standalone",
        );
        expect(lines).toContain(
            "COPY apps/web/.next/static /app/.next/standalone/apps/web/.next/static",
        );
        expect(lines).toContain(
            "COPY apps/web/public /app/.next/standalone/apps/web/public",
        );
        expect(lines).toContain(
            "COPY apps/web/knext-standalone-exec-linux-x64 /app/.next/standalone/apps/web/knext-standalone-exec",
        );
        const env = lines.find((l) => l.startsWith("ENV PORT=")) ?? "";
        expect(env).toContain(
            "STANDALONE_SERVER_PATH=/app/.next/standalone/apps/web/server.js",
        );
        expect(env).toContain(
            "STANDALONE_SERVER_EXEC=/app/.next/standalone/apps/web/knext-standalone-exec",
        );
        // Nothing still names the flat location.
        expect(lines.join("\n")).not.toContain(
            "/app/.next/standalone/server.js",
        );
        expect(lines).not.toContain(
            "COPY .next/standalone /app/.next/standalone",
        );
    });

    it("standalone-node: the same, and the compile cache sits where the supervisor derives it from the server path", () => {
        const { text } = stageNested();
        const lines = stage(text, "standalone-node");
        expect(lines).toContain(
            "COPY apps/web/.next/standalone /app/.next/standalone",
        );
        expect(lines).toContain(
            "COPY apps/web/.next/static /app/.next/standalone/apps/web/.next/static",
        );
        expect(lines).toContain(
            "COPY apps/web/public /app/.next/standalone/apps/web/public",
        );
        const joined = lines.join("\n");
        expect(joined).toContain(
            "STANDALONE_SERVER_PATH=/app/.next/standalone/apps/web/server.js",
        );
        // `node-server.ts` derives <serverDir>/.next/compile-cache; the image's
        // NODE_COMPILE_CACHE, its mkdir/chown and the bake's size check must
        // all be that same directory.
        expect(joined).toContain(
            "NODE_COMPILE_CACHE=/app/.next/standalone/apps/web/.next/compile-cache",
        );
        expect(joined).toContain(
            "mkdir -p /app/.next/standalone/apps/web/.next/compile-cache",
        );
        expect(joined).not.toContain(
            "/app/.next/standalone/.next/compile-cache",
        );
    });

    it("standalone-bun-self-contained: public, static and the executable are read from the app's path", () => {
        const { text } = stageNested();
        const lines = stage(text, "standalone-bun-self-contained");
        expect(lines).toContain("COPY apps/web/public /app/public");
        expect(lines).toContain("COPY apps/web/.next/static /app/.next/static");
        expect(lines).toContain(
            "COPY apps/web/knext-standalone-exec-linux-x64 /app/knext-standalone-exec",
        );
        expect(lines).not.toContain("COPY public /app/public");
    });

    it("the disk stages route Next's runtime cache dir through the path the operator mounts writable", () => {
        const { text } = stageNested();
        for (const name of ["standalone-bun", "standalone-node"]) {
            const run = stage(text, name).find((l) =>
                l.includes("ln -s /app/.next/standalone/.next/cache"),
            );
            expect(run, `${name} has no cache link`).toBeDefined();
            expect(run).toContain("mkdir -p /app/.next/standalone/.next/cache");
            expect(run).toContain("/app/.next/standalone/apps/web/.next/cache");
        }
    });

    it("the @getknext/core COPY reads the hoisted install at the workspace root", () => {
        const { text } = stageNested({
            "node_modules/@getknext/core/package.json": "{}",
        });
        expect(stage(text, "standalone-bun")).toContain(
            "COPY node_modules/@getknext/core /app/node_modules/@getknext/core",
        );
    });

    it("the @getknext/core COPY prefers the app's own install when it has one", () => {
        const { text } = stageNested({
            "node_modules/@getknext/core/package.json": "{}",
            "apps/web/node_modules/@getknext/core/package.json": "{}",
        });
        for (const name of ["standalone-bun", "standalone-node"]) {
            expect(stage(text, name)).toContain(
                "COPY apps/web/node_modules/@getknext/core /app/node_modules/@getknext/core",
            );
        }
    });

    it("an app path the Dockerfile cannot quote is refused, not mangled", () => {
        expect(() =>
            nestStandaloneDockerfile(TEMPLATE, {
                contextPrefix: "my apps/web/",
                coreSrc: "node_modules/@getknext/core",
            }),
        ).toThrow(/whitespace|quote/i);
    });

    it("refuses to rewrite a Dockerfile whose anchors have drifted, rather than ship half a rewrite", () => {
        expect(() =>
            nestStandaloneDockerfile("FROM scratch\nCOPY . .\n", {
                contextPrefix: "apps/web/",
                coreSrc: "node_modules/@getknext/core",
            }),
        ).toThrow(/anchor|expected/i);
        const drifted = TEMPLATE.replace(
            "COPY .next/standalone /app/.next/standalone",
            "COPY .next/standalone /app/.next/standalone-x",
        );
        expect(drifted).not.toBe(TEMPLATE);
        expect(() =>
            nestStandaloneDockerfile(drifted, {
                contextPrefix: "apps/web/",
                coreSrc: "node_modules/@getknext/core",
            }),
        ).toThrow(/anchor|expected/i);
    });

    it("refuses a build context that is not the explicit tracing root", () => {
        const root = tree({
            "package.json": "{}",
            "apps/web/package.json": "{}",
            "apps/web/next.config.js": WEB_CONFIG,
        });
        expect(() =>
            stageStandaloneBuildContext({
                cwd: join(root, "apps", "web"),
                buildContext: join(root, "apps"),
            }),
        ).toThrow(/build context/i);
    });

    it("keeps app-level Next caches out of the workspace-root build context", () => {
        const { app } = stageNested();
        const ignore = readFileSync(
            join(app, "Dockerfile.standalone.dockerignore"),
            "utf8",
        );
        expect(ignore).toContain("**/.next/cache");
    });
});

describe("staging the standalone Dockerfile for the flat layout", () => {
    it("is byte-identical to the template: nothing about flat staging changed", () => {
        const app = tree({ "package.json": "{}" });
        const { dockerfile } = stageStandaloneBuildContext({
            cwd: app,
            buildContext: app,
        });
        expect(readFileSync(dockerfile, "utf8")).toBe(TEMPLATE);
        expect(readFileSync(`${dockerfile}.dockerignore`, "utf8")).toBe(
            standaloneDockerignore(),
        );
    });

    it("an ACCIDENTAL parent root (a stray lockfile, no explicit config) stages the flat Dockerfile", () => {
        const base = tree({
            "package-lock.json": "{}",
            "app/package.json": "{}",
            "app/next.config.js":
                'module.exports = { output: "standalone" };\n',
        });
        const app = join(base, "app");
        const { dockerfile } = stageStandaloneBuildContext({
            cwd: app,
            buildContext: app,
        });
        expect(readFileSync(dockerfile, "utf8")).toBe(TEMPLATE);
    });
});

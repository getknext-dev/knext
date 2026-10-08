/**
 * `buildStandaloneExecutable` under a deliberate monorepo root.
 *
 * The compile script already understands a server that sits deeper than the
 * traced tree (`--server` names the entry, `--root` the tree it is confined to).
 * What the CLI must do is pass them apart: the entry is the NESTED server, the
 * root is the whole `.next/standalone` tree. Passing the nested directory as the
 * root would confine the module graph to the app and drop every traced workspace
 * package; passing the flat path would look for a server that is not there.
 */

import { afterAll, describe, expect, it } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildStandaloneExecutable } from "../cli/standalone-exec-build";

const tempRoots: string[] = [];
afterAll(() => {
    for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
    const base = realpathSync(
        mkdtempSync(join(tmpdir(), "knext-exec-nested-")),
    );
    tempRoots.push(base);
    for (const [rel, contents] of Object.entries(files)) {
        const abs = join(base, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, contents);
    }
    return base;
}

const WEB_CONFIG = `const path = require("node:path");
module.exports = {
    output: "standalone",
    outputFileTracingRoot: path.join(__dirname, "..", ".."),
};
`;

/** A compile run that produces a bytecode artifact for the CLI's own marker. */
function fakeRun(argvs: string[][]) {
    return (a: readonly string[]) => {
        argvs.push([...a]);
    };
}
function bytecodeArtifact(argv: string[]): Buffer {
    const marker = argv[argv.indexOf("--marker") + 1];
    return Buffer.from(
        `ELF…pool:${marker}…// @bun @bytecode @bun-cjs\n(function(){globalThis.m="${marker}";})`,
        "latin1",
    );
}

describe("buildStandaloneExecutable with a deliberate monorepo root", () => {
    it("hands the compile script the NESTED server and the WHOLE standalone tree as its root", () => {
        const base = tree({
            "package.json": "{}",
            "apps/web/package.json": "{}",
            "apps/web/next.config.js": WEB_CONFIG,
            "apps/web/.next/standalone/apps/web/server.js": "// nested\n",
            "apps/web/.next/standalone/packages/shared/note.txt": "x\n",
        });
        const cwd = join(base, "apps", "web");
        const argvs: string[][] = [];
        const out = buildStandaloneExecutable({
            cwd,
            arch: "linux-x64",
            bunVersion: "1.4.2",
            run: fakeRun(argvs),
            readArtifact: () => bytecodeArtifact(argvs[0]),
        });
        const argv = argvs[0];
        expect(argv[argv.indexOf("--server") + 1]).toBe(
            join(cwd, ".next", "standalone", "apps", "web", "server.js"),
        );
        expect(argv[argv.indexOf("--root") + 1]).toBe(
            join(cwd, ".next", "standalone"),
        );
        // The executable lands in the APP directory (the Docker context names it
        // under the app's path); the image places it beside the nested server.
        expect(out).toBe(join(cwd, "knext-standalone-exec-linux-x64"));
    });

    it("a missing nested server fails before compiling and names the nested path", () => {
        const base = tree({
            "package.json": "{}",
            "apps/web/package.json": "{}",
            "apps/web/next.config.js": WEB_CONFIG,
        });
        const cwd = join(base, "apps", "web");
        const argvs: string[][] = [];
        let message = "";
        try {
            buildStandaloneExecutable({
                cwd,
                arch: "linux-x64",
                bunVersion: "1.4.2",
                run: fakeRun(argvs),
            });
        } catch (e) {
            message = (e as Error).message;
        }
        expect(message).toContain(
            join(".next", "standalone", "apps", "web", "server.js"),
        );
        expect(argvs).toHaveLength(0);
    });

    it("flat layout: --server is .next/standalone/server.js and --root is .next/standalone, as before", () => {
        const base = tree({
            "app/package.json": "{}",
            "app/.next/standalone/server.js": "// flat\n",
        });
        const cwd = join(base, "app");
        const argvs: string[][] = [];
        buildStandaloneExecutable({
            cwd,
            arch: "linux-x64",
            bunVersion: "1.4.2",
            run: fakeRun(argvs),
            readArtifact: () => bytecodeArtifact(argvs[0]),
        });
        const argv = argvs[0];
        expect(argv[argv.indexOf("--server") + 1]).toBe(
            join(cwd, ".next", "standalone", "server.js"),
        );
        expect(argv[argv.indexOf("--root") + 1]).toBe(
            join(cwd, ".next", "standalone"),
        );
    });
});

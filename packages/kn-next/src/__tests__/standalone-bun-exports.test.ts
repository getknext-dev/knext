/**
 * #188 round 2 (bun-lane run 28612654960) — heal Bun-condition export targets
 * in the standalone output.
 *
 * NAMED EXCEPTION (from the round-1 server-log surfacing, getserversideprops +
 * module-layer shards):
 *   ⨯ Error: Failed to load external module react-dom/server: ResolveMessage:
 *     Cannot find module 'react-dom/server' from '…/.next/standalone/.next/
 *     server/chunks/ssr/[root-of-the-server]__….js'
 *
 * ROOT CAUSE (reproduced locally at the resolver level): `next build` runs
 * under Node, so output-file-tracing copies only the export targets Node's
 * conditions resolve (react-dom/server → server.node.js). react-dom's exports
 * map ALSO carries a "bun" condition (./server → ./server.bun.js) — a file the
 * published package ships but the traced standalone tree does NOT. Bun's
 * resolver picks the "bun" condition, finds the mapped file missing, and fails
 * the whole specifier (it does not fall back to "node"), so every pages-router
 * SSR/API render 500s under Bun while Node serves fine.
 *
 * FIX: after the build, copy any missing "bun"-condition export targets (and
 * their same-package relative requires) from the app's real node_modules into
 * the standalone copy. Pure additive file copies — the Node lane's resolution
 * is untouched.
 */

import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { healBunExportTargets } from "../adapters/standalone-bun-exports";

/** Lay down a fake package dir. */
function writePkg(
    dir: string,
    pkg: Record<string, unknown>,
    files: Record<string, string>,
) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
    for (const [rel, content] of Object.entries(files)) {
        const abs = join(dir, rel);
        mkdirSync(join(abs, ".."), { recursive: true });
        writeFileSync(abs, content);
    }
}

const FAKE_RD = {
    name: "fake-react-dom",
    version: "19.9.9",
    exports: {
        "./server": {
            bun: "./server.bun.js",
            node: "./server.node.js",
            default: "./server.node.js",
        },
    },
};

/** A project with a full package + a standalone tree traced Node-only. */
function seed({
    pnpmLayout = false,
    standaloneVersion = "19.9.9",
}: {
    pnpmLayout?: boolean;
    standaloneVersion?: string;
} = {}) {
    const root = mkdtempSync(join(tmpdir(), "knext-bun-exports-"));
    const projectDir = join(root, "app");

    // the REAL installed package (ships the bun files)
    writePkg(join(projectDir, "node_modules/fake-react-dom"), FAKE_RD, {
        "server.node.js": "module.exports = 'node';\n",
        "server.bun.js":
            "module.exports = require('./cjs/impl.bun.production.js');\n",
        "cjs/impl.bun.production.js": "module.exports = 'bun';\n",
    });

    // the traced standalone copy (Node conditions only)
    const standaloneDir = join(projectDir, ".next/standalone");
    const standalonePkgDir = pnpmLayout
        ? join(
              standaloneDir,
              "node_modules/.pnpm/fake-react-dom@19.9.9/node_modules/fake-react-dom",
          )
        : join(standaloneDir, "node_modules/fake-react-dom");
    writePkg(
        standalonePkgDir,
        { ...FAKE_RD, version: standaloneVersion },
        { "server.node.js": "module.exports = 'node';\n" },
    );

    return { projectDir, standaloneDir, standalonePkgDir };
}

describe("healBunExportTargets — standalone bun-condition export heal (#188)", () => {
    it("copies the missing bun-condition target AND its same-package relative requires", () => {
        const { projectDir, standaloneDir, standalonePkgDir } = seed();
        const result = healBunExportTargets({ projectDir, standaloneDir });
        expect(existsSync(join(standalonePkgDir, "server.bun.js"))).toBe(true);
        expect(
            existsSync(join(standalonePkgDir, "cjs/impl.bun.production.js")),
        ).toBe(true);
        expect(result.copied).toContain("fake-react-dom/server.bun.js");
        // byte-identical copies from the source package
        expect(
            readFileSync(join(standalonePkgDir, "server.bun.js"), "utf8"),
        ).toBe(
            readFileSync(
                join(projectDir, "node_modules/fake-react-dom/server.bun.js"),
                "utf8",
            ),
        );
    });

    it("handles the pnpm standalone layout (.pnpm/<id>/node_modules/<pkg>)", () => {
        const { projectDir, standaloneDir, standalonePkgDir } = seed({
            pnpmLayout: true,
        });
        healBunExportTargets({ projectDir, standaloneDir });
        expect(existsSync(join(standalonePkgDir, "server.bun.js"))).toBe(true);
    });

    it("skips on version mismatch between standalone copy and source package", () => {
        const { projectDir, standaloneDir, standalonePkgDir } = seed({
            standaloneVersion: "18.0.0",
        });
        const result = healBunExportTargets({ projectDir, standaloneDir });
        expect(existsSync(join(standalonePkgDir, "server.bun.js"))).toBe(false);
        expect(result.skipped.some((s) => s.includes("version mismatch"))).toBe(
            true,
        );
    });

    it("no-ops for packages without bun-condition exports and for targets already present", () => {
        const { projectDir, standaloneDir } = seed();
        const first = healBunExportTargets({ projectDir, standaloneDir });
        expect(first.copied.length).toBeGreaterThan(0);
        // idempotent: second run copies nothing
        const second = healBunExportTargets({ projectDir, standaloneDir });
        expect(second.copied).toEqual([]);
    });

    it("never throws on a missing/absent standalone tree (build must not die)", () => {
        const root = mkdtempSync(join(tmpdir(), "knext-bun-exports-none-"));
        expect(() =>
            healBunExportTargets({
                projectDir: root,
                standaloneDir: join(root, "does-not-exist"),
            }),
        ).not.toThrow();
    });
});

describe("adapter wiring", () => {
    it("next-adapter onBuildComplete invokes the heal AND logs when the standalone dir is absent", () => {
        const src = readFileSync(
            resolve(import.meta.dirname, "../adapters/next-adapter.ts"),
            "utf8",
        );
        expect(src).toContain("healBunExportTargets");
        // Round-3 evidence (run 28616072395): onBuildComplete fires BEFORE
        // next emits .next/standalone, so the adapter-side heal silently
        // no-oped. It must say so — silence cost a CI round.
        expect(src).toContain("bun-exports heal skipped");
    });
});

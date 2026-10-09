/**
 * `resolveStandaloneLayout`: where does `next build` put the standalone server
 * for this app?
 *
 * Only an EXPLICIT `outputFileTracingRoot` / `turbopack.root` that names a
 * strict ancestor of the app enables nested mode (`.next/standalone/<app path
 * under that root>/server.js`). A root Next merely INFERRED from a parent
 * lockfile never does: that case is the accidental one, and it keeps failing
 * with the actionable error in `standalone-layout.test.ts`.
 *
 * Both halves are pinned in each direction, because a resolver that returns
 * "nested" for the accidental case would quietly package a tree the app never
 * meant to root there.
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
import { resolveStandaloneLayout } from "../cli/standalone-layout";

const tempRoots: string[] = [];
afterAll(() => {
    for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "knext-resolver-")));
    tempRoots.push(base);
    for (const [rel, contents] of Object.entries(files)) {
        const abs = join(base, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, contents);
    }
    return base;
}

const configWith = (body: string) =>
    `const path = require("node:path");\nmodule.exports = { output: "standalone", ${body} };\n`;

describe("resolveStandaloneLayout", () => {
    it("no explicit root -> flat: the server is at .next/standalone/server.js", () => {
        const base = tree({ "app/package.json": "{}" });
        const layout = resolveStandaloneLayout(join(base, "app"));
        expect(layout.nested).toBe(false);
        expect(layout.appRel).toBe("");
        expect(layout.contextPrefix).toBe("");
        expect(layout.serverPath).toBe(
            join(base, "app", ".next", "standalone", "server.js"),
        );
        expect(layout.serverDir).toBe(join(base, "app", ".next", "standalone"));
    });

    it("a stray parent lockfile with NO explicit config is accidental -> still flat", () => {
        const base = tree({
            "package-lock.json": "{}",
            "app/next.config.js": configWith(""),
        });
        const layout = resolveStandaloneLayout(join(base, "app"));
        expect(layout.nested).toBe(false);
        expect(layout.appRel).toBe("");
    });

    it("a pnpm-workspace.yaml / workspaces field alone does not enable nested mode", () => {
        const base = tree({
            "pnpm-workspace.yaml": "packages: ['apps/*']\n",
            "package.json": JSON.stringify({ workspaces: ["apps/*"] }),
            "apps/web/next.config.js": configWith(""),
        });
        expect(resolveStandaloneLayout(join(base, "apps", "web")).nested).toBe(
            false,
        );
    });

    it("outputFileTracingRoot set above the app -> nested, with the app's path under that root", () => {
        const base = tree({
            "package.json": "{}",
            "apps/web/next.config.js": configWith(
                'outputFileTracingRoot: path.join(__dirname, "..", "..")',
            ),
        });
        const app = join(base, "apps", "web");
        const layout = resolveStandaloneLayout(app);
        expect(layout.nested).toBe(true);
        expect(layout.root).toBe(base);
        expect(layout.appRel).toBe("apps/web");
        expect(layout.contextPrefix).toBe("apps/web/");
        expect(layout.serverPath).toBe(
            join(app, ".next", "standalone", "apps", "web", "server.js"),
        );
        expect(layout.serverDir).toBe(
            join(app, ".next", "standalone", "apps", "web"),
        );
        expect(layout.standaloneDir).toBe(join(app, ".next", "standalone"));
    });

    it("turbopack.root alone, set above the app, is explicit too", () => {
        const base = tree({
            "package.json": "{}",
            "apps/web/next.config.js": configWith(
                'turbopack: { root: path.resolve(__dirname, "../..") }',
            ),
        });
        const layout = resolveStandaloneLayout(join(base, "apps", "web"));
        expect(layout.nested).toBe(true);
        expect(layout.appRel).toBe("apps/web");
    });

    it("a root pinned AT the app (what the scaffold writes) -> flat, even beside a parent lockfile", () => {
        const base = tree({
            "package-lock.json": "{}",
            "app/next.config.js": configWith(
                "outputFileTracingRoot: __dirname",
            ),
        });
        const layout = resolveStandaloneLayout(join(base, "app"));
        expect(layout.nested).toBe(false);
        expect(layout.appRel).toBe("");
    });

    it("an explicit root that is not an ancestor of the app is not nested mode", () => {
        const base = tree({
            "app/next.config.js": configWith(
                'outputFileTracingRoot: "/somewhere/else"',
            ),
        });
        expect(resolveStandaloneLayout(join(base, "app")).nested).toBe(false);
    });

    it("a root expression knext cannot evaluate is not read as a deliberate root", () => {
        const base = tree({
            "package.json": "{}",
            "apps/web/next.config.js": configWith(
                "outputFileTracingRoot: process.env.WORKSPACE_ROOT",
            ),
        });
        expect(resolveStandaloneLayout(join(base, "apps", "web")).nested).toBe(
            false,
        );
    });
});

/**
 * The scaffolded `next.config.ts` pins the tracing root to the app directory.
 *
 * Without it, Next.js infers the workspace root by walking up to the outermost
 * lockfile. The documented getting-started path installs `@getknext/core` in a
 * parent directory and scaffolds the app into a child, which leaves a parent
 * lockfile — so Next moves the root up and writes the standalone server to
 * `.next/standalone/<app>/server.js`, and the first `knext build` fails.
 *
 * Pinning is only worth anything if knext's OWN root resolution agrees with it
 * (the docker build context is derived from the same config), so the guard
 * renders the real template, drops it into an app directory UNDER a parent
 * lockfile, and asks the production resolver where the root is.
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
import { join } from "node:path";
import { renderScaffold } from "../cli/create";
import {
    configuredTracingRoot,
    requireBuildContext,
} from "../cli/tracing-root";

const tempRoots: string[] = [];
afterAll(() => {
    for (const d of tempRoots) rmSync(d, { recursive: true, force: true });
});

/** An app dir UNDER a parent that carries a lockfile, holding the rendered config. */
function appUnderParentLockfile(
    builder: "default" | "vinext",
    runtime: "bun" | "node",
): { base: string; app: string; config: string } {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "knext-scaffold-")));
    tempRoots.push(base);
    writeFileSync(join(base, "package-lock.json"), "{}");
    const app = join(base, "my-app");
    mkdirSync(app, { recursive: true });
    const config = renderScaffold({
        name: "my-app",
        version: "1.3.0",
        builder,
        runtime,
    }).get("next.config.ts");
    if (config === undefined) throw new Error("no next.config.ts rendered");
    writeFileSync(join(app, "next.config.ts"), config);
    return { base, app, config };
}

describe("scaffolded next.config.ts pins the tracing root to the app dir", () => {
    for (const builder of ["default", "vinext"] as const) {
        for (const runtime of ["bun", "node"] as const) {
            it(`${builder} x ${runtime}: sets outputFileTracingRoot, and knext resolves it to the app dir despite a parent lockfile`, () => {
                const { app, config } = appUnderParentLockfile(
                    builder,
                    runtime,
                );
                expect(config).toMatch(/outputFileTracingRoot\s*:/);
                // Resolved by the production code, not by regex.
                expect(configuredTracingRoot(app)?.root).toBe(app);
                expect(requireBuildContext(app, () => {})).toBe(app);
            });
        }
    }

    it("default builder (Turbopack) also pins turbopack.root to the same dir", () => {
        const { app, config } = appUnderParentLockfile("default", "node");
        expect(config).toMatch(/turbopack\s*:\s*\{[^}]*root\s*:/);
        // outputFileTracingRoot wins in knext's resolver when both are set, so
        // check turbopack.root on its own by stripping the other key.
        const turbopackOnly = config.replace(
            /^\s*outputFileTracingRoot\s*:.*$/m,
            "",
        );
        writeFileSync(join(app, "next.config.ts"), turbopackOnly);
        expect(configuredTracingRoot(app)).toEqual({
            root: app,
            source: "next.config.ts:turbopack.root",
        });
    });

    it("vinext builder has no turbopack block (it never runs Turbopack)", () => {
        const { config } = appUnderParentLockfile("vinext", "bun");
        expect(config).not.toMatch(/turbopack\s*:/);
    });
});

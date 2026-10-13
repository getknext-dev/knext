/**
 * GUARD: the `next` peer floor is >=16.4.0 and the Next 16.0.x `ctx.routes`
 * compatibility branch is gone from the adapter.
 *
 * Both halves are asserted: the floor (manifest) and the deletion (source),
 * so neither can be reverted alone without a red test.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NEXT_PEER_RANGE } from "../next-compat";

const pkgDir = join(__dirname, "..", "..");
const repoRoot = join(pkgDir, "..", "..");
const read = (p: string) => readFileSync(p, "utf8");

const PUBLISHABLE = ["kn-next", "lib", "db"];

describe("next peer floor", () => {
    it("@getknext/core declares the bounded next range, floor 16.4.0", () => {
        const pkg = JSON.parse(read(join(pkgDir, "package.json")));
        expect(pkg.peerDependencies.next).toBe(NEXT_PEER_RANGE);
        expect(NEXT_PEER_RANGE.startsWith(">=16.4.0 ")).toBe(true);
    });

    it("no publishable package declares a lower next peer range", () => {
        for (const dir of PUBLISHABLE) {
            const pkg = JSON.parse(
                read(join(repoRoot, "packages", dir, "package.json")),
            );
            const range = pkg.peerDependencies?.next;
            if (range !== undefined) expect(range).toBe(NEXT_PEER_RANGE);
        }
    });

    it("the support matrix page states the same floor", () => {
        const page = read(
            join(repoRoot, "apps/docs/content/docs/support-matrix.mdx"),
        );
        expect(page).toContain(`\`next ${NEXT_PEER_RANGE}\``);
        expect(page).not.toContain("`next >=16.0.0`");
    });
});

describe("Next 16.0.x ctx.routes branch is deleted", () => {
    const src = read(join(pkgDir, "src", "adapters", "next-adapter.ts"));

    it("next-adapter.ts has no legacy ctx.routes shape", () => {
        expect(src).not.toContain("Legacy160RoutesCtx");
        expect(src).not.toContain("legacyRoutes");
        expect(src).not.toContain("ctx.routes");
    });

    it("still counts the typed ctx.routing", () => {
        expect(src).toContain("ctx.routing");
    });
});

describe("code that only served Next < 16.4.0 is deleted", () => {
    const readPkg = (rel: string) => read(join(pkgDir, rel));

    it("the turbopack+adapterPath nft pre-build guard (16.3.0-16.3.4 only) is gone", () => {
        const src = readPkg("src/cli/project-build.ts");
        expect(src).not.toContain("isAffectedNextVersion");
        expect(src).not.toContain("checkTurbopackAdapterStandaloneRegression");
        expect(readPkg("templates/app/next.config.ts.hbs")).not.toContain(
            "checkTurbopackAdapterStandaloneRegression",
        );
    });

    it("the cache handler no longer seeds Next's shared Map (Next applies the handler's cacheControl directly)", () => {
        const src = readPkg("src/adapters/cache-handler.js");
        expect(src).not.toContain("seedNextCacheControl");
        expect(src).not.toContain("shared-cache-controls");
        expect(src).not.toContain("function nextRoute");
        expect(src).toContain("function scopeWindowToBuild");
    });

    it("no comment still describes the pinned runtime as Next 16.0.3", () => {
        expect(readPkg("src/adapters/next-adapter.ts")).not.toContain("16.0.3");
        expect(readPkg("src/adapters/image-cache-sync.ts")).not.toContain(
            "16.0.3",
        );
    });
});

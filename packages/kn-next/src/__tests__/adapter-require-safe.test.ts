import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * B2 regression gate (#173, A3-3 #147): the adapter entry served by the
 * `@knext/core/adapter` export MUST stay require()-safe under plain Node.
 *
 * Next.js resolves `experimental.adapterPath` (NEXT_ADAPTER_PATH) with
 * `require.resolve()` and there are require()-semantics load paths around
 * config loading (e.g. `__NEXT_TEST_MODE === 'jest'` in
 * next/src/server/config.ts). Node can require() an ESM graph — UNLESS that
 * graph contains a top-level await, which throws ERR_REQUIRE_ASYNC_MODULE:
 *
 *   Error: require() cannot be used on an ESM graph with top-level await.
 *
 * Investigation for #173 showed the shipped dist is ALREADY require()-safe
 * (the 18 compat failures came from the fixtures' own next.config.ts TLA +
 * the harness not enabling native TS resolution — fixed in
 * scripts/e2e-deploy.sh, see tests/e2e-deploy.native-ts-config.test.ts).
 * This test pins that property so a future static import with module-scope
 * await (e.g. hoisting the lazy `@knext/lib/clients` import) fails HERE, not
 * in a 18-file compat wipeout.
 *
 * Requires a prior `tsup` build (same precondition as publish-surface.test.ts).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(__dirname, "../..");
const adapterDist = resolve(pkgDir, "dist/adapters/next-adapter.js");

describe("@knext/core/adapter — require()-safe dist (B2, #173)", () => {
    it("the built adapter entry exists (tsup ran)", () => {
        expect(
            existsSync(adapterDist),
            `${adapterDist} missing — run \`pnpm build\` in packages/kn-next first`,
        ).toBe(true);
    });

    it("require() of the adapter dist succeeds under plain Node (no top-level await in its graph)", () => {
        // Spawn a REAL plain-Node process: vitest's own module runner would not
        // exercise Node's ERR_REQUIRE_ASYNC_MODULE semantics.
        const probe = [
            `const m = require(${JSON.stringify(adapterDist)});`,
            "const adapter = m.default ?? m;",
            "if (adapter.name !== 'knext-adapter') {",
            "  throw new Error('unexpected adapter shape: ' + JSON.stringify(Object.keys(m)));",
            "}",
            "if (typeof adapter.modifyConfig !== 'function') throw new Error('modifyConfig missing');",
            "if (typeof adapter.onBuildComplete !== 'function') throw new Error('onBuildComplete missing');",
            "console.log('REQUIRE_OK');",
        ].join("\n");
        const r = spawnSync(process.execPath, ["-e", probe], {
            encoding: "utf8",
            timeout: 30000,
        });
        expect(
            r.status,
            `require() of the adapter dist failed:\n${r.stderr}`,
        ).toBe(0);
        expect(r.stdout).toContain("REQUIRE_OK");
        // The specific regression this guards against:
        expect(r.stderr).not.toContain("ERR_REQUIRE_ASYNC_MODULE");
    });
});

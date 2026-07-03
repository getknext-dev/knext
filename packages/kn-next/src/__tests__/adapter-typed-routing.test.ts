/**
 * GUARD TEST (#171 follow-up): in-repo next is 16.2.x and the adapter uses the
 * TYPED `ctx.routing` from the official 16.2 adapter API — no more laundering
 * the whole ctx through `as unknown as`.
 *
 * Background: PR #171 made onBuildComplete tolerate both adapter-API ctx shapes
 * (16.0.x `ctx.routes` vs 16.2 `ctx.routing`) via an untyped
 * `ctx as unknown as {...}` cast, because the in-repo devDep was next@16.0.3
 * whose types predate `ctx.routing`. The architect gate queued this follow-up:
 * once in-repo next moves to 16.2.x, adopt the typed ctx.routing and drop the
 * shim cast.
 *
 * What must stay true (runtime, NOT types): peerDependencies.next is >=16.0.0,
 * so a 16.0.x consumer still hands the adapter a ctx with `routes` and NO
 * `routing`. Only the TYPES modernize — the runtime shape tolerance lives on
 * in adapter-onbuildcomplete-shape.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const pkgDir = join(__dirname, "..", "..");
const adapterSource = readFileSync(
    join(pkgDir, "src", "adapters", "next-adapter.ts"),
    "utf8",
);

describe("in-repo next devDependency (#171 follow-up)", () => {
    it("pins next 16.2.x so the typed ctx.routing exists locally", () => {
        const pkg = JSON.parse(
            readFileSync(join(pkgDir, "package.json"), "utf8"),
        );
        expect(pkg.devDependencies.next).toMatch(/^16\.2\./);
        // The public contract does NOT move: 16.0.x consumers stay supported.
        expect(pkg.peerDependencies.next).toBe(">=16.0.0");
    });
});

describe("next-adapter uses the typed ctx.routing (no untyped ctx cast)", () => {
    it("does not launder ctx through `as unknown as`", () => {
        // The #171 shim cast: `const ctxAny = ctx as unknown as {...}`.
        // With next@16.2.x types, ctx.routing is officially typed — the whole-ctx
        // unknown cast must be gone. (A narrow intersection cast documenting the
        // LEGACY 16.0.x `routes` field is fine — it never goes through unknown.)
        expect(adapterSource).not.toContain("ctx as unknown as");
        expect(adapterSource).not.toContain("ctxAny");
    });

    it("reads routing counts from the typed ctx.routing fields", () => {
        // Positive signal: the adapter accesses ctx.routing as a typed value
        // (not an index into a Record<string, unknown>).
        expect(adapterSource).toMatch(/ctx\.routing/);
    });
});

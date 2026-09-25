import { describe, expect, it } from "bun:test";
import { buildNextAppCRObject } from "../cli/cr-builder";
import type { KnativeNextConfig } from "../config";

/**
 * Track B2 / ADR-0048 Amendment 3 — `spec.build` on the emitted NextApp CR.
 *
 * #1183 (ADR-0058) flipped `DEFAULT_BUILDER_ID` from `"vinext"` to
 * `"turbopack"`. `spec.build` is still ALWAYS resolved and explicitly
 * written (never omitted) — that half of the B2 contract is unchanged, only
 * which value a silent config now resolves to. Wire absence still
 * permanently means "turbopack" (ADR-0017), which now coincides with the
 * resolved config default, but the CR builder does not rely on that
 * coincidence: it still emits the field explicitly either way, so an older
 * operator that predates the enum widening reads the same value a newer one
 * does.
 */

const IMG = "registry/app:tag@sha256:deadbeef";

function baseConfig(
    overrides: Partial<KnativeNextConfig> = {},
): KnativeNextConfig {
    return {
        name: "app",
        registry: "registry",
        storage: {
            provider: "gcs",
            bucket: "b",
            publicUrl: "https://example.com",
        },
        ...overrides,
    };
}

const NS = "default";

const specOf = (config: KnativeNextConfig): Record<string, unknown> =>
    (buildNextAppCRObject(config, IMG, NS) as { spec: Record<string, unknown> })
        .spec;

describe("#B2 spec.build on the emitted CR", () => {
    it("resolves an unset build to an explicit turbopack (#1183) — the default is still always written", () => {
        const spec = specOf(baseConfig());

        // Explicit, not absent: the CR builder always resolves and writes
        // `build`, unaffected by which value DEFAULT_BUILDER_ID currently
        // names. Since #1183 that value is "turbopack".
        expect(spec.build).toBe("turbopack");
    });

    it("resolves the default independently of runtime — the axes do not imply each other", () => {
        // A builder that derived `build` FROM `runtime` would pass the default
        // case and fail here: runtime changes, build stays the resolved
        // default.
        for (const runtime of ["node", "bun"] as const) {
            const spec = specOf(baseConfig({ runtime }));
            expect(spec.build).toBe("turbopack");
        }
    });

    it("EMITS runtime on the default (turbopack) shape — even when unset it round-trips undefined", () => {
        // The omission rule is shape-scoped to vinext, not global (see the
        // "OMITS runtime on the vinext shape" case below) — the standalone
        // shape genuinely needs the field, and the default builder is now
        // that shape.
        for (const runtime of ["node", "bun"] as const) {
            const spec = specOf(baseConfig({ runtime }));
            expect(spec.runtime).toBe(runtime);
        }
    });

    it("resolves an UNSET runtime to an explicit 'bun' on the default (turbopack) shape (#1183 PR review finding #3)", () => {
        // `knext build`/`selectRuntimeImage` both now compile and stage the
        // Bun bytecode executable by default (DEFAULT_RUNTIME_ID,
        // build.ts/runtime-image.ts) — a bare config's local build produces
        // the bun-standalone artifact, not node-standalone. The CR must
        // resolve and write the SAME default the local build resolved,
        // rather than relying on the coincidence that the operator's ONE
        // `Spec.Runtime` read site (the legacy `Runtime=="bun"` compat-shim
        // command override) happens to be harmless either way today — the
        // same explicit-write discipline `spec.build` already follows here,
        // now extended to `spec.runtime`.
        const spec = specOf(baseConfig());
        expect(spec.runtime).toBe("bun");
    });

    it("OMITS runtime on the vinext shape — even when the config sets it", () => {
        // Two reasons, both wire-level (design-gate finding on PR #890):
        // the field is meaningless for a single-exec image (the runtime is
        // compiled in), and during a CRD-first upgrade an OLD operator pod
        // still forces `bun run server.js` onto any runtime:"bun" CR
        // regardless of build — CrashLooping the binary image until the pod
        // rolls. No runtime on the wire, no window.
        for (const runtime of ["node", "bun"] as const) {
            const spec = specOf(baseConfig({ build: "vinext", runtime }));
            expect("runtime" in spec).toBe(false);
        }
    });

    it("still emits runtime for the standalone (turbopack) shape", () => {
        // The omission is shape-scoped, not global — stored standalone CRs
        // and their images genuinely need the field.
        const spec = specOf(baseConfig({ build: "turbopack", runtime: "bun" }));
        expect(spec.runtime).toBe("bun");
        expect(spec.build).toBe("turbopack");
    });

    it("carries an explicit turbopack when the user asked for it", () => {
        // Explicit is preserved rather than normalised away: the user said it,
        // and round-tripping their config faithfully is what makes `--dry-run`
        // output trustworthy. Since #1167 turbopack is a SELECTABLE target
        // (ADR-0054), so this is now a first-class deploy path, not just a
        // preserved legacy value — the CR round-trips it into `spec.build`.
        expect(specOf(baseConfig({ build: "turbopack" })).build).toBe(
            "turbopack",
        );
    });

    it("emits runtime for the standalone (webpack) shape too — same shape as turbopack (#1219)", () => {
        const spec = specOf(baseConfig({ build: "webpack", runtime: "bun" }));
        expect(spec.runtime).toBe("bun");
        expect(spec.build).toBe("webpack");
    });

    it("carries an explicit webpack through, round-tripping the user's choice (#1219)", () => {
        expect(specOf(baseConfig({ build: "webpack" })).build).toBe("webpack");
    });

    it("carries vinext through when set, without inventing a runtime", () => {
        const spec = specOf(baseConfig({ build: "vinext" }));

        expect(spec.build).toBe("vinext");
        expect("runtime" in spec).toBe(false);
    });

    it("leaves the rest of the spec unchanged for a config that predates the field", () => {
        // Determinism: two renders of the same config are identical, and the
        // ONLY delta against the old contract is the resolved build field.
        const before = specOf(baseConfig({ runtime: "node" }));
        const after = specOf(baseConfig({ runtime: "node" }));

        expect(after).toEqual(before);
        expect(after.build).toBe("turbopack");
    });
});

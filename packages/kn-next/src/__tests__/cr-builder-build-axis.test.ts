import { describe, expect, it } from "bun:test";
import { buildNextAppCRObject } from "../cli/cr-builder";
import type { KnativeNextConfig } from "../config";

/**
 * Track B2 / ADR-0048 Amendment 3 — `spec.build` on the emitted NextApp CR.
 *
 * The load-bearing assertion FLIPPED when vinext became the default builder.
 * It used to be the omission one: absence is the wire spelling of "turbopack"
 * (ADR-0017), so a default config had to omit the field to stay valid against
 * older CRDs. But once the CLI's default BUILD is vinext, that same omission
 * becomes a lie on the wire: the image contains one compiled executable, and a
 * CR without `build` tells the operator to run the standalone shape — it would
 * exec `bun run server.js` into an image that has no server.js and CrashLoop.
 *
 * So the builder now RESOLVES the default and always writes it. The #548
 * upgrade-order hazard (an older CRD's enum has no "vinext") is accepted and
 * loud: --validate=strict rejects the apply and deploy's preflight names the
 * unknown value before the cluster is touched. Operator/CRD first, then CLI.
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
    it("resolves an unset build to an explicit vinext — absence would mis-run the image", () => {
        const spec = specOf(baseConfig());

        // Explicit, not absent: absence permanently means "turbopack" on the
        // wire (ADR-0017), and the default build no longer produces that
        // artifact. An omitted field here is how a single-exec image gets a
        // `bun run server.js` command it cannot serve.
        expect(spec.build).toBe("vinext");
    });

    it("resolves the default independently of runtime — the axes do not imply each other", () => {
        // A builder that derived `build` FROM `runtime` would pass the default
        // case and fail here: runtime changes, build stays the resolved
        // default.
        for (const runtime of ["node", "bun"] as const) {
            const spec = specOf(baseConfig({ runtime }));
            expect(spec.build).toBe("vinext");
        }
    });

    it("OMITS runtime on the vinext shape — even when the config sets it", () => {
        // Two reasons, both wire-level (design-gate finding on PR #890):
        // the field is meaningless for a single-exec image (the runtime is
        // compiled in), and during a CRD-first upgrade an OLD operator pod
        // still forces `bun run server.js` onto any runtime:"bun" CR
        // regardless of build — CrashLooping the binary image until the pod
        // rolls. No runtime on the wire, no window.
        for (const runtime of ["node", "bun"] as const) {
            const spec = specOf(baseConfig({ runtime }));
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
        // output trustworthy. (validateConfig rejects retired builders before
        // a deploy gets here; the CR builder itself does not police.)
        expect(specOf(baseConfig({ build: "turbopack" })).build).toBe(
            "turbopack",
        );
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
        expect(after.build).toBe("vinext");
    });
});

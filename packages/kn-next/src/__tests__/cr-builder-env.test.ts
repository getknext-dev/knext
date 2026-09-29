import { describe, expect, it } from "bun:test";
import { buildNextAppCRObject, renderNextAppCR } from "../cli/cr-builder";
import type { KnativeNextConfig } from "../config";
import {
    extractReservedEnvNames,
    reservedEnvNamesFromSource,
} from "./helpers/crd-reserved-env";

/**
 * #186 — plain (non-secret) env vars via spec.env.
 *
 * knext.config.ts may declare `env: { NAME: "value" }` for NON-SECRET
 * configuration flags (e.g. KNEXT_CACHE_CONTROL_NORMALIZE=0). The CR builder
 * must carry it as spec.env so the operator injects it on the ksvc container.
 * Secrets stay on the dedicated spec.secrets mechanism.
 */

const IMG = "registry/app:tag@sha256:deadbeef";

function baseConfig(env?: Record<string, string>): KnativeNextConfig {
    return {
        name: "app",
        registry: "registry",
        // publicUrl is required by StorageConfig but NOT read by the CR
        // builder (it maps provider/bucket/region/endpoint only) — supplying
        // it satisfies the type without touching the built CR (#261).
        storage: {
            provider: "gcs",
            bucket: "bucket",
            publicUrl: "https://storage.googleapis.com/bucket",
        },
        ...(env ? { env } : {}),
    };
}

describe("cr-builder spec.env (#186)", () => {
    it("carries config.env into the CR's spec.env", () => {
        const cr = buildNextAppCRObject(
            baseConfig({
                KNEXT_CACHE_CONTROL_NORMALIZE: "0",
                FEATURE_FLAG_BETA: "on",
            }),
            IMG,
            "default",
        );
        const spec = cr.spec as Record<string, unknown>;
        expect(spec.env).toEqual({
            KNEXT_CACHE_CONTROL_NORMALIZE: "0",
            FEATURE_FLAG_BETA: "on",
        });
    });

    it("omits spec.env when config.env is absent", () => {
        const cr = buildNextAppCRObject(baseConfig(), IMG, "default");
        const spec = cr.spec as Record<string, unknown>;
        expect(spec).not.toHaveProperty("env");
    });

    it("omits spec.env when config.env is an empty object", () => {
        const cr = buildNextAppCRObject(baseConfig({}), IMG, "default");
        const spec = cr.spec as Record<string, unknown>;
        expect(spec).not.toHaveProperty("env");
    });

    it("keeps spec.env independent of spec.secrets", () => {
        const config: KnativeNextConfig = {
            ...baseConfig({ FLAG: "1" }),
            secrets: { envFrom: ["db-credentials"] },
        };
        const cr = buildNextAppCRObject(config, IMG, "default");
        const spec = cr.spec as Record<string, unknown>;
        expect(spec.env).toEqual({ FLAG: "1" });
        expect(spec.secrets).toEqual({ envFrom: ["db-credentials"] });
    });

    it("renders spec.env in the YAML output", () => {
        const yaml = renderNextAppCR(
            baseConfig({ KNEXT_CACHE_CONTROL_NORMALIZE: "0" }),
            IMG,
            "default",
        );
        expect(yaml).toContain("KNEXT_CACHE_CONTROL_NORMALIZE");
        expect(yaml).toContain('"0"');
    });
});

/**
 * T2d — the POD carries the id the BUNDLE was built with.
 *
 * Baked-at-build makes this belt-and-braces today (vinext resolves
 * `NEXT_DEPLOYMENT_ID` at build time, into the artifact). It stops being
 * belt-and-braces the moment anything serves or reports the id at runtime, and
 * a CR that carries it is assertable now — which is the whole difference
 * between a chain that is closed and one that is closed everywhere it is
 * currently observed.
 */
describe("cr-builder spec.env NEXT_DEPLOYMENT_ID (T2d)", () => {
    it("injects NEXT_DEPLOYMENT_ID = the deploy build id", () => {
        const cr = buildNextAppCRObject(baseConfig(), IMG, "default", "tag-9");
        const spec = cr.spec as Record<string, unknown>;
        expect(spec.env).toEqual({ NEXT_DEPLOYMENT_ID: "tag-9" });
        // The id the operator stamps on the revision label MUST be the same
        // value — that identity is the whole skew chain.
        expect(spec.buildId).toBe("tag-9");
    });

    it("merges with the user's own env rather than replacing it", () => {
        const cr = buildNextAppCRObject(
            baseConfig({ FEATURE_FLAG_BETA: "on" }),
            IMG,
            "default",
            "tag-9",
        );
        expect((cr.spec as Record<string, unknown>).env).toEqual({
            FEATURE_FLAG_BETA: "on",
            NEXT_DEPLOYMENT_ID: "tag-9",
        });
    });

    it("emits NO spec.env when there is no build id and no user env", () => {
        // Back-compat: `buildId` is optional (a `generate`-style render), and
        // an env block that appears from nowhere would be a wire change.
        const cr = buildNextAppCRObject(baseConfig(), IMG, "default");
        expect(cr.spec as Record<string, unknown>).not.toHaveProperty("env");
    });

    it("knext's value WINS over a user's colliding NEXT_DEPLOYMENT_ID", () => {
        // The decision, made explicitly (sprint-2 T2d): the id is a FACT about
        // the artifact that was just built, not a preference. A user value here
        // would point `?dpl=` and the static prefix at different builds — the
        // exact skew ADR-0011 exists to prevent — and it would disagree with
        // spec.buildId, which the operator stamps on the revision and the asset
        // GC protects by. So the deploy's id overrides, and loudly (the CLI
        // warns; see deploy's log), never silently.
        const cr = buildNextAppCRObject(
            baseConfig({ NEXT_DEPLOYMENT_ID: "user-typed-this" }),
            IMG,
            "default",
            "tag-9",
        );
        expect((cr.spec as Record<string, unknown>).env).toEqual({
            NEXT_DEPLOYMENT_ID: "tag-9",
        });
    });

    it("does not collide with a name the CRD rejects at admission (#186)", () => {
        // The operator's CEL validation rejects these outright, and
        // appendUserEnv drops a spec.env name that an operator-injected var
        // already owns. Injecting one of those would make every deploy either
        // fail admission or silently lose the entry.
        //
        // #922 — DERIVED from the CRD source of truth (the CEL rule in
        // nextapp_types.go), never hand-copied. A reserved name added to the
        // operator flows through here without touching this test; a stale
        // literal would go green about a name the apiserver would reject.
        const CRD_RESERVED = reservedEnvNamesFromSource();
        // Non-vacuity guard: an empty derivation would let every name pass the
        // `not.toContain` loop below (ACs of #922). Fail closed instead.
        expect(CRD_RESERVED.length).toBeGreaterThan(0);
        const cr = buildNextAppCRObject(baseConfig(), IMG, "default", "tag-9");
        const names = Object.keys(
            (cr.spec as { env: Record<string, string> }).env,
        );
        // Non-vacuity: there IS a name to check.
        expect(names).toContain("NEXT_DEPLOYMENT_ID");
        for (const name of names) expect(CRD_RESERVED).not.toContain(name);
        // ...and it is a C_IDENTIFIER, the CRD's other admission rule.
        for (const name of names)
            expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    });

    it("renders NEXT_DEPLOYMENT_ID in the YAML output", () => {
        const yaml = renderNextAppCR(baseConfig(), IMG, "default", "tag-9");
        expect(yaml).toContain("NEXT_DEPLOYMENT_ID");
        expect(yaml).toContain("tag-9");
    });
});

/**
 * #922 — the reserved-env list used above is DERIVED from the operator's CEL
 * rule, so it cannot drift out of sync with what the apiserver rejects. These
 * tests pin the derivation itself: that it tracks the real source, that a CRD
 * change flows through it, and that it fails rather than passes when empty.
 */
describe("CRD reserved-env derivation (#922)", () => {
    // Canary anchored to the CURRENT operator rule. If the CEL rule gains or
    // loses a reserved name, the derived set changes and this reds — forcing a
    // conscious update here instead of silent drift. This is the alarm, not the
    // source of truth: the reserved check above consumes the derived list.
    const KNOWN_CURRENT = [
        "HOSTNAME",
        "PORT",
        "K_SERVICE",
        "K_REVISION",
        "K_CONFIGURATION",
    ];

    it("derives exactly the current reserved set from the real Go source", () => {
        const derived = reservedEnvNamesFromSource();
        expect([...derived].sort()).toEqual([...KNOWN_CURRENT].sort());
    });

    it("a reserved name added to the CEL rule flows through the derivation", () => {
        // Mutation-proof: feed the extractor a COPY of the rule with an extra
        // clause (as a real operator change would look) and confirm the derived
        // list GROWS to include it — i.e. a CRD change is caught, not missed.
        // The real file is never modified; the extractor tracks the real file.
        const withNewReserved = `// +kubebuilder:validation:XValidation:rule="!('HOSTNAME' in self) && !('PORT' in self) && !('K_SERVICE' in self) && !('K_REVISION' in self) && !('K_CONFIGURATION' in self) && !('K_SINK' in self)",message="reserved"`;
        const derived = extractReservedEnvNames(withNewReserved);
        expect(derived).toContain("K_SINK");
        expect(derived).toEqual([...KNOWN_CURRENT, "K_SINK"]);

        // ...and removing it again restores the current set — the extractor is
        // reading the rule text, not remembering anything.
        const withoutIt = withNewReserved.replace(
            " && !('K_SINK' in self)",
            "",
        );
        expect(extractReservedEnvNames(withoutIt).sort()).toEqual(
            [...KNOWN_CURRENT].sort(),
        );
    });

    it("derives an EMPTY set when the reserved clause is absent (non-vacuity)", () => {
        // The sibling C_IDENTIFIER rule has no `!('NAME' in self)` clause, so a
        // source carrying only it yields nothing — which is why the consumer
        // above asserts length > 0 rather than trusting the loop.
        const cIdentOnly = `// +kubebuilder:validation:XValidation:rule="self.all(k, k.matches('^[A-Za-z_][A-Za-z0-9_]*$'))",message="C_IDENTIFIER"`;
        expect(extractReservedEnvNames(cIdentOnly)).toEqual([]);
    });
});

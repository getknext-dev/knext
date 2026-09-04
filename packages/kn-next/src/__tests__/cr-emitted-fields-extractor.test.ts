/**
 * T5 — the set of CR fields this CLI can emit is DERIVED BY SCANNING
 * `cli/cr-builder.ts`, never enumerated by hand.
 *
 * Why scanning and not a list: enumeration is exactly how the `preview deploy`
 * apply site was missed the first time (see cr-apply-strict-validation.test.ts).
 * A hand-maintained field list would go stale the first time somebody adds a
 * knob to the builder, and it would go stale SILENTLY — which is the failure
 * mode the prune preflight exists to remove, reintroduced one layer up.
 *
 * The anti-vacuity half is the load-bearing one: the extractor understands a
 * fixed set of TypeScript constructs, so anything it cannot read (a helper in
 * another module, a computed key, a construct nobody anticipated) must FAIL
 * here rather than quietly shrink the emitted set. Concretely: every object
 * literal key inside `buildNextAppCRObject` must be the tail segment of at
 * least one extracted path. Add a field to the builder that the extractor
 * cannot reach → red.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    extractEmittedFields,
    objectLiteralKeys,
} from "../cli/schema/extract-emitted-fields";

const HERE = dirname(fileURLToPath(import.meta.url));
const CR_BUILDER = join(HERE, "..", "cli", "cr-builder.ts");

function source(): string {
    return readFileSync(CR_BUILDER, "utf-8");
}

describe("emitted-field extractor — derived by scanning cr-builder.ts", () => {
    it("finds the CR envelope and the required spec fields", () => {
        const paths = new Set(extractEmittedFields(source()));
        for (const p of [
            "apiVersion",
            "kind",
            "metadata.name",
            "metadata.namespace",
            "spec.image",
            "spec.scaling.minScale",
            "spec.scaling.maxScale",
        ]) {
            expect(paths, `missing ${p}`).toContain(p);
        }
    });

    it("reaches fields behind conditional spreads and intermediate consts", () => {
        // `...(resources ? { resources } : {})` where `resources` is a
        // `const … = cond ? {…} : undefined` several statements earlier.
        const paths = new Set(extractEmittedFields(source()));
        for (const p of [
            "spec.resources.cpuRequest",
            "spec.storage.provider",
            "spec.observability.rum.sampleRate",
            "spec.preview.prId",
            "spec.buildId",
            "spec.scaling.imagePrewarm",
        ]) {
            expect(paths, `missing ${p}`).toContain(p);
        }
    });

    it("names the roSecretRef leaves — the field whose pruning escalates DB privilege", () => {
        const paths = new Set(extractEmittedFields(source()));
        expect(paths).toContain("spec.database.roSecretRef.name");
        expect(paths).toContain("spec.database.roSecretRef.key");
    });

    it("models dynamic maps and arrays with a `*` segment", () => {
        const paths = new Set(extractEmittedFields(source()));
        // Object.fromEntries(...) over spec.secrets.envMap
        expect(paths).toContain("spec.secrets.envMap.*.secretName");
        expect(paths).toContain("spec.secrets.envMap.*.secretKey");
        // warmSchedule is `…map(w => ({start, end, replicas, …}))`
        expect(paths).toContain("spec.scaling.warmSchedule.*.start");
        expect(paths).toContain("spec.scaling.warmSchedule.*.replicas");
    });

    it("emits no path the builder cannot produce (spot-check a plausible-but-absent field)", () => {
        const paths = new Set(extractEmittedFields(source()));
        expect(paths).not.toContain("spec.security.networkPolicy");
        expect(paths).not.toContain("spec.timeoutSeconds");
    });

    /* --------------------------------------------------------------- *
     * Anti-vacuity: an unreadable construct fails, it does not vanish.  *
     * --------------------------------------------------------------- */

    it("every object-literal key inside buildNextAppCRObject is covered by an extracted path", () => {
        const src = source();
        const keys = objectLiteralKeys(src, "buildNextAppCRObject");
        expect(
            keys.length,
            "no object-literal keys found in buildNextAppCRObject — the counting guard has gone vacuous",
        ).toBeGreaterThanOrEqual(20);

        const tails = new Set(
            extractEmittedFields(src).map((p) => p.split(".").pop() as string),
        );
        for (const k of keys) {
            expect(
                tails.has(k.name),
                `cr-builder.ts:${k.line} emits the CR key \`${k.name}\`, but the extractor produced no path ending in it. Either the construct is one the extractor cannot read — teach it, or rewrite the builder in a construct it understands — or the key is not a CR field. It is NOT allowed to be unverifiable: an uncovered field is exactly what the prune preflight would then fail to protect.`,
            ).toBe(true);
        }
    });

    it("is not fooled by an unreadable construct (mutation proof, in-memory)", () => {
        // Same shape as the real builder, but the new field arrives through a
        // MUTABLE accumulator — a construct the path walker deliberately does
        // not follow (it resolves `const` initializers only). The key is
        // present in the function, no path ends in it ⇒ the guard above reds.
        const mutated = `
            export function buildNextAppCRObject(cond: boolean): Record<string, unknown> {
                let extra: Record<string, unknown> = {};
                if (cond) {
                    extra = { smuggledField: 1 };
                }
                const spec: Record<string, unknown> = { image: "x", ...extra };
                return { apiVersion: "v", kind: "NextApp", spec };
            }
        `;
        const tails = new Set(
            extractEmittedFields(mutated).map(
                (p) => p.split(".").pop() as string,
            ),
        );
        const keys = objectLiteralKeys(mutated, "buildNextAppCRObject");
        expect(keys.map((k) => k.name)).toContain("smuggledField");
        expect(tails.has("smuggledField")).toBe(false);
    });
});

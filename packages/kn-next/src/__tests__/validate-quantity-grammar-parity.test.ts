import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { validateConfig } from "../cli/validate";
import type { KnativeNextConfig } from "../config";

/**
 * #455 (2) — CLI-regex ↔ operator ParseQuantity parity.
 *
 * `validate.ts` hand-mirrors the Kubernetes quantity grammar as a regex so
 * `kn-next deploy` gives fast feedback on a typo like "1GB" without a cluster
 * round-trip. The OPERATOR stays the source of truth (ADR-0001) — but a mirror
 * that silently drifts is worse than no mirror: it either rejects a value the
 * cluster would accept, or waves through one the operator will reject after the
 * user has already pushed an image.
 *
 * The shared fixture is generated from, and re-verified against, apimachinery's
 * real parser on the Go side (`internal/validation/quantity_fixture_test.go`).
 * This test asserts the CLI reaches the SAME verdict on every row. If the two
 * ever disagree, exactly one of these two suites goes red with the offending
 * value named.
 *
 * The fixture deliberately lives with the source of truth (the operator
 * package). If that file ever moves out of this repo, this test fails loudly
 * rather than quietly stopping to check anything.
 */
const fixturePath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../kn-next-operator/test/fixtures/quantity-grammar.json",
);

type QuantityCase = { value: string; accepted: boolean; note?: string };

const fixture: { cases: QuantityCase[] } = JSON.parse(
    readFileSync(fixturePath, "utf8"),
);

/**
 * SCAN, don't enumerate — the same standard the operator side holds itself to
 * (`TestEveryResourcesFieldIsQuantityChecked` reflects over `ResourcesSpec`).
 * The field list comes from the CRD, which is the schema the operator actually
 * serves, so a FIFTH `spec.resources` field that the CLI forgets to check fails
 * here: the CLI would silently accept every malformed value for it, and every
 * rejected fixture row would show up as a divergence.
 */
const crdPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../kn-next-operator/config/crd/bases/apps.kn-next.dev_nextapps.yaml",
);

function resourceFieldsFromCRD(): string[] {
    const doc = parseYaml(readFileSync(crdPath, "utf8")) as {
        spec: {
            versions: {
                schema: {
                    openAPIV3Schema: {
                        properties: {
                            spec: {
                                properties: {
                                    resources?: {
                                        properties?: Record<string, unknown>;
                                    };
                                };
                            };
                        };
                    };
                };
            }[];
        };
    };
    const fields = Object.keys(
        doc.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties
            .resources?.properties ?? {},
    );
    if (fields.length === 0) {
        throw new Error(
            `no spec.resources properties found in ${crdPath} — the scan is broken, not passing`,
        );
    }
    return fields.sort();
}

const resourceFields = resourceFieldsFromCRD();

function configWith(field: string, value: string): KnativeNextConfig {
    return {
        name: "app",
        registry: "registry",
        storage: { provider: "gcs", bucket: "bucket" },
        // The CLI carries these four under `scaling`, the CR under
        // `spec.resources`; the leaf names are identical, which is what makes
        // the CRD usable as the field list here.
        scaling: { [field]: value },
    } as KnativeNextConfig;
}

/** The CLI's verdict on a quantity, read through its PUBLIC surface. */
function cliAccepts(field: string, value: string): boolean {
    try {
        validateConfig(configWith(field, value));
        return true;
    } catch {
        return false;
    }
}

describe("quantity grammar — CLI mirror vs operator (shared fixture, #455)", () => {
    it("loads a fixture with enough corner cases to be worth trusting", () => {
        expect(fixture.cases.length).toBeGreaterThanOrEqual(20);
        expect(fixture.cases.some((c) => c.accepted)).toBe(true);
        expect(fixture.cases.some((c) => !c.accepted)).toBe(true);
    });

    it("checks every spec.resources field the CRD declares", () => {
        // Not an assertion about WHICH fields exist — an assertion that the scan
        // found them from the schema rather than from a literal in this file.
        expect(resourceFields.length).toBeGreaterThanOrEqual(4);
    });

    it("reaches the operator's verdict on every fixture row, for every resource field", () => {
        const divergences: string[] = [];
        for (const field of resourceFields) {
            for (const c of fixture.cases) {
                // An empty string means "field unset" in the CR, not "invalid
                // quantity" — the CLI skips undefined fields, so there is
                // nothing to compare.
                if (c.value === "") continue;
                const cli = cliAccepts(field, c.value);
                if (cli !== c.accepted) {
                    divergences.push(
                        `${field}=${JSON.stringify(c.value)}: operator accepted=${c.accepted}, CLI accepted=${cli}` +
                            (c.note ? ` (${c.note})` : ""),
                    );
                }
            }
        }
        expect(divergences).toEqual([]);
    });
});

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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

function configWith(value: string): KnativeNextConfig {
    return {
        name: "app",
        registry: "registry",
        storage: { provider: "gcs", bucket: "bucket" },
        scaling: { cpuRequest: value },
    } as KnativeNextConfig;
}

/** The CLI's verdict on a quantity, read through its PUBLIC surface. */
function cliAccepts(value: string): boolean {
    try {
        validateConfig(configWith(value));
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

    it("reaches the operator's verdict on every fixture row", () => {
        const divergences: string[] = [];
        for (const c of fixture.cases) {
            // An empty string means "field unset" in the CR, not "invalid
            // quantity" — the CLI skips undefined fields, so there is nothing to
            // compare.
            if (c.value === "") continue;
            const cli = cliAccepts(c.value);
            if (cli !== c.accepted) {
                divergences.push(
                    `${JSON.stringify(c.value)}: operator accepted=${c.accepted}, CLI accepted=${cli}` +
                        (c.note ? ` (${c.note})` : ""),
                );
            }
        }
        expect(divergences).toEqual([]);
    });
});

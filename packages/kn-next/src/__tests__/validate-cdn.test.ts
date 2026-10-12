import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigValidationError, validateConfig } from "../cli/validate";
import type { KnativeNextConfig } from "../config";

/**
 * `cdn` is validated locally with the same bounds the CRD enforces on
 * spec.cdn, so a typo is a fast config error rather than a cluster-side
 * admission rejection after the image is already built.
 *
 * The boundary table is ONE shared fixture, also read by the operator's envtest
 * (cdn_envtest_test.go), which runs the same rows through the CRD schema + CEL in
 * a real apiserver. A bound that exists in only one validator reds one suite.
 */

interface Case {
    name: string;
    valid: boolean;
    cdn: unknown;
}

const CASES_FILE = join(
    dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "cdn-validation-cases.json",
);
// Fail closed: an unreadable or empty table must red this suite, not skip it.
const CASES = (
    JSON.parse(readFileSync(CASES_FILE, "utf8")) as { cases: Case[] }
).cases;

function configWith(cdn: unknown, extra: Record<string, unknown> = {}) {
    return {
        name: "app",
        registry: "registry",
        storage: { provider: "gcs", bucket: "bucket" },
        cdn,
        ...extra,
    } as unknown as KnativeNextConfig;
}

describe("shared cdn boundary table", () => {
    it("has rows on both sides of the bounds (the table itself is not hollow)", () => {
        expect(CASES.filter((c) => c.valid).length).toBeGreaterThanOrEqual(15);
        expect(CASES.filter((c) => !c.valid).length).toBeGreaterThanOrEqual(20);
    });

    for (const c of CASES) {
        it(`${c.valid ? "accepts" : "rejects"}: ${c.name}`, () => {
            if (c.valid) {
                expect(() => validateConfig(configWith(c.cdn))).not.toThrow();
            } else {
                expect(() => validateConfig(configWith(c.cdn))).toThrow(
                    ConfigValidationError,
                );
                expect(() => validateConfig(configWith(c.cdn))).toThrow(/cdn/);
            }
        });
    }
});

describe("cdn config shape", () => {
    it("rejects a non-object cdn", () => {
        expect(() => validateConfig(configWith("cloudflare"))).toThrow(/cdn/);
        expect(() => validateConfig(configWith([]))).toThrow(/cdn/);
    });

    it("rejects an unknown key, so a typo or a tagPrefix is not silently dropped", () => {
        expect(() =>
            validateConfig(
                configWith({ provider: "cloudflare", tagPrefix: "victim" }),
            ),
        ).toThrow(/cdn.*tagPrefix|tagPrefix.*cdn/);
    });

    it("requires a provider", () => {
        expect(() => validateConfig(configWith({}))).toThrow(/cdn\.provider/);
    });

    it("rejects non-integer numbers", () => {
        expect(() =>
            validateConfig(
                configWith({ provider: "cloudflare", htmlTTLSeconds: 1.5 }),
            ),
        ).toThrow(/htmlTTLSeconds/);
    });

    it("rejects env names in the operator-reserved KNEXT_CDN_ namespace", () => {
        expect(() =>
            validateConfig(
                configWith(undefined, {
                    env: { KNEXT_CDN_TAG_PREFIX: "victim" },
                }),
            ),
        ).toThrow(/KNEXT_CDN_/);
    });

    it("rejects secrets.envMap names in the KNEXT_CDN_ namespace", () => {
        expect(() =>
            validateConfig(
                configWith(undefined, {
                    secrets: {
                        envMap: {
                            KNEXT_CDN_PURGE_TOKEN: { name: "s", key: "k" },
                        },
                    },
                }),
            ),
        ).toThrow(/KNEXT_CDN_/);
    });

    it("accepts env names that merely resemble the prefix", () => {
        expect(() =>
            validateConfig(
                configWith(undefined, {
                    env: { KNEXT_CDNX: "1", MY_KNEXT_CDN_X: "1" },
                }),
            ),
        ).not.toThrow();
    });
});

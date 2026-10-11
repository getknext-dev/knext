import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigValidationError, validateConfig } from "../cli/validate";
import type { KnativeNextConfig } from "../config";

/**
 * networking.publicHosts is validated locally with the same shape the CRD's
 * CEL rule enforces, so a typo is a fast config error rather than a
 * cluster-side admission rejection after the image is already built.
 *
 * The boundary table is ONE shared fixture, also read by the operator's
 * envtest (networking_public_hosts_test.go), which runs the same rows through
 * the CRD's CEL rules in a real apiserver. A bound that exists in only one
 * validator therefore reds one of the two suites.
 */

interface Case {
    name: string;
    valid: boolean;
    hosts: string[];
}

const CASES_FILE = join(
    dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "public-hosts-validation-cases.json",
);
// Fail closed: an unreadable or empty table must red this suite, not skip it.
const CASES = (
    JSON.parse(readFileSync(CASES_FILE, "utf8")) as { cases: Case[] }
).cases;

function configWith(publicHosts: unknown): KnativeNextConfig {
    return {
        name: "app",
        registry: "registry",
        storage: { provider: "gcs", bucket: "bucket" },
        networking: { publicHosts },
    } as unknown as KnativeNextConfig;
}

describe("shared publicHosts boundary table", () => {
    it("has rows on both sides of the bounds (the table itself is not hollow)", () => {
        expect(CASES.filter((c) => c.valid).length).toBeGreaterThanOrEqual(8);
        expect(CASES.filter((c) => !c.valid).length).toBeGreaterThanOrEqual(20);
        const lens = CASES.flatMap((c) => c.hosts.map((h) => h.length));
        expect(lens).toContain(253);
        expect(lens).toContain(254);
        expect(CASES.map((c) => c.hosts.length)).toEqual(
            expect.arrayContaining([32, 33]),
        );
    });

    for (const c of CASES) {
        it(`${c.valid ? "accepts" : "rejects"}: ${c.name}`, () => {
            if (c.valid) {
                expect(() => validateConfig(configWith(c.hosts))).not.toThrow();
            } else {
                expect(() => validateConfig(configWith(c.hosts))).toThrow(
                    ConfigValidationError,
                );
                expect(() => validateConfig(configWith(c.hosts))).toThrow(
                    /networking\.publicHosts/,
                );
            }
        });
    }
});

describe("validateConfig networking.publicHosts", () => {
    it("accepts an empty list", () => {
        expect(() => validateConfig(configWith([]))).not.toThrow();
    });

    it("rejects a non-array value", () => {
        expect(() => validateConfig(configWith("www.example.com"))).toThrow(
            /networking\.publicHosts/,
        );
    });

    it("rejects a non-string entry", () => {
        expect(() => validateConfig(configWith([42]))).toThrow(
            ConfigValidationError,
        );
    });
});

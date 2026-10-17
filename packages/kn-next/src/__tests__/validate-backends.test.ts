import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { ConfigValidationError, validateConfig } from "../cli/validate";
import type { KnativeNextConfig } from "../config";

/**
 * `backends` is validated locally with the SAME bounds the shipped CRD
 * enforces on spec.backends, so a bad name is a fast config error before the
 * image is built rather than an admission rejection after it. The bounds are
 * read from the CRD file in this repo, not copied into the test, so a CRD that
 * changes without the validator (or the reverse) reds here.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CRD_FILE = join(
    HERE,
    "..",
    "..",
    "..",
    "kn-next-operator",
    "config",
    "crd",
    "bases",
    "apps.kn-next.dev_nextapps.yaml",
);

interface Field {
    pattern: string;
    maxLength: number;
}
interface BackendsSchema {
    maxItems: number;
    items: {
        properties: {
            name: Field;
            service: Field;
            image: Field;
            specDigest: Field;
        };
    };
    "x-kubernetes-validations": { rule: string }[];
}

// Fail closed: a CRD without spec.backends must red this suite, not skip it.
const SCHEMA = (
    YAML.parse(readFileSync(CRD_FILE, "utf8")) as {
        spec: {
            versions: {
                schema: {
                    openAPIV3Schema: {
                        properties: {
                            spec: {
                                properties: { backends: BackendsSchema };
                            };
                        };
                    };
                };
            }[];
        };
    }
).spec.versions[0]?.schema.openAPIV3Schema.properties.spec.properties
    .backends as BackendsSchema;

function configWith(backends: unknown): KnativeNextConfig {
    return {
        name: "app",
        registry: "registry",
        storage: { provider: "gcs", bucket: "bucket" },
        backends,
    } as unknown as KnativeNextConfig;
}

const accepts = (backends: unknown) =>
    expect(() => validateConfig(configWith(backends))).not.toThrow();
const rejects = (backends: unknown, message: RegExp = /backends/) => {
    expect(() => validateConfig(configWith(backends))).toThrow(
        ConfigValidationError,
    );
    expect(() => validateConfig(configWith(backends))).toThrow(message);
};

const crdAllows = (field: Field, value: string) =>
    value.length <= field.maxLength && new RegExp(field.pattern).test(value);

const LONG = (n: number) => `a${"b".repeat(n - 1)}`;
const NAMES: [string, string][] = [
    ["a simple name", "pricing"],
    ["a hyphenated name", "user-profile"],
    ["a name with digits", "fn2-v3"],
    ["63 characters", LONG(63)],
    ["64 characters", LONG(64)],
    ["an uppercase letter", "Pricing"],
    ["an underscore", "user_profile"],
    ["a double hyphen", "user--profile"],
    ["a trailing hyphen", "pricing-"],
    ["a leading hyphen", "-pricing"],
    ["a leading digit", "2pricing"],
    ["a dot", "pricing.v1"],
    ["a slash", "a/b"],
    ["a space", "user profile"],
    ["an empty string", ""],
    ["a shell metacharacter", "a;rm"],
];

describe("backends mirrors the shipped CRD", () => {
    it("the CRD defines the bounds this validator mirrors (the read is not hollow)", () => {
        expect(SCHEMA.maxItems).toBe(64);
        expect(SCHEMA.items.properties.name.maxLength).toBe(63);
        expect(SCHEMA.items.properties.service.maxLength).toBe(63);
        // The zone's optional image pin: "@sha256:" + 64 lowercase hex.
        expect(SCHEMA.items.properties.image.maxLength).toBe(72);
        expect(SCHEMA.items.properties.image.pattern).toBe(
            "^@sha256:[a-f0-9]{64}$",
        );
        // The zone's optional spec pin: "sha256:" + 64 lowercase hex.
        expect(SCHEMA.items.properties.specDigest.maxLength).toBe(71);
        expect(SCHEMA.items.properties.specDigest.pattern).toBe(
            "^sha256:[a-f0-9]{64}$",
        );
        expect(SCHEMA["x-kubernetes-validations"].map((v) => v.rule)).toContain(
            "self.all(a, self.exists_one(b, b.service == a.service))",
        );
    });

    for (const [label, value] of NAMES) {
        it(`name: agrees with the CRD on ${label}`, () => {
            const ok = crdAllows(SCHEMA.items.properties.name, value);
            if (ok) accepts([{ name: value }]);
            else rejects([{ name: value }], /backends\[0\]\.name/);
        });
        it(`service: agrees with the CRD on ${label}`, () => {
            // A service is a DNS label (the CRD allows more than a name does:
            // a leading digit, a double hyphen).
            const ok = crdAllows(SCHEMA.items.properties.service, value);
            if (ok) accepts([{ name: "fn", service: value }]);
            else
                rejects(
                    [{ name: "fn", service: value }],
                    /backends\[0\]\.service/,
                );
        });
    }

    const HEX = "ab12".repeat(16);
    const PINS: [string, string][] = [
        ["a lowercase sha256 digest", `@sha256:${HEX}`],
        ["a digest without the @", `sha256:${HEX}`],
        ["a full image reference", `registry/app@sha256:${HEX}`],
        ["a tag", ":v1"],
        ["63 hex characters", `@sha256:${HEX.slice(1)}`],
        ["65 hex characters", `@sha256:${HEX}0`],
        ["uppercase hex", `@sha256:${HEX.toUpperCase()}`],
        ["another algorithm", `@sha512:${HEX}`],
        ["non-hex characters", `@sha256:${"z".repeat(64)}`],
        ["a trailing newline", `@sha256:${HEX}\n`],
        ["an empty string", ""],
    ];
    for (const [label, value] of PINS) {
        it(`image: agrees with the CRD on ${label}`, () => {
            const ok = crdAllows(SCHEMA.items.properties.image, value);
            if (ok) accepts([{ name: "fn", image: value }]);
            else
                rejects([{ name: "fn", image: value }], /backends\[0\]\.image/);
        });
    }

    const SPEC_PINS: [string, string][] = [
        ["a lowercase sha256 digest", `sha256:${HEX}`],
        ["an image-style @sha256 digest", `@sha256:${HEX}`],
        ["a bare hex digest", HEX],
        ["a full image reference", `registry/app@sha256:${HEX}`],
        ["63 hex characters", `sha256:${HEX.slice(1)}`],
        ["65 hex characters", `sha256:${HEX}0`],
        ["uppercase hex", `sha256:${HEX.toUpperCase()}`],
        ["another algorithm", `sha512:${HEX}`],
        ["non-hex characters", `sha256:${"z".repeat(64)}`],
        ["a trailing newline", `sha256:${HEX}\n`],
        ["an empty string", ""],
    ];
    for (const [label, value] of SPEC_PINS) {
        it(`specDigest: agrees with the CRD on ${label}`, () => {
            const ok = crdAllows(SCHEMA.items.properties.specDigest, value);
            if (ok) accepts([{ name: "fn", specDigest: value }]);
            else
                rejects(
                    [{ name: "fn", specDigest: value }],
                    /backends\[0\]\.specDigest/,
                );
        });
    }

    it("accepts exactly maxItems entries and refuses one more", () => {
        const entries = (n: number) =>
            Array.from({ length: n }, (_, i) => ({ name: `fn-${i}` }));
        accepts(entries(SCHEMA.maxItems));
        rejects(entries(SCHEMA.maxItems + 1), /backends.*64/);
    });
});

describe("validateConfig backends", () => {
    it("accepts no backends, and an empty list", () => {
        expect(() =>
            validateConfig({
                name: "app",
                registry: "registry",
                storage: { provider: "gcs", bucket: "bucket" },
            } as KnativeNextConfig),
        ).not.toThrow();
        accepts([]);
    });

    it("accepts a function bound by name alone, and with an explicit service", () => {
        accepts([{ name: "pricing" }]);
        accepts([{ name: "pricing", service: "pricing-fn" }]);
    });

    it("accepts an image pin, and refuses a non-string one", () => {
        accepts([{ name: "pricing", image: `@sha256:${"ab12".repeat(16)}` }]);
        accepts([
            {
                name: "pricing",
                service: "pricing-fn",
                image: `@sha256:${"ab12".repeat(16)}`,
            },
        ]);
        rejects([{ name: "pricing", image: 7 }], /backends\[0\]\.image/);
    });

    it("accepts a spec pin next to an image pin, and refuses a non-string one", () => {
        accepts([
            { name: "pricing", specDigest: `sha256:${"ab12".repeat(16)}` },
        ]);
        accepts([
            {
                name: "pricing",
                image: `@sha256:${"ab12".repeat(16)}`,
                specDigest: `sha256:${"cd34".repeat(16)}`,
            },
        ]);
        rejects(
            [{ name: "pricing", specDigest: 7 }],
            /backends\[0\]\.specDigest/,
        );
    });

    it("tells the user what a spec pin looks like, and where it comes from", () => {
        rejects(
            [{ name: "pricing", specDigest: `@sha256:${"ab12".repeat(16)}` }],
            /backends\[0\]\.specDigest.*sha256:.*knext deploy function/s,
        );
    });

    it("tells the user what an image pin looks like, and not to paste the whole reference", () => {
        rejects(
            [
                {
                    name: "pricing",
                    image: `registry/app@sha256:${"ab12".repeat(16)}`,
                },
            ],
            /backends\[0\]\.image.*@sha256:/,
        );
    });

    it("refuses a value that is not a list", () => {
        rejects("pricing", /'backends' must be an array/);
        rejects({ name: "pricing" }, /'backends' must be an array/);
    });

    it("refuses an entry that is not an object, or has no name", () => {
        rejects(["pricing"], /backends\[0\]/);
        rejects([null], /backends\[0\]/);
        rejects([{}], /backends\[0\]\.name/);
        rejects([{ service: "pricing" }], /backends\[0\]\.name/);
    });

    it("refuses an unknown key, naming the keys that exist", () => {
        rejects(
            [{ name: "pricing", serviceName: "pricing" }],
            /backends\[0\]\.serviceName.*name, service, image, specDigest/,
        );
    });

    it("refuses a non-string name or service", () => {
        rejects([{ name: 7 }], /backends\[0\]\.name/);
        rejects([{ name: "pricing", service: 7 }], /backends\[0\]\.service/);
    });

    it("refuses the same binding name twice (the CRD list is keyed by name)", () => {
        rejects(
            [
                { name: "pricing", service: "a" },
                { name: "pricing", service: "b" },
            ],
            /backends.*"pricing".*more than once/,
        );
    });

    it("refuses the same function bound twice (the CRD allows each service once)", () => {
        rejects(
            [
                { name: "pricing" },
                { name: "pricing-again", service: "pricing" },
            ],
            /backends.*"pricing".*bound more than once/,
        );
    });

    it("reports every problem at once, not just the first", () => {
        let text = "";
        try {
            validateConfig(configWith([{ name: "Bad" }, { name: "worse_" }]));
        } catch (err) {
            text = (err as Error).message;
        }
        expect(text).toContain("backends[0].name");
        expect(text).toContain("backends[1].name");
    });
});

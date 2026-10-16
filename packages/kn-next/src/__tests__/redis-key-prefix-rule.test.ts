import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { redisPrefixCheck } from "../cli/doctor/checks/redis-prefix";
import type { CheckContext, KubectlFn } from "../cli/doctor/types";
import {
    KEY_PREFIX_MAX_LENGTH,
    KEY_PREFIX_PATTERN,
    KEY_PREFIX_RESERVED_RULE,
    keyPrefixProblem,
} from "../cli/redis-key-prefix";
import { preflightCRSchema } from "../cli/schema/preflight";
import { validateConfig } from "../cli/validate";
import type { KnativeNextConfig } from "../config";

/**
 * `spec.cache.keyPrefix` is validated by the apiserver at admission (the CRD
 * carries a pattern, a maxLength and a CEL rule). The CLI holds an early copy
 * of the same rule so a bad prefix fails `knext deploy` before the build, and
 * `knext doctor` names stored apps the new rule would refuse on their next
 * change. Three copies of one rule is the both-halves defect class, so the
 * lockstep block reads the GENERATED CRD and fails if either side moves.
 */

const CRD_PATH = join(
    import.meta.dir,
    "../../../kn-next-operator/config/crd/bases/apps.kn-next.dev_nextapps.yaml",
);

function crdKeyPrefixSchema(): {
    pattern?: string;
    maxLength?: number;
    "x-kubernetes-validations"?: { rule: string; message?: string }[];
} {
    const crd = YAML.parse(readFileSync(CRD_PATH, "utf8"));
    const version = crd.spec.versions.find(
        (v: { name: string }) => v.name === "v1alpha1",
    );
    return version.schema.openAPIV3Schema.properties.spec.properties.cache
        .properties.keyPrefix;
}

const INVALID = [
    "kn-*",
    "kn-nex?",
    "kn-[a",
    "kn-a]",
    "kn-a\\b",
    "my app",
    "my\tapp",
    "my\napp",
    "my\rapp",
    "my\fapp",
    "my\vapp",
    "a".repeat(64),
    // maxLength counts code points (the apiserver), not UTF-16 units.
    "\u{1F600}".repeat(64),
    "kn-next",
    "kn-next:cache",
];
const VALID = [
    "myapp",
    "kn-0123456789ab",
    "tenant-a:shop",
    "kn-nextapp",
    "kn-next-v2",
    "a".repeat(63),
    "\u{1F600}".repeat(63),
    `${"a".repeat(62)}\u{1F600}`,
    "app.v1_blue@eu/1",
];

describe("keyPrefixProblem — the CLI copy of the admission rule", () => {
    for (const prefix of INVALID) {
        it(`refuses ${JSON.stringify(prefix)}`, () => {
            expect(keyPrefixProblem(prefix)).toBeString();
        });
    }
    for (const prefix of VALID) {
        it(`accepts ${JSON.stringify(prefix)}`, () => {
            expect(keyPrefixProblem(prefix)).toBeUndefined();
        });
    }
    it("accepts the empty string — empty is unset, the operator derives a default", () => {
        expect(keyPrefixProblem("")).toBeUndefined();
    });
    it("names the reserved keyspace when that is the problem", () => {
        expect(keyPrefixProblem("kn-next:uc")).toContain("reserved");
    });
});

describe("lockstep with the generated CRD", () => {
    const schema = crdKeyPrefixSchema();
    it("the CRD pattern is the CLI pattern, byte for byte", () => {
        expect(schema.pattern).toBe(KEY_PREFIX_PATTERN);
    });
    it("the CRD maxLength is the CLI max length", () => {
        expect(schema.maxLength).toBe(KEY_PREFIX_MAX_LENGTH);
    });
    it("the CRD carries the reserved-keyspace CEL rule the CLI mirrors", () => {
        const rules = (schema["x-kubernetes-validations"] ?? []).map(
            (r) => r.rule,
        );
        expect(rules).toEqual([KEY_PREFIX_RESERVED_RULE]);
    });
    it("the CRD pattern, compiled as JS, agrees with keyPrefixProblem on every vector", () => {
        // Go RE2 (what the apiserver runs) and JS agree on this class: every
        // escape in it is ASCII, so \s-style Unicode differences cannot apply.
        const re = new RegExp(schema.pattern ?? "(?!)");
        for (const p of [...INVALID, ...VALID]) {
            const crdOk =
                re.test(p) &&
                // OpenAPI maxLength on a string counts code points.
                [...p].length <= (schema.maxLength ?? 0) &&
                p !== "kn-next" &&
                !p.startsWith("kn-next:");
            expect({ p, ok: keyPrefixProblem(p) === undefined }).toEqual({
                p,
                ok: crdOk,
            });
        }
    });
});

describe("validateConfig — knext deploy fails early on a bad cache.keyPrefix", () => {
    const base: KnativeNextConfig = {
        name: "shop",
        registry: "ghcr.io/someone",
        cache: { provider: "redis", url: "redis://redis:6379" },
    };
    it("rejects a glob character", () => {
        expect(() =>
            validateConfig({
                ...base,
                cache: {
                    provider: "redis",
                    url: "redis://r:6379",
                    keyPrefix: "shop*",
                },
            }),
        ).toThrow(/cache\.keyPrefix/);
    });
    it("rejects the reserved shared keyspace", () => {
        expect(() =>
            validateConfig({
                ...base,
                cache: {
                    provider: "redis",
                    url: "redis://r:6379",
                    keyPrefix: "kn-next",
                },
            }),
        ).toThrow(/cache\.keyPrefix/);
    });
    it("accepts a valid prefix and an absent one", () => {
        expect(() =>
            validateConfig({
                ...base,
                cache: {
                    provider: "redis",
                    url: "redis://r:6379",
                    keyPrefix: "shop",
                },
            }),
        ).not.toThrow();
        expect(() => validateConfig(base)).not.toThrow();
    });
});

describe("preflight — an admission rejection blocks before anything is uploaded", () => {
    it("a keyPrefix Invalid from the server-side dry run is 'blocked', with the apiserver message kept", () => {
        const stderr =
            'The NextApp "shop" is invalid: spec.cache.keyPrefix: Invalid value: "shop*": spec.cache.keyPrefix in body should match \'^[^*?\\[\\]\\\\ \\t\\n\\r\\f\\v]*$\'';
        const outcome = preflightCRSchema(
            { kubectl: () => ({ ok: false, stdout: "", stderr }) },
            { crPath: "/nonexistent.yaml", namespace: "default" },
        );
        expect(outcome.verdict).toBe("blocked");
        expect(outcome.stderr).toContain("spec.cache.keyPrefix");
    });
});

describe("doctor — names stored apps the admission rule would refuse", () => {
    function ctxWith(
        apps: { name: string; cache?: Record<string, string> }[],
    ): CheckContext {
        const kubectl: KubectlFn = () => ({
            ok: true,
            stderr: "",
            stdout: JSON.stringify({
                items: apps.map((a) => ({
                    metadata: { name: a.name, namespace: "default" },
                    spec: { cache: a.cache },
                })),
            }),
        });
        // biome-ignore lint/suspicious/noExplicitAny: only kubectl is read
        return { deps: {} as any, kubectl, skipAll: false };
    }

    it("warns on an invalid keyPrefix, naming the app and the fix", () => {
        const [row] = redisPrefixCheck(
            ctxWith([
                {
                    name: "shop",
                    cache: { provider: "redis", keyPrefix: "shop*" },
                },
            ]),
        );
        expect(row.status).toBe("warn");
        expect(row.detail).toContain("default/shop");
        expect(row.detail).toContain("shop*");
        expect(row.detail).toContain("the cluster now refuses it");
    });

    it("warns even when the app's cache is not Redis (admission validates the field regardless)", () => {
        const rows = redisPrefixCheck(
            ctxWith([
                {
                    name: "blog",
                    cache: { provider: "memory", keyPrefix: "my blog" },
                },
            ]),
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe("warn");
        expect(rows[0].detail).toContain("default/blog");
    });

    it("stays silent about valid prefixes", () => {
        const [row] = redisPrefixCheck(
            ctxWith([
                {
                    name: "shop",
                    cache: { provider: "redis", keyPrefix: "shop" },
                },
            ]),
        );
        expect(row.status).toBe("pass");
    });
});

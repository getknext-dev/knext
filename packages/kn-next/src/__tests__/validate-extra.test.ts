/**
 * validate.ts — the CLI-side config gate branches that mirror the operator's CRD
 * rules (#186 env, #417 database roSecretRef, ADR-0016 queue, runtime, #435
 * resource quantities, #431 bytecode size). Complements the existing validate-*
 * suites with the reserved-env / db-roSecretRef / kafka-brokerUrl / runtime /
 * quantity error branches.
 */

import { describe, expect, it } from "vitest";
import { validateConfig } from "../cli/validate";
import type { KnativeNextConfig } from "../config";

const base: KnativeNextConfig = {
    name: "my-app",
    registry: "reg.example.com",
    storage: { provider: "gcs", bucket: "b", publicUrl: "https://x" },
};

function cfg(over: Partial<KnativeNextConfig>): KnativeNextConfig {
    return { ...base, ...over };
}

describe("validateConfig — CRD-mirroring branches", () => {
    it("rejects database.roSecretRef without database.secretRef", () => {
        expect(() =>
            validateConfig(
                cfg({
                    database: { roSecretRef: { name: "s-ro" } },
                } as Partial<KnativeNextConfig>),
            ),
        ).toThrow(/roSecretRef.*requires.*secretRef/);
    });

    it("rejects a reserved env name", () => {
        expect(() => validateConfig(cfg({ env: { PORT: "3000" } }))).toThrow(
            /reserved name/,
        );
    });

    it("rejects an invalid env var name", () => {
        expect(() => validateConfig(cfg({ env: { "1BAD": "x" } }))).toThrow(
            /valid environment variable name/,
        );
    });

    it("accepts a valid env var name", () => {
        expect(() =>
            validateConfig(cfg({ env: { MY_FLAG: "1" } })),
        ).not.toThrow();
    });

    it("rejects a kafka queue without brokerUrl", () => {
        expect(() =>
            validateConfig(
                cfg({
                    queue: { provider: "kafka" },
                } as Partial<KnativeNextConfig>),
            ),
        ).toThrow(/queue\.brokerUrl.*required/);
    });

    it("rejects an unsupported runtime", () => {
        expect(() =>
            validateConfig(cfg({ runtime: "deno" as unknown as "node" })),
        ).toThrow(/Runtime 'deno' is not supported/);
    });

    it("rejects a malformed resource quantity", () => {
        expect(() =>
            validateConfig(
                cfg({
                    scaling: { cpuRequest: "1GB" },
                } as Partial<KnativeNextConfig>),
            ),
        ).toThrow(/is not a valid Kubernetes quantity/);
    });

    it("rejects a non-positive resource quantity", () => {
        expect(() =>
            validateConfig(
                cfg({
                    scaling: { memoryLimit: "0" },
                } as Partial<KnativeNextConfig>),
            ),
        ).toThrow(/must be a positive quantity/);
    });

    it("rejects a negative minScale", () => {
        expect(() =>
            validateConfig(cfg({ scaling: { minScale: -1 } })),
        ).toThrow(/minScale.*>= 0/);
    });

    it("rejects a maxScale below 1", () => {
        expect(() => validateConfig(cfg({ scaling: { maxScale: 0 } }))).toThrow(
            /maxScale.*>= 1/,
        );
    });

    it("rejects minScale greater than maxScale", () => {
        expect(() =>
            validateConfig(cfg({ scaling: { minScale: 5, maxScale: 2 } })),
        ).toThrow(/minScale.*cannot be greater than.*maxScale/);
    });

    it("rejects out-of-range #415 scaling knobs", () => {
        expect(() =>
            validateConfig(
                cfg({
                    scaling: { containerConcurrency: -1 },
                } as Partial<KnativeNextConfig>),
            ),
        ).toThrow(/containerConcurrency.*>= 0/);
        expect(() =>
            validateConfig(
                cfg({
                    scaling: { panicWindowPercentage: 101 },
                } as Partial<KnativeNextConfig>),
            ),
        ).toThrow(/panicWindowPercentage.*between 1 and 100/);
        expect(() =>
            validateConfig(
                cfg({
                    scaling: { panicThresholdPercentage: 100 },
                } as Partial<KnativeNextConfig>),
            ),
        ).toThrow(/panicThresholdPercentage.*>= 110/);
    });

    it("rejects an unsupported storage provider and a missing bucket", () => {
        expect(() =>
            validateConfig(
                cfg({
                    storage: {
                        provider: "ftp" as unknown as "gcs",
                        bucket: "",
                        publicUrl: "https://x",
                    },
                }),
            ),
        ).toThrow(/Storage provider 'ftp' is not supported/);
    });

    it("rejects an unsupported cache provider and a redis cache with no url", () => {
        expect(() =>
            validateConfig(
                cfg({
                    cache: { provider: "dynamodb" } as unknown as never,
                }),
            ),
        ).toThrow(/Cache provider 'dynamodb' is not supported/);
        expect(() =>
            validateConfig(
                cfg({
                    cache: { provider: "redis" },
                } as Partial<KnativeNextConfig>),
            ),
        ).toThrow(/cache\.url.*required.*Redis/);
    });

    it("rejects poolMax < 0 and targetBurstCapacity < -1", () => {
        expect(() =>
            validateConfig(
                cfg({ scaling: { poolMax: -1 } } as Partial<KnativeNextConfig>),
            ),
        ).toThrow(/poolMax.*>= 0/);
        expect(() =>
            validateConfig(
                cfg({
                    scaling: { targetBurstCapacity: -2 },
                } as Partial<KnativeNextConfig>),
            ),
        ).toThrow(/targetBurstCapacity.*-1 or >= 0/);
    });

    it("accepts valid scaling quantities + a positive bytecode size", () => {
        expect(() =>
            validateConfig(
                cfg({
                    scaling: { cpuRequest: "250m", memoryLimit: "512Mi" },
                } as Partial<KnativeNextConfig>),
            ),
        ).not.toThrow();
    });
});

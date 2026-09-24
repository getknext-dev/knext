import { describe, expect, it } from "bun:test";
import { ConfigValidationError, validateConfig } from "../cli/validate";
import type { KnativeNextConfig } from "../config";

/**
 * `healthCheckPath` now flows into the image-build compile-cache bake as
 * `KNEXT_WARM_PATH` (a COMMA-SEPARATED list of paths — see
 * `templates/runtime-standalone/knext-compile-cache-bake.mjs.hbs` and the
 * vinext-node/standalone-node entry templates). A value with an embedded
 * comma or whitespace corrupts that list, and a value missing the leading
 * slash is not a valid path at all. Validate it here, at config-validation
 * time, mirroring the shape the bake actually requires.
 *
 * `loadConfig` (cli/shared.ts) is the single call site of `validateConfig`
 * used by `deploy`, `preview`, and `build` (each via `loadConfig()`), so a
 * check here covers all three paths without duplicating it per-command.
 */

function baseConfig(healthCheckPath?: string): KnativeNextConfig {
    return {
        name: "app",
        registry: "registry",
        storage: { provider: "gcs", bucket: "bucket" },
        ...(healthCheckPath !== undefined ? { healthCheckPath } : {}),
    } as KnativeNextConfig;
}

describe("validateConfig healthCheckPath checks", () => {
    it("accepts a config with no healthCheckPath (the Dockerfile default applies)", () => {
        expect(() => validateConfig(baseConfig())).not.toThrow();
    });

    it("accepts the root path '/'", () => {
        expect(() => validateConfig(baseConfig("/"))).not.toThrow();
    });

    it("accepts a nested path '/api/health'", () => {
        expect(() => validateConfig(baseConfig("/api/health"))).not.toThrow();
    });

    it("accepts a path with a query string '/healthz?x=1'", () => {
        expect(() => validateConfig(baseConfig("/healthz?x=1"))).not.toThrow();
    });

    it("rejects a path missing the leading slash", () => {
        expect(() => validateConfig(baseConfig("health"))).toThrow(
            ConfigValidationError,
        );
        expect(() => validateConfig(baseConfig("health"))).toThrow(
            /healthCheckPath/,
        );
    });

    it("rejects a path containing a comma (corrupts the KNEXT_WARM_PATH list)", () => {
        expect(() => validateConfig(baseConfig("/a,b"))).toThrow(
            ConfigValidationError,
        );
        expect(() => validateConfig(baseConfig("/a,b"))).toThrow(/comma/i);
    });

    it("rejects a path containing a space", () => {
        expect(() => validateConfig(baseConfig("/a b"))).toThrow(
            ConfigValidationError,
        );
    });

    it("rejects a path containing a tab", () => {
        expect(() => validateConfig(baseConfig("/a\tb"))).toThrow(
            ConfigValidationError,
        );
    });

    it("rejects an empty string", () => {
        expect(() => validateConfig(baseConfig(""))).toThrow(
            ConfigValidationError,
        );
    });

    it("names the offending value in the error message", () => {
        expect(() => validateConfig(baseConfig("health"))).toThrow(/health/);
    });

    it("rejects a non-string value (null) with a ConfigValidationError, not a raw TypeError", () => {
        const config = baseConfig() as unknown as Record<string, unknown>;
        config.healthCheckPath = null;
        expect(() =>
            validateConfig(config as unknown as KnativeNextConfig),
        ).toThrow(ConfigValidationError);
        expect(() =>
            validateConfig(config as unknown as KnativeNextConfig),
        ).toThrow(/healthCheckPath/);
    });

    it("rejects a non-string value (number) with a ConfigValidationError, not a raw TypeError", () => {
        const config = baseConfig() as unknown as Record<string, unknown>;
        config.healthCheckPath = 123;
        expect(() =>
            validateConfig(config as unknown as KnativeNextConfig),
        ).toThrow(ConfigValidationError);
        expect(() =>
            validateConfig(config as unknown as KnativeNextConfig),
        ).toThrow(/healthCheckPath/);
    });
});

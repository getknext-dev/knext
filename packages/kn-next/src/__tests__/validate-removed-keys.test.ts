import { describe, expect, it } from "bun:test";
import { buildNextAppCRObject } from "../cli/cr-builder";
import { validateConfig } from "../cli/validate";

/**
 * A REMOVED config key must fail loudly, not vanish.
 *
 * When the PVC-backed bytecode cache was deleted, `bytecodeCache` stopped being read
 * by anything. A config still carrying it therefore validated clean and deployed
 * successfully, silently dropping a setting its author believed was in force — while
 * the docs promised that exact combination would FAIL the deploy. The documentation
 * was not merely stale; it described a safety property the code did not have.
 *
 * These tests pin the behaviour the docs describe. The last one pins the reason: it
 * asserts the CR really is emitted without the field, so if someone ever makes the
 * emitter carry it again, the "silently dropped" premise is re-examined rather than
 * this rejection being deleted as noise.
 */

const DIGEST = `registry.example.com/app@sha256:${"a".repeat(64)}`;

function baseConfig(): Record<string, unknown> {
    return {
        name: "probe",
        registry: "registry.example.com",
        storage: { provider: "gcs", bucket: "b" },
        cache: { provider: "redis", url: "redis://x:6379" },
    };
}

describe("removed config keys", () => {
    it("rejects a stale 'bytecodeCache' block instead of ignoring it", () => {
        const cfg = {
            ...baseConfig(),
            bytecodeCache: { enabled: true, size: "1Gi" },
        };
        expect(() => validateConfig(cfg as never)).toThrow(/bytecodeCache/);
    });

    it("rejects it even when disabled — the key itself is the stale thing", () => {
        const cfg = { ...baseConfig(), bytecodeCache: { enabled: false } };
        expect(() => validateConfig(cfg as never)).toThrow(/bytecodeCache/);
    });

    it("names the replacement, so the error is actionable without the changelog", () => {
        const cfg = { ...baseConfig(), bytecodeCache: { enabled: true } };
        expect(() => validateConfig(cfg as never)).toThrow(
            /baked into your image/,
        );
    });

    it("accepts the same config once the stale key is gone", () => {
        expect(() => validateConfig(baseConfig() as never)).not.toThrow();
    });

    it("still emits no bytecode fields in the CR — the premise of the rejection", () => {
        const cr = buildNextAppCRObject(
            baseConfig() as never,
            DIGEST,
            "default",
        ) as {
            spec: { cache?: Record<string, unknown> };
        };
        expect(cr.spec.cache).not.toHaveProperty("enableBytecodeCache");
        expect(cr.spec.cache).not.toHaveProperty("bytecodeCacheSize");
        // the DATA cache must still come through — this is not a blanket drop
        expect(cr.spec.cache?.provider).toBe("redis");
    });
});

/**
 * #309 (one of four criteria) — make the DEGRADED compile cache observable.
 *
 * `compile-cache-volume-fallback.test.ts` pins the safety half: a broken cache
 * volume degrades instead of crashing the boot. The cost of that safety is
 * SILENCE — V8 disables the cache and says nothing, so a pod whose cache volume
 * is unwritable, unmounted, or not a directory boots fine and just runs at cold
 * speed forever, with no signal anywhere. #440 made the SHADOW case observable
 * (`compile-cache-shadow.ts`); this makes the UNAVAILABLE case observable, with
 * the same discipline:
 *
 *   diagnostics only · never throws · never delays boot · SILENT on any
 *   uncertainty (unset env, or a runtime that cannot report a cache dir).
 *
 * The signal is `module.getCompileCacheDir()`: a string when V8 accepted the
 * directory, `undefined` when it refused it and silently disabled the cache.
 */

import { readFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
    evaluateCompileCacheStatus,
    warnOnDegradedCompileCache,
} from "../adapters/compile-cache-health";

const NODE_SERVER_SRC = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../adapters/node-server.ts",
);

const PVC = "/mnt/bytecode-cache/latest";

describe("evaluateCompileCacheStatus (pure)", () => {
    it("is 'active' when the requested dir was accepted", () => {
        expect(evaluateCompileCacheStatus(PVC, `${PVC}/v24-arm64`)).toBe(
            "active",
        );
    });

    it("is 'degraded' when a requested dir was silently refused", () => {
        expect(evaluateCompileCacheStatus(PVC, undefined)).toBe("degraded");
        expect(evaluateCompileCacheStatus(PVC, "")).toBe("degraded");
    });

    it("is 'unset' when NODE_COMPILE_CACHE was never injected", () => {
        expect(evaluateCompileCacheStatus(undefined, undefined)).toBe("unset");
        expect(evaluateCompileCacheStatus("", undefined)).toBe("unset");
    });

    it("is 'unknown' when the runtime cannot report a cache dir at all", () => {
        // Bun has no `module.getCompileCacheDir`, so "no dir reported" there
        // means "cannot tell", NOT "refused". Reporting that as degraded would
        // warn on every Bun pod — a false alarm, which is exactly the failure
        // mode #451 spent a round removing from the sibling diagnostic.
        expect(evaluateCompileCacheStatus(PVC, undefined, false)).toBe(
            "unknown",
        );
    });
});

describe("warnOnDegradedCompileCache", () => {
    function logger() {
        return { warn: vi.fn() };
    }

    it("warns ONCE, naming the path, when the cache was refused", () => {
        const log = logger();
        const status = warnOnDegradedCompileCache({
            env: { NODE_COMPILE_CACHE: PVC },
            getCompileCacheDir: () => undefined,
            log,
        });
        expect(status).toBe("degraded");
        expect(log.warn).toHaveBeenCalledTimes(1);
        const [context, message] = log.warn.mock.calls[0] as [
            Record<string, unknown>,
            string,
        ];
        expect(context.nodeCompileCache).toBe(PVC);
        expect(message).toContain(PVC);
        // The message must say what actually happened: still serving, no
        // bytecode reuse. A warning that does not say "boot is fine" invites
        // the wrong incident response.
        expect(message).toMatch(/cold start/i);
    });

    it("is SILENT when the cache is active", () => {
        const log = logger();
        const status = warnOnDegradedCompileCache({
            env: { NODE_COMPILE_CACHE: PVC },
            getCompileCacheDir: () => `${PVC}/v24-arm64`,
            log,
        });
        expect(status).toBe("active");
        expect(log.warn).not.toHaveBeenCalled();
    });

    it("is SILENT when NODE_COMPILE_CACHE is unset", () => {
        const log = logger();
        const status = warnOnDegradedCompileCache({
            env: {},
            getCompileCacheDir: () => undefined,
            log,
        });
        expect(status).toBe("unset");
        expect(log.warn).not.toHaveBeenCalled();
    });

    it("is SILENT on a runtime with no getCompileCacheDir (Bun)", () => {
        const log = logger();
        const status = warnOnDegradedCompileCache({
            env: { NODE_COMPILE_CACHE: PVC },
            getCompileCacheDir: undefined,
            log,
        });
        expect(status).toBe("unknown");
        expect(log.warn).not.toHaveBeenCalled();
    });

    it("never throws when the probe throws", () => {
        const log = logger();
        expect(() =>
            warnOnDegradedCompileCache({
                env: { NODE_COMPILE_CACHE: PVC },
                getCompileCacheDir: () => {
                    throw new Error("probe exploded");
                },
                log,
            }),
        ).not.toThrow();
        expect(log.warn).not.toHaveBeenCalled();
    });

    it("never throws when the LOGGER throws", () => {
        // Fail-open in the strong sense: a diagnostic must not be able to take
        // the boot down, even through its own logger.
        const log = {
            warn: () => {
                throw new Error("logger exploded");
            },
        };
        expect(() =>
            warnOnDegradedCompileCache({
                env: { NODE_COMPILE_CACHE: PVC },
                getCompileCacheDir: () => undefined,
                log,
            }),
        ).not.toThrow();
    });

    it("reaches the REAL runtime probe when none is injected", () => {
        // Wiring, not decoration: with no `getCompileCacheDir` KEY at all the
        // production default must be reached. The vitest process runs WITHOUT
        // NODE_COMPILE_CACHE, so the real probe returns undefined — and since
        // this Node HAS the API, the only honest verdict for a claimed-but-
        // absent cache is 'degraded'. A stubbed-out or missing default probe
        // would report 'unknown' here instead, so this cannot pass on a
        // decoration.
        expect(
            typeof (nodeModule as { getCompileCacheDir?: unknown })
                .getCompileCacheDir,
            "precondition: this Node must expose module.getCompileCacheDir",
        ).toBe("function");
        expect(process.env.NODE_COMPILE_CACHE).toBeUndefined();

        const log = logger();
        const status = warnOnDegradedCompileCache({
            env: { NODE_COMPILE_CACHE: PVC },
            log,
        });
        expect(status).toBe("degraded");
        expect(log.warn).toHaveBeenCalledTimes(1);
    });
});

describe("#309 node-server.ts wiring (source guard)", () => {
    const src = readFileSync(NODE_SERVER_SRC, "utf8");

    it("registers the health check as a DEFERRED step", () => {
        expect(src).toContain('from "./compile-cache-health"');
        expect(src).toContain('name: "compile-cache-health-check"');
        expect(src).toContain("warnOnDegradedCompileCache(");
    });

    it("does NOT run the check eagerly on the cold-start path", () => {
        // The other half of the scan. The diagnostic is cheap but it is still
        // a diagnostic: putting it before the spawn would spend the child's
        // boot budget on it, which is precisely the #441 mistake.
        const stepsAt = src.indexOf("steps: [");
        const callAt = src.indexOf("warnOnDegradedCompileCache(");
        const spawnAt = src.indexOf("spawn(process.execPath");
        expect(stepsAt).toBeGreaterThan(-1);
        expect(callAt).toBeGreaterThan(-1);
        expect(spawnAt).toBeGreaterThan(-1);
        // The only call site is inside the deferred steps array.
        expect(src.match(/warnOnDegradedCompileCache\(/g)).toHaveLength(1);
        expect(callAt).toBeGreaterThan(stepsAt);
        // ...and nothing awaits it before the spawn.
        expect(src).not.toContain("await warnOnDegradedCompileCache(");
    });
});

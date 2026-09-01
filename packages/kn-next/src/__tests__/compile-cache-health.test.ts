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
 *   diagnostics only · never throws · never delays boot · SILENT on anything
 *   that is not a genuine refusal.
 *
 * The signal is `module.getCompileCacheDir()`: a string when V8 accepted the
 * directory, `undefined` when it refused it and silently disabled the cache.
 *
 * Two ways that signal lies, both covered below because both produce a FALSE
 * ALARM — the failure class #451 spent a round removing from the sibling
 * diagnostic:
 *  - **Bun** exports `getCompileCacheDir` and returns `undefined` even for a
 *    healthy writable dir, so feature-detection is not enough. Asserted here
 *    against the pure decision AND, in `compile-cache-health-bun.test.ts`,
 *    against a REAL bun process running this module.
 *  - **`NODE_DISABLE_COMPILE_CACHE`** is Node's documented opt-out: the cache
 *    is off by request while the CMD still exports `NODE_COMPILE_CACHE`.
 */

import { describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NODE_BIN } from "../../../../tests/helpers/runtime-binaries";
import {
    type CompileCacheSignals,
    evaluateCompileCacheStatus,
    runtimeHonoursCompileCache,
    warnOnDegradedCompileCache,
} from "../adapters/compile-cache-health";

const NODE_SERVER_SRC = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../adapters/node-server.ts",
);

const PVC = "/mnt/bytecode-cache/latest";

/** A healthy Node pod: probe present, runtime honours the cache, no opt-out. */
function signals(over: Partial<CompileCacheSignals> = {}): CompileCacheSignals {
    return {
        requested: PVC,
        effective: `${PVC}/v24-arm64`,
        probeSupported: true,
        runtimeHonoursCompileCache: true,
        disabledByRequest: false,
        ...over,
    };
}

describe("evaluateCompileCacheStatus (pure)", () => {
    it("is 'active' when the requested dir was accepted", () => {
        expect(evaluateCompileCacheStatus(signals())).toBe("active");
    });

    it("is 'degraded' when a requested dir was silently refused", () => {
        expect(
            evaluateCompileCacheStatus(signals({ effective: undefined })),
        ).toBe("degraded");
        expect(evaluateCompileCacheStatus(signals({ effective: "" }))).toBe(
            "degraded",
        );
    });

    it("is 'unset' when NODE_COMPILE_CACHE was never injected", () => {
        expect(
            evaluateCompileCacheStatus(
                signals({ requested: undefined, effective: undefined }),
            ),
        ).toBe("unset");
        expect(
            evaluateCompileCacheStatus(
                signals({ requested: "", effective: undefined }),
            ),
        ).toBe("unset");
    });

    it("is 'unknown' when the runtime exposes no probe at all", () => {
        expect(
            evaluateCompileCacheStatus(
                signals({ probeSupported: false, effective: undefined }),
            ),
        ).toBe("unknown");
    });

    it("is 'unknown' on a runtime that does not IMPLEMENT the cache (Bun)", () => {
        // The real Bun shape: the probe EXISTS (probeSupported true) and
        // returns undefined for a healthy dir. Deciding on the probe alone
        // would say 'degraded' and warn on every Bun pod.
        expect(
            evaluateCompileCacheStatus(
                signals({
                    probeSupported: true,
                    runtimeHonoursCompileCache: false,
                    effective: undefined,
                }),
            ),
        ).toBe("unknown");
    });

    it("is 'disabled' when NODE_DISABLE_COMPILE_CACHE opted out", () => {
        // Deliberately off is not "refused" — reporting it as degraded sends
        // the operator hunting a volume problem that does not exist.
        expect(
            evaluateCompileCacheStatus(
                signals({ disabledByRequest: true, effective: undefined }),
            ),
        ).toBe("disabled");
    });
});

describe("runtimeHonoursCompileCache", () => {
    it("is false under Bun ≤1.3 and true under Node", () => {
        expect(runtimeHonoursCompileCache({ bun: "1.3.5" })).toBe(false);
        expect(runtimeHonoursCompileCache({})).toBe(true);
    });

    it("reads process.versions by default", () => {
        // Asserts the DEFAULT BINDING — that omitting the argument consults the
        // real runtime — by comparing against the same call made explicitly.
        //
        // It used to assert `process.versions.bun === undefined`, on a comment
        // that read "the suite runs under Node". That was true under vitest and
        // stopped being true when the suite moved to `bun test`. It kept passing
        // on bun 1.3 only by coincidence — the function returns false there, and
        // `bun === undefined` is also false — and went red the moment CI moved to
        // bun 1.4, where the function correctly reports that NODE_COMPILE_CACHE
        // IS honoured. The function was right; the expectation encoded the
        // runtime the suite no longer runs on.
        //
        // The rule itself (false on <=1.3, true on Node, true on >=1.4) is pinned
        // by the sibling tests, so restating it here would just be a second copy
        // to keep in sync.
        expect(runtimeHonoursCompileCache()).toBe(
            runtimeHonoursCompileCache(process.versions),
        );
    });

    /**
     * #807 — Bun 1.4.0 (2026-08-20) implements `NODE_COMPILE_CACHE` for real.
     *
     * MEASURED against a real bun 1.4.0, not inferred from the changelog. Both
     * directions, because only having both makes the diagnostic safe to enable:
     *
     *   healthy writable dir  → returns a PATH   (…/v1.4.0-aarch64-34cbb9a40-501)
     *   refused dir (/dev/null) → returns undefined
     *
     * That is Node's shape exactly. Had only the healthy case been checked, we
     * would have enabled a diagnostic that could not distinguish "refused" from
     * "not implemented" and every 1.4 pod with a bad volume would have gone
     * silent — the #309 false-alarm inverted.
     *
     * The ≤1.3 half must keep returning false: bun 1.3.5 returns undefined for a
     * HEALTHY dir (measured), so a verdict there would warn about a good volume.
     */
    it("is true under Bun ≥1.4, which implements the cache for real", () => {
        expect(runtimeHonoursCompileCache({ bun: "1.4.0" })).toBe(true);
        expect(runtimeHonoursCompileCache({ bun: "1.4.7" })).toBe(true);
        expect(runtimeHonoursCompileCache({ bun: "2.0.0" })).toBe(true);
    });

    it("stays false for every Bun below 1.4", () => {
        for (const v of ["1.0.0", "1.3.5", "1.3.14", "0.8.1"]) {
            expect(
                runtimeHonoursCompileCache({ bun: v }),
                `bun ${v} returns undefined for a healthy dir; a verdict would be a false alarm`,
            ).toBe(false);
        }
    });

    it("compares numerically, not lexically", () => {
        // "1.10.0" < "1.4.0" as strings. A string compare would call the newer
        // runtime old and silently keep the diagnostic off forever.
        expect(runtimeHonoursCompileCache({ bun: "1.10.0" })).toBe(true);
        // And the mirror: "1.4" must not be beaten by a longer ≤1.3 string.
        expect(runtimeHonoursCompileCache({ bun: "1.3.100" })).toBe(false);
    });

    it("treats an unparseable version as ≤1.3 — the silent direction", () => {
        // Never guess upward: a missed diagnostic beats a false alarm, which is
        // the same asymmetry the original Bun check was built on.
        for (const v of ["", "next", "1", "x.y.z"]) {
            expect(runtimeHonoursCompileCache({ bun: v })).toBe(false);
        }
    });

    it("accepts a canary/prerelease 1.4 as 1.4", () => {
        expect(
            runtimeHonoursCompileCache({ bun: "1.4.0-canary.20260820" }),
        ).toBe(true);
    });
});

describe("warnOnDegradedCompileCache", () => {
    function logger() {
        return { warn: mock() };
    }

    it("warns ONCE, naming the path, when the cache was refused", () => {
        const log = logger();
        const status = warnOnDegradedCompileCache({
            // Node-shaped `versions` explicitly: the default is
            // `process.versions`, and under `bun test` that carries a `bun`
            // key — which makes the production code return "unknown" by
            // design. Without this the assertions below test the Bun branch
            // while claiming to test the Node one.
            versions: {},
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
            versions: {},
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
            versions: {},
            env: {},
            getCompileCacheDir: () => undefined,
            log,
        });
        expect(status).toBe("unset");
        expect(log.warn).not.toHaveBeenCalled();
    });

    it("is SILENT on a runtime with no getCompileCacheDir at all", () => {
        // A hypothetical runtime, kept only because the branch exists. The
        // REAL Bun shape is the next test — do not mistake this one for it.
        const log = logger();
        const status = warnOnDegradedCompileCache({
            versions: {},
            env: { NODE_COMPILE_CACHE: PVC },
            getCompileCacheDir: undefined,
            log,
        });
        expect(status).toBe("unknown");
        expect(log.warn).not.toHaveBeenCalled();
    });

    it("is SILENT under REAL Bun semantics: probe present, returns undefined", () => {
        // bun 1.3.5, verified: `typeof module.getCompileCacheDir === "function"`
        // and it returns undefined even for a healthy writable dir. Deciding on
        // the probe's existence alone warns on every Bun pod that its perfectly
        // good cache volume "was refused".
        const log = logger();
        const status = warnOnDegradedCompileCache({
            env: { NODE_COMPILE_CACHE: PVC },
            getCompileCacheDir: () => undefined,
            versions: { bun: "1.3.5" },
            log,
        });
        expect(status).toBe("unknown");
        expect(log.warn).not.toHaveBeenCalled();
    });

    it("is SILENT when NODE_DISABLE_COMPILE_CACHE opted out", () => {
        const log = logger();
        const status = warnOnDegradedCompileCache({
            versions: {},
            env: {
                NODE_COMPILE_CACHE: PVC,
                NODE_DISABLE_COMPILE_CACHE: "1",
            },
            getCompileCacheDir: () => undefined,
            log,
        });
        expect(status).toBe("disabled");
        expect(log.warn).not.toHaveBeenCalled();
    });

    it("treats NODE_DISABLE_COMPILE_CACHE as PRESENCE, not truthiness", () => {
        // Verified on node 24: the cache is disabled for "0" and "" too, so a
        // truthiness check would warn exactly the operators who wrote `=0`.
        for (const value of ["0", "", "false"]) {
            const log = logger();
            const status = warnOnDegradedCompileCache({
                versions: {},
                env: {
                    NODE_COMPILE_CACHE: PVC,
                    NODE_DISABLE_COMPILE_CACHE: value,
                },
                getCompileCacheDir: () => undefined,
                log,
            });
            expect(status, `NODE_DISABLE_COMPILE_CACHE=${value}`).toBe(
                "disabled",
            );
            expect(log.warn).not.toHaveBeenCalled();
        }
    });

    it("never throws when the probe throws", () => {
        const log = logger();
        expect(() =>
            warnOnDegradedCompileCache({
                versions: {},
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
                versions: {},
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
            versions: {},
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
        // A search literal describing the PRODUCTION source, not code that runs
        // here — so it stays `process.execPath`. A blanket rename to NODE_BIN
        // rewrote this string too and the scan stopped matching, which is the
        // same class of mistake as editing prose that merely mentions code.
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

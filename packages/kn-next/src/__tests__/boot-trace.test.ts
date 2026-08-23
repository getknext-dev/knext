/**
 * boot-trace.test.ts — the opt-in supervisor boot phase tracer (#441 / #592).
 *
 * The tracer exists to DECOMPOSE the wrapper's cold-start cost into phases
 * (process start → entry graph evaluated → spawn issued → child listening →
 * supervisor ready). Two properties are load-bearing and are what these tests
 * pin:
 *
 *  1. **Off by default, and free when off.** The measurement must not become the
 *     thing being measured. When `KNEXT_BOOT_TRACE` is unset, `mark()` must not
 *     read the clock and must not write — otherwise every production cold start
 *     pays for instrumentation nobody asked for.
 *  2. **Fail-open.** A tracer that can throw would take the supervisor down over
 *     a diagnostic. A broken writer must be swallowed.
 */

import { describe, expect, it, vi } from "vitest";
import {
    BOOT_TRACE_ENV,
    createBootTracer,
    isBootTraceEnabled,
} from "../adapters/boot-trace";

describe("isBootTraceEnabled", () => {
    it("is off when the env var is absent — production is untouched", () => {
        expect(isBootTraceEnabled({})).toBe(false);
    });

    it.each([
        "1",
        "true",
        "TRUE",
        " yes ",
        "on",
    ])("is on for %j", (raw: string) => {
        expect(isBootTraceEnabled({ [BOOT_TRACE_ENV]: raw })).toBe(true);
    });

    it.each([
        "0",
        "false",
        "",
        "  ",
        "no",
        "off",
    ])("is off for %j", (raw: string) => {
        expect(isBootTraceEnabled({ [BOOT_TRACE_ENV]: raw })).toBe(false);
    });
});

describe("createBootTracer (disabled)", () => {
    it("does not read the clock and does not write", () => {
        const now = vi.fn(() => 0n);
        const write = vi.fn();
        const tracer = createBootTracer({ enabled: false, now, write });

        tracer.mark("entry-eval");
        tracer.mark("spawn-issued");

        expect(write).not.toHaveBeenCalled();
        // Construction may sample the origin once; marking must not sample at all.
        expect(now).not.toHaveBeenCalled();
        expect(tracer.enabled).toBe(false);
    });
});

describe("createBootTracer (enabled)", () => {
    /** hrtime.bigint() stub advancing by whole milliseconds per call. */
    function clock(msSequence: readonly number[]): () => bigint {
        let i = 0;
        return () => BigInt(Math.round(msSequence[i++] * 1e6));
    }

    it("emits one structured line per phase, anchored at process start", () => {
        const lines: string[] = [];
        const tracer = createBootTracer({
            enabled: true,
            // origin sample, then two marks
            now: clock([1000, 1120, 1180]),
            uptimeMs: () => 100, // process started 100ms before the origin sample
            write: (line) => lines.push(line),
        });

        tracer.mark("entry-eval");
        tracer.mark("spawn-issued", { serverJs: "/app/server.js" });

        expect(lines).toHaveLength(2);
        const first = JSON.parse(lines[0]);
        const second = JSON.parse(lines[1]);

        expect(first.knextBootTrace).toBe(true);
        expect(first.phase).toBe("entry-eval");
        // 1120 - (1000 - 100) = 220ms since process start
        expect(first.sinceStartMs).toBeCloseTo(220, 6);
        expect(first.sinceLastMs).toBeCloseTo(220, 6);
        expect(first.prevPhase).toBe("process-start");

        expect(second.phase).toBe("spawn-issued");
        expect(second.sinceStartMs).toBeCloseTo(280, 6);
        expect(second.sinceLastMs).toBeCloseTo(60, 6);
        expect(second.prevPhase).toBe("entry-eval");
        expect(second.serverJs).toBe("/app/server.js");
    });

    it("terminates each line with a newline so lines are parseable", () => {
        const lines: string[] = [];
        createBootTracer({
            enabled: true,
            now: clock([0, 5]),
            uptimeMs: () => 0,
            write: (line) => lines.push(line),
        }).mark("ready");

        expect(lines[0].endsWith("\n")).toBe(true);
    });

    it("is fail-open: a throwing writer never propagates", () => {
        const tracer = createBootTracer({
            enabled: true,
            now: clock([0, 5]),
            uptimeMs: () => 0,
            write: () => {
                throw new Error("stderr is gone");
            },
        });

        expect(() => tracer.mark("entry-eval")).not.toThrow();
    });

    it("exposes elapsedMs since process start for callers that need the raw value", () => {
        const tracer = createBootTracer({
            enabled: true,
            now: clock([1000, 1400]),
            uptimeMs: () => 250,
            write: () => {},
        });

        // 1400 - (1000 - 250) = 650ms
        expect(tracer.elapsedMs()).toBeCloseTo(650, 6);
    });
});

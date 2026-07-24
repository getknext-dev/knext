/**
 * tracing.ts — the exported span helpers, processors and correlation propagator
 * (#317/#346/#401). Tracing is default-off (no-op tracer), so these assert the
 * control-flow contracts that run regardless of a registered SDK:
 *  - withColdStartSpan / withDbWakeSpan return the wrapped result and propagate
 *    sync + async errors,
 *  - ColdStartSpanProcessor emits once (first SERVER span) and calls the metric
 *    emitter; non-SERVER / later spans are no-ops,
 *  - CorrelationContextPropagator.extract seeds the context key that
 *    correlationIdFromContext / activeCorrelationId read (with #401 re-validation),
 *  - activeTraceId is undefined with no recording span.
 */

import { ROOT_CONTEXT, SpanKind } from "@opentelemetry/api";
import { describe, expect, it, vi } from "vitest";
import {
    activeCorrelationId,
    activeTraceId,
    CORRELATION_ATTRIBUTE,
    ColdStartSpanProcessor,
    CorrelationContextPropagator,
    CorrelationSpanProcessor,
    correlationIdFromContext,
    installCorrelationIdProvider,
    installTraceIdProvider,
    withColdStartSpan,
    withCorrelationId,
    withDbWakeSpan,
} from "../adapters/tracing";

const UUID = "550e8400-e29b-41d4-a716-446655440000";

function serverSpan() {
    return {
        kind: SpanKind.SERVER,
        spanContext: () => ({
            traceId: "a".repeat(32),
            spanId: "b".repeat(16),
        }),
        setAttribute: vi.fn(),
    };
}

describe("withColdStartSpan / withDbWakeSpan", () => {
    it("returns a sync result unchanged", () => {
        expect(withColdStartSpan({ cold: true, wakeMs: 12 }, () => 42)).toBe(
            42,
        );
        expect(withDbWakeSpan(() => "ok")).toBe("ok");
    });

    it("returns an async result and propagates rejection", async () => {
        await expect(withDbWakeSpan(async () => "v")).resolves.toBe("v");
        await expect(
            withColdStartSpan({ cold: false }, async () => {
                throw new Error("async boom");
            }),
        ).rejects.toThrow(/async boom/);
    });

    it("propagates a synchronous throw", () => {
        expect(() =>
            withDbWakeSpan(() => {
                throw new Error("sync boom");
            }),
        ).toThrow(/sync boom/);
    });
});

describe("ColdStartSpanProcessor", () => {
    it("emits the cold-start metric exactly once, on the first SERVER span", () => {
        const onColdStart = vi.fn();
        const proc = new ColdStartSpanProcessor(Date.now() - 100, onColdStart);

        proc.onStart(serverSpan(), ROOT_CONTEXT);
        proc.onStart(serverSpan(), ROOT_CONTEXT); // latched → no second emit

        expect(onColdStart).toHaveBeenCalledTimes(1);
        expect(onColdStart).toHaveBeenCalledWith(expect.any(Number));
    });

    it("ignores non-SERVER spans", () => {
        const onColdStart = vi.fn();
        const proc = new ColdStartSpanProcessor(Date.now(), onColdStart);
        proc.onStart({ ...serverSpan(), kind: SpanKind.CLIENT }, ROOT_CONTEXT);
        expect(onColdStart).not.toHaveBeenCalled();
    });

    it("has inert lifecycle hooks", async () => {
        const proc = new ColdStartSpanProcessor();
        proc.onEnd();
        await expect(proc.forceFlush()).resolves.toBeUndefined();
        await expect(proc.shutdown()).resolves.toBeUndefined();
    });
});

describe("correlation context", () => {
    it("round-trips a well-formed id through withCorrelationId / correlationIdFromContext", () => {
        const ctx = withCorrelationId(ROOT_CONTEXT, UUID);
        expect(correlationIdFromContext(ctx)).toBe(UUID);
    });

    it("re-validates on read (#401): an ill-formed seeded value reads as undefined", () => {
        const ctx = withCorrelationId(ROOT_CONTEXT, "not a valid id!!");
        expect(correlationIdFromContext(ctx)).toBeUndefined();
    });

    it("CorrelationContextPropagator.extract seeds the id the readers resolve", () => {
        const prop = new CorrelationContextPropagator();
        const getter = {
            get: () => UUID,
            keys: () => [],
        };
        const ctx = prop.extract(ROOT_CONTEXT, {}, getter);
        expect(correlationIdFromContext(ctx)).toBe(UUID);
        // inject is a deliberate no-op; fields advertises the header.
        const setter = { set: vi.fn() };
        prop.inject(ctx, {}, setter);
        expect(setter.set).not.toHaveBeenCalled();
        expect(prop.fields().length).toBeGreaterThan(0);
    });

    it("activeCorrelationId is undefined outside a seeded request", () => {
        expect(activeCorrelationId()).toBeUndefined();
    });

    it("exposes provider factories for the lib correlation/trace wiring", () => {
        expect(typeof installCorrelationIdProvider()).toBe("function");
        expect(typeof installTraceIdProvider()).toBe("function");
    });
});

describe("CorrelationSpanProcessor", () => {
    it("stamps the correlation attribute on a SERVER span when the context carries an id", () => {
        const proc = new CorrelationSpanProcessor();
        const span = serverSpan();
        proc.onStart(span, withCorrelationId(ROOT_CONTEXT, UUID));
        expect(span.setAttribute).toHaveBeenCalledWith(
            CORRELATION_ATTRIBUTE,
            UUID,
        );
    });

    it("is a no-op for a non-SERVER span or a context with no id", () => {
        const proc = new CorrelationSpanProcessor();
        const client = { ...serverSpan(), kind: SpanKind.CLIENT };
        proc.onStart(client, withCorrelationId(ROOT_CONTEXT, UUID));
        expect(client.setAttribute).not.toHaveBeenCalled();

        const server = serverSpan();
        proc.onStart(server, ROOT_CONTEXT); // no id seeded
        expect(server.setAttribute).not.toHaveBeenCalled();
    });

    it("has inert lifecycle hooks", async () => {
        const proc = new CorrelationSpanProcessor();
        proc.onEnd();
        await expect(proc.forceFlush()).resolves.toBeUndefined();
        await expect(proc.shutdown()).resolves.toBeUndefined();
    });
});

describe("activeTraceId", () => {
    it("is undefined when no recording span is active", () => {
        expect(activeTraceId()).toBeUndefined();
    });
});

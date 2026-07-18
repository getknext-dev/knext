import { ServerResponse } from "node:http";
import { CORRELATION_HEADER } from "@knext/lib/context";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    CORRELATION_RESPONSE_INSTALLED,
    installCorrelationResponseEcho,
} from "../adapters/correlation-response";
import {
    CorrelationContextPropagator,
    withCorrelationId,
} from "../adapters/tracing";

/**
 * #350 Part 1 — automatic response-echo of `x-request-id`.
 *
 * #346 delivers inbound correlation + log correlation via the OTel Context but
 * does NOT echo `x-request-id` on the HTTP response on the automatic path. This
 * adapter patches `http.ServerResponse.prototype` (the same mechanism as
 * `cache-control-normalize.cjs`) so that — WHEN TRACING IS ON — the response
 * carries `x-request-id` = the ACTIVE correlation id (read from the OTel Context
 * the #346 propagator seeds, the same source the logger mixin uses), IF present
 * and not already set by the app.
 *
 * Requirements proven here: default-OFF (only when tracing enabled), fail-open
 * (never break the response), idempotent, never overrides an app-set value.
 */

const contextManager = new AsyncLocalStorageContextManager();
let provider: BasicTracerProvider | undefined;

function bootTracing(): void {
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
    provider = new BasicTracerProvider();
    trace.setGlobalTracerProvider(provider);
}

/**
 * The patch wraps `ServerResponse.prototype`. To capture the header writes
 * WITHOUT a live socket, we install a shared header store on the prototype's
 * BASE methods (writeHead/setHeader/getHeader) before the patch runs, so the
 * patch closes over these captures as its "originals" and header reads/writes
 * flow through the store. Snapshotted here so afterEach fully restores.
 */
const pristineWriteHead = ServerResponse.prototype.writeHead;
const pristineSetHeader = ServerResponse.prototype.setHeader;
const pristineGetHeader = ServerResponse.prototype.getHeader;

/** The header store for the response currently under test. */
let currentHeaders: Record<string, unknown> = {};

function installBaseCaptures(): void {
    ServerResponse.prototype.setHeader = function baseSetHeader(
        this: ServerResponse,
        name: string,
        value: unknown,
    ) {
        currentHeaders[String(name).toLowerCase()] = value;
        return this;
    } as ServerResponse["setHeader"];
    ServerResponse.prototype.getHeader = function baseGetHeader(
        this: ServerResponse,
        name: string,
    ) {
        return currentHeaders[String(name).toLowerCase()] as
            | number
            | string
            | string[]
            | undefined;
    } as ServerResponse["getHeader"];
    ServerResponse.prototype.writeHead = function baseWriteHead(
        this: ServerResponse,
        _status: number,
        ...rest: unknown[]
    ) {
        // Apply any inline headers object to the store (mirrors node's base).
        for (const arg of rest) {
            if (
                arg !== null &&
                typeof arg === "object" &&
                !Array.isArray(arg)
            ) {
                for (const [k, v] of Object.entries(
                    arg as Record<string, unknown>,
                )) {
                    currentHeaders[k.toLowerCase()] = v;
                }
            }
        }
        return this;
    } as ServerResponse["writeHead"];
}

afterEach(async () => {
    if (provider) {
        await provider.shutdown();
    }
    provider = undefined;
    trace.disable();
    context.disable();
    contextManager.disable();
    ServerResponse.prototype.writeHead = pristineWriteHead;
    ServerResponse.prototype.setHeader = pristineSetHeader;
    ServerResponse.prototype.getHeader = pristineGetHeader;
    // biome-ignore lint/suspicious/noExplicitAny: clearing the install latch for isolation.
    delete (ServerResponse.prototype as any)[CORRELATION_RESPONSE_INSTALLED];
    vi.restoreAllMocks();
});

/**
 * A minimal ServerResponse double over the real prototype (so the patched
 * writeHead / setHeader run), backed by the shared header store. Call
 * `installBaseCaptures()` (once, before installing the patch) so the store is
 * live.
 */
function makeRes(): {
    res: ServerResponse;
    headers: Record<string, unknown>;
} {
    currentHeaders = {};
    const res = Object.create(ServerResponse.prototype) as ServerResponse;
    return { res, headers: currentHeaders };
}

function runInRequest<T>(id: string | undefined, fn: () => T): T {
    const ctx = id ? withCorrelationId(context.active(), id) : context.active();
    return context.with(ctx, fn);
}

describe("#350 Part 1: automatic response-echo of x-request-id", () => {
    beforeEach(() => {
        installBaseCaptures();
        bootTracing();
    });

    it("stamps x-request-id = active correlation id on writeHead when tracing is on", () => {
        installCorrelationResponseEcho();
        const { res, headers } = makeRes();
        runInRequest("req-echo-1", () => {
            res.writeHead(200);
        });
        expect(headers[CORRELATION_HEADER]).toBe("req-echo-1");
    });

    it("also stamps via setHeader path (header flush before writeHead)", () => {
        installCorrelationResponseEcho();
        const { res, headers } = makeRes();
        runInRequest("req-echo-2", () => {
            res.setHeader("content-type", "text/plain");
        });
        expect(headers[CORRELATION_HEADER]).toBe("req-echo-2");
    });

    it("does NOT override an app-preset x-request-id", () => {
        installCorrelationResponseEcho();
        const { res, headers } = makeRes();
        runInRequest("req-echo-3", () => {
            res.setHeader(CORRELATION_HEADER, "app-owned-id");
            res.writeHead(200);
        });
        expect(headers[CORRELATION_HEADER]).toBe("app-owned-id");
    });

    it("does NOT set the header when there is no active correlation id", () => {
        installCorrelationResponseEcho();
        const { res, headers } = makeRes();
        // No runInRequest wrapper → no correlation id on the context.
        res.writeHead(200);
        expect(headers[CORRELATION_HEADER]).toBeUndefined();
    });

    it("fail-open: a throwing correlation resolver never breaks writeHead", () => {
        installCorrelationResponseEcho({
            activeCorrelationId: () => {
                throw new Error("boom");
            },
        });
        const { res, headers } = makeRes();
        // Must NOT throw, and must still complete writeHead.
        expect(() => res.writeHead(204)).not.toThrow();
        expect(headers[CORRELATION_HEADER]).toBeUndefined();
    });

    it("is idempotent: installing twice does not double-wrap", () => {
        installCorrelationResponseEcho();
        const afterFirst = ServerResponse.prototype.writeHead;
        installCorrelationResponseEcho();
        expect(ServerResponse.prototype.writeHead).toBe(afterFirst);
    });

    it("preserves the writeHead return value (the ServerResponse) for chaining", () => {
        installCorrelationResponseEcho();
        const { res } = makeRes();
        const ret = runInRequest("req-chain", () => res.writeHead(200));
        expect(ret).toBe(res);
    });

    it("passes headers object supplied to writeHead(status, headers) through untouched (plus echo)", () => {
        installCorrelationResponseEcho();
        const { res, headers } = makeRes();
        runInRequest("req-hobj", () => {
            res.writeHead(200, { "x-custom": "v" });
        });
        // The custom header the app passed inline is still applied, and the
        // active correlation id is echoed alongside it.
        expect(headers["x-custom"]).toBe("v");
        expect(headers[CORRELATION_HEADER]).toBe("req-hobj");
    });

    it("does not echo when an app x-request-id is supplied inline in writeHead headers", () => {
        installCorrelationResponseEcho();
        const { res, headers } = makeRes();
        runInRequest("req-inline", () => {
            res.writeHead(200, { [CORRELATION_HEADER]: "inline-app-id" });
        });
        expect(headers[CORRELATION_HEADER]).toBe("inline-app-id");
    });
});

describe("#350 Part 1: default-off when tracing is disabled", () => {
    it("does not stamp x-request-id when no tracer provider is registered", () => {
        // No bootTracing(): the active correlation id resolves to undefined
        // (the #346 propagator was never registered), so nothing is echoed.
        trace.disable();
        installBaseCaptures();
        installCorrelationResponseEcho();
        const { res, headers } = makeRes();
        res.writeHead(200);
        expect(headers[CORRELATION_HEADER]).toBeUndefined();
    });
});

describe("#350 Part 1: uses the same context source as #346", () => {
    beforeEach(() => {
        installBaseCaptures();
        bootTracing();
    });

    it("echoes the id the CorrelationContextPropagator seeded from an inbound header", () => {
        installCorrelationResponseEcho();
        const propagator = new CorrelationContextPropagator();
        const getter = {
            keys: (c: Record<string, string>) => Object.keys(c),
            get: (c: Record<string, string>, k: string) => c[k],
        };
        const extracted = propagator.extract(
            context.active(),
            { [CORRELATION_HEADER]: "inbound-prop-id" },
            getter,
        );
        const { res, headers } = makeRes();
        context.with(extracted, () => {
            res.writeHead(200);
        });
        expect(headers[CORRELATION_HEADER]).toBe("inbound-prop-id");
    });
});

describe("#368: echo re-validates the correlation id before stamping", () => {
    beforeEach(() => {
        installBaseCaptures();
        bootTracing();
    });

    it("does NOT stamp an id with header-smuggling chars seeded via the withCorrelationId seam", () => {
        installCorrelationResponseEcho();
        const { res, headers } = makeRes();
        // Simulate a future refactor seeding CORRELATION_CTX_KEY from an
        // UNVALIDATED source: `withCorrelationId` writes the key verbatim.
        const smuggled = "evil\r\nx-injected: 1";
        runInRequest(smuggled, () => {
            res.writeHead(200);
        });
        expect(headers[CORRELATION_HEADER]).toBeUndefined();
    });

    it("does NOT stamp an over-long id (> MAX_ID_LENGTH) from an unvalidated context write", () => {
        installCorrelationResponseEcho();
        const { res, headers } = makeRes();
        const tooLong = "a".repeat(129);
        runInRequest(tooLong, () => {
            res.writeHead(200);
        });
        expect(headers[CORRELATION_HEADER]).toBeUndefined();
    });

    it("does NOT stamp an invalid id returned by an unvalidated provider (dep seam)", () => {
        installCorrelationResponseEcho({
            activeCorrelationId: () => "bad value with spaces\r\n",
        });
        const { res, headers } = makeRes();
        res.writeHead(200);
        expect(headers[CORRELATION_HEADER]).toBeUndefined();
    });

    it("still stamps a well-formed id after re-validation (validated path unchanged)", () => {
        installCorrelationResponseEcho();
        const { res, headers } = makeRes();
        runInRequest("valid-id_1.2-3", () => {
            res.writeHead(200);
        });
        expect(headers[CORRELATION_HEADER]).toBe("valid-id_1.2-3");
    });

    it("still echoes the propagator-validated id (primary path stays zero-touch)", () => {
        installCorrelationResponseEcho();
        const propagator = new CorrelationContextPropagator();
        const getter = {
            keys: (c: Record<string, string>) => Object.keys(c),
            get: (c: Record<string, string>, k: string) => c[k],
        };
        // A hostile inbound header is replaced by a minted uuid at extract time;
        // the echo must stamp THAT (validated) value, not the hostile raw one.
        const extracted = propagator.extract(
            context.active(),
            { [CORRELATION_HEADER]: "hostile\r\nx-evil: 1" },
            getter,
        );
        const { res, headers } = makeRes();
        context.with(extracted, () => {
            res.writeHead(200);
        });
        const stamped = headers[CORRELATION_HEADER];
        expect(typeof stamped).toBe("string");
        expect(stamped).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
        expect(stamped).not.toContain("hostile");
    });
});

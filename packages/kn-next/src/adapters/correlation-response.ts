/**
 * correlation-response.ts — automatic response-echo of `x-request-id` on the
 * REAL request path (#350, follow-up to #346).
 *
 * #346 established the request correlation id on the OTel Context (the
 * `CorrelationContextPropagator`) and correlated LOGS from it, but did NOT echo
 * `x-request-id` back on the HTTP RESPONSE automatically: @vercel/otel exposes no
 * inbound response hook and knext-core does not own the app's route-handler /
 * response chain (the #317/#342 constraint). `applyCorrelationHeader` echoes only
 * on paths the app owns.
 *
 * This module closes that gap with the SAME mechanism knext-core already uses to
 * touch the standalone server's responses without wrapping app handlers: it
 * monkey-patches `http.ServerResponse.prototype` (cf.
 * `cache-control-normalize.cjs`, which patches `setHeader`/`writeHead`). At the
 * header-flush point (`writeHead`, and the earlier `setHeader`) it reads the
 * ACTIVE correlation id from the OTel Context — the exact source the logger mixin
 * uses (`activeCorrelationId()` from `tracing.ts`) — and stamps it as
 * `x-request-id`, so a client gets the id back on the response with no app code.
 *
 * WHY reading the Context at writeHead works: @vercel/otel installs an
 * `AsyncLocalStorageContextManager`, and `@opentelemetry/instrumentation-http`
 * starts the inbound SERVER span UNDER the extracted context and runs the whole
 * request (including Next's response pipeline that calls `res.writeHead()` /
 * `res.setHeader()`) inside that ALS scope. So `context.active()` at the flush
 * point still carries the correlation key the propagator seeded. (This is the
 * same reason `cache-control-normalize.cjs` can read `res.req` at writeHead — the
 * response is manipulated synchronously within the request's execution scope.)
 *
 * Posture (mirrors #346/#348):
 *   - DEFAULT-OFF: installed ONLY from `instrumentation-node.ts` when tracing is
 *     enabled. With tracing off no provider is registered, `activeCorrelationId()`
 *     returns undefined, and even if the patch were installed it would be inert.
 *   - FAIL-OPEN: any throw while resolving/stamping the id is swallowed and the
 *     original `writeHead`/`setHeader` behavior is preserved — never break a
 *     response over an observability header.
 *   - IDEMPOTENT: a `Symbol.for` latch on the prototype guards double-wrapping.
 *   - NEVER OVERRIDES: an app-set `x-request-id` (via `setHeader` or inline in
 *     `writeHead(status, headers)`) always wins — we only fill it when absent.
 *   - EDGE-SAFE (#342/#344): this is a Node-only concern (it touches `node:http`)
 *     and is loaded exclusively from `instrumentation-node.ts`, which the
 *     `NEXT_RUNTIME === 'nodejs'` guard + the edge `IgnorePlugin` keep out of the
 *     edge bundle. It never statically imports a Node-only client module.
 */

import { ServerResponse } from "node:http";
import { CORRELATION_HEADER } from "@knext/lib/context";

import { activeCorrelationId as defaultActiveCorrelationId } from "./tracing";

/**
 * Idempotency latch on `ServerResponse.prototype`. Exported so tests can assert /
 * reset install state without reaching into module internals.
 */
export const CORRELATION_RESPONSE_INSTALLED = Symbol.for(
    "knext.correlationResponseEcho.installed",
);

/** Injectable dependencies (tests supply a throwing resolver to prove fail-open). */
export interface CorrelationResponseDeps {
    /** Resolves the active request correlation id, or undefined outside a request. */
    activeCorrelationId?: () => string | undefined;
}

/**
 * Read a header off a plain headers object case-insensitively (writeHead may be
 * given `{ 'X-Request-Id': ... }` before it is queryable via `res.getHeader`).
 */
function objectHasHeader(
    headers: Record<string, unknown>,
    name: string,
): boolean {
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === name) {
            return true;
        }
    }
    return false;
}

/**
 * Patch `http.ServerResponse.prototype` so that — when a correlation id is active
 * on the OTel Context and the app has not already set `x-request-id` — the
 * response carries `x-request-id` = that id. Idempotent + fail-open. Installed
 * once, from `instrumentation-node.ts`, only when tracing is enabled.
 */
export function installCorrelationResponseEcho(
    deps: CorrelationResponseDeps = {},
): void {
    const resolve = deps.activeCorrelationId ?? defaultActiveCorrelationId;
    const proto = ServerResponse.prototype as ServerResponse & {
        [CORRELATION_RESPONSE_INSTALLED]?: boolean;
    };
    if (proto[CORRELATION_RESPONSE_INSTALLED]) {
        return;
    }
    proto[CORRELATION_RESPONSE_INSTALLED] = true;

    /**
     * Stamp the active correlation id onto `res` unless it's already set. Fully
     * guarded: a throw here (resolver, getHeader, setHeader) must never escape.
     */
    function stamp(res: ServerResponse): void {
        try {
            // Never override an app-set value (setHeader or already-flushed).
            if (
                typeof res.getHeader === "function" &&
                res.getHeader(CORRELATION_HEADER) !== undefined
            ) {
                return;
            }
            const id = resolve();
            if (!id) {
                return;
            }
            res.setHeader(CORRELATION_HEADER, id);
        } catch {
            // Fail-open: an observability header must never break the response.
        }
    }

    const originalWriteHead = proto.writeHead;
    proto.writeHead = function writeHead(
        this: ServerResponse,
        ...args: unknown[]
    ) {
        // Detect an inline `x-request-id` in a writeHead(status[, msg], headers)
        // headers object so we never override an app value provided that way.
        let inlineHasId = false;
        for (const arg of args) {
            if (
                arg !== null &&
                typeof arg === "object" &&
                !Array.isArray(arg)
            ) {
                if (
                    objectHasHeader(
                        arg as Record<string, unknown>,
                        CORRELATION_HEADER,
                    )
                ) {
                    inlineHasId = true;
                }
            }
        }
        if (!inlineHasId) {
            stamp(this);
        }
        // Preserve the original signature/return exactly.
        return (
            originalWriteHead as (
                this: ServerResponse,
                ...a: unknown[]
            ) => ServerResponse
        ).apply(this, args);
    } as ServerResponse["writeHead"];

    const originalSetHeader = proto.setHeader;
    proto.setHeader = function setHeader(
        this: ServerResponse,
        name: string,
        value: number | string | readonly string[],
    ) {
        // If the app itself is setting x-request-id, do not interfere.
        if (
            typeof name === "string" &&
            name.toLowerCase() !== CORRELATION_HEADER
        ) {
            stamp(this);
        }
        return originalSetHeader.call(this, name, value);
    } as ServerResponse["setHeader"];
}

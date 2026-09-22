/**
 * db-clients-probe — the standalone image surfaces its own degradation LOUDLY
 * (ADR-0055 Amendment / #1178).
 *
 * The standalone runtime image (templates/runtime-standalone) deliberately omits
 * `@getknext/lib/clients`' native closure (@cerbos/grpc + minio + pg — the
 * heaviest graph, biggest CVE surface). When it is absent BOTH supervisor call
 * sites fail open: `drainDbPools` catches the load failure and returns, and
 * `startImageCacheSync` never imports the store client. That is safe (no
 * crash-loop) but SILENT — and the silence hides a real functional loss:
 * un-drained DB sockets can hold a scale-to-zero compute awake (#245).
 *
 * This probe converts that silent no-op into a LOUD, ONE-SHOT startup WARNING,
 * WITHOUT evaluating the heavy graph — it only RESOLVES the specifier
 * (import.meta.resolve), never imports it, so it keeps the #441 cold-start
 * guarantee (the drain loads the heavy graph lazily at shutdown, not at boot).
 */

import { describe, expect, it, mock } from "bun:test";
import { warnIfDbClientsUnavailable } from "../adapters/db-clients-probe";

function fakeLog() {
    return {
        warn: mock((_obj?: unknown, _msg?: string) => {}),
        info: mock((_obj?: unknown, _msg?: string) => {}),
    };
}

describe("warnIfDbClientsUnavailable", () => {
    it("returns false and emits ONE loud WARNING when @getknext/lib/clients cannot be resolved (the standalone-image case)", () => {
        const log = fakeLog();
        const present = warnIfDbClientsUnavailable({
            log,
            resolve: () => {
                throw new Error("Cannot find package '@getknext/lib/clients'");
            },
        });
        expect(present).toBe(false);
        // Loud: exactly one warn, at warn level (not info/debug).
        expect(log.warn).toHaveBeenCalledTimes(1);
        expect(log.info).not.toHaveBeenCalled();
    });

    it("the warning NAMES the disabled capabilities and the scale-to-zero consequence", () => {
        const log = fakeLog();
        warnIfDbClientsUnavailable({
            log,
            resolve: () => {
                throw new Error("absent");
            },
        });
        // The message string is the second arg of a pino-style warn(obj, msg).
        const call = log.warn.mock.calls[0] as unknown[];
        const msg = String(call[1] ?? call[0]);
        expect(msg).toMatch(/drain/i);
        expect(msg).toMatch(/image.?cache/i);
        // The load-bearing #245 consequence, in words (no issue numbers in logs).
        expect(msg).toMatch(/scale-to-zero/i);
        expect(msg).toMatch(/awake|socket/i);
    });

    it("returns true and stays SILENT (no warn) when @getknext/lib/clients resolves", () => {
        const log = fakeLog();
        const present = warnIfDbClientsUnavailable({
            log,
            resolve: (spec) => `file:///app/node_modules/${spec}/index.js`,
        });
        expect(present).toBe(true);
        expect(log.warn).not.toHaveBeenCalled();
    });

    it("probes by RESOLVING the exact specifier the drain imports, and never IMPORTS it (keeps the heavy graph off the boot path, #441)", () => {
        const seen: string[] = [];
        warnIfDbClientsUnavailable({
            log: fakeLog(),
            resolve: (spec) => {
                seen.push(spec);
                return "file:///x";
            },
        });
        // Exactly the specifier db-drain.ts / image-cache-sync.ts import.
        expect(seen).toEqual(["@getknext/lib/clients"]);
    });

    it("never throws when the resolver fails — the probe must not wedge boot (it catches and returns false)", () => {
        let returned: boolean | undefined;
        expect(() => {
            returned = warnIfDbClientsUnavailable({
                log: fakeLog(),
                resolve: () => {
                    throw new Error("resolution blew up");
                },
            });
        }).not.toThrow();
        expect(returned).toBe(false);
    });
});

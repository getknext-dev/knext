/**
 * deferred-default-metrics — the real TCP readiness probe + the env knob readers
 * (#441). probeTcp is the default liveness probe waitForChildServing polls with;
 * probeIntervalMs / readyDeadlineMs parse the two cadence knobs with safe
 * fallbacks. Uses a real ephemeral loopback server so the probe is genuine.
 */

import { afterEach, describe, expect, it } from "bun:test";
import net from "node:net";
import {
    CHILD_READY_DEADLINE_ENV,
    CHILD_READY_INTERVAL_ENV,
    DEFAULT_PROBE_INTERVAL_MS,
    DEFAULT_READY_DEADLINE_MS,
    probeIntervalMs,
    probeTcp,
    readyDeadlineMs,
} from "../adapters/deferred-default-metrics";

let servers: net.Server[] = [];

function listenEphemeral(): Promise<number> {
    return new Promise((resolve) => {
        const srv = net.createServer();
        servers.push(srv);
        srv.listen(0, "127.0.0.1", () => {
            resolve((srv.address() as net.AddressInfo).port);
        });
    });
}

afterEach(async () => {
    await Promise.all(
        servers.map((s) => new Promise<void>((r) => s.close(() => r()))),
    );
    servers = [];
});

describe("probeTcp", () => {
    it("resolves true when the port accepts a connection", async () => {
        const port = await listenEphemeral();
        expect(await probeTcp(port, "127.0.0.1", 1000)).toBe(true);
    });

    it("resolves false (never throws) when nothing is listening", async () => {
        // Bind + immediately close to get a port that is now refused.
        const port = await listenEphemeral();
        await new Promise<void>((r) => servers.pop()?.close(() => r()));
        expect(await probeTcp(port, "127.0.0.1", 500)).toBe(false);
    });
});

describe("probeIntervalMs", () => {
    it("reads a valid non-negative override", () => {
        expect(probeIntervalMs({ [CHILD_READY_INTERVAL_ENV]: "50" })).toBe(50);
    });

    it("falls back to the default for missing/negative/NaN values", () => {
        expect(probeIntervalMs({})).toBe(DEFAULT_PROBE_INTERVAL_MS);
        expect(probeIntervalMs({ [CHILD_READY_INTERVAL_ENV]: "-5" })).toBe(
            DEFAULT_PROBE_INTERVAL_MS,
        );
        expect(probeIntervalMs({ [CHILD_READY_INTERVAL_ENV]: "abc" })).toBe(
            DEFAULT_PROBE_INTERVAL_MS,
        );
    });
});

describe("readyDeadlineMs", () => {
    it("reads a valid positive override", () => {
        expect(readyDeadlineMs({ [CHILD_READY_DEADLINE_ENV]: "1234" })).toBe(
            1234,
        );
    });

    it("falls back to the default for missing/zero/NaN values", () => {
        expect(readyDeadlineMs({})).toBe(DEFAULT_READY_DEADLINE_MS);
        // 0 is rejected (a zero deadline would give up immediately).
        expect(readyDeadlineMs({ [CHILD_READY_DEADLINE_ENV]: "0" })).toBe(
            DEFAULT_READY_DEADLINE_MS,
        );
        expect(readyDeadlineMs({ [CHILD_READY_DEADLINE_ENV]: "x" })).toBe(
            DEFAULT_READY_DEADLINE_MS,
        );
    });
});

/**
 * deep-health-lite.test.ts — the deep-health gauge on a tracing-OFF install.
 *
 * THE DEFECT. `knext_deep_health_state` was registered only by
 * `instrumentation-node`, which `instrumentation.ts` does not even load while
 * tracing is off (loading it costs ~0.9 s of every cold start). On the default
 * install there was therefore no series and the deep-health alerts could not
 * fire. The lite module is the cold-start-neutral registration: dependency-free,
 * it reads the activity slot the lib already writes, imports the health check
 * only on the first scrape that needs it, and serves the gauge on the loopback
 * port the runtime contract already bridges onto :9464.
 *
 * The cases below follow the design's test plan: gate closed -> nothing and NO
 * import; gate open -> 12 series, one active state per dependency, byte-identical
 * to the prom-client path; single-flight + TTL; a throwing probe or an unreadable
 * gate never produces a 5xx or a stale claim; the server swallows EADDRINUSE.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import type { AddressInfo } from "node:net";
import { Registry } from "prom-client";

import {
    createDeepHealthLite,
    DEEP_HEALTH_LITE_TTL_MS,
    resolveLitePort,
    startDeepHealthLite,
} from "../adapters/deep-health-lite";
import {
    createMetricsRegistry,
    DEEP_HEALTH_PROBE_TTL_MS,
    refreshDeepHealthGauge,
} from "../adapters/metrics";

type Snapshot = {
    status: "ok" | "degraded" | "down" | "waking";
    checks: {
        postgres: "up" | "down" | "unconfigured" | "waking";
        redis: "up" | "down" | "unconfigured";
    };
};

const DOWN: Snapshot = {
    status: "down",
    checks: { postgres: "down", redis: "unconfigured" },
};

const NOW = 1_000_000;

/** A lite instance whose gate, clock and health module are all injected. */
function harness(
    over: {
        activityAt?: () => number | undefined;
        snapshot?: Snapshot | (() => Promise<Snapshot>);
        loadHealth?: () => Promise<{
            checkDeepHealth: () => Promise<Snapshot>;
        }>;
        env?: Record<string, string | undefined>;
    } = {},
) {
    let now = NOW;
    const checkDeepHealth = mock(async () => {
        const s = over.snapshot ?? DOWN;
        return typeof s === "function" ? s() : s;
    });
    const loadHealth = mock(
        over.loadHealth ?? (async () => ({ checkDeepHealth })),
    );
    const lite = createDeepHealthLite({
        app: "test-app",
        now: () => now,
        readActivityAt: over.activityAt ?? (() => now - 1000),
        loadHealth,
        env: over.env ?? {},
    });
    return {
        lite,
        checkDeepHealth,
        loadHealth,
        advance: (ms: number) => {
            now += ms;
        },
        clock: () => now,
    };
}

/** The deep-health family out of a full prom-client exposition. */
const familyOf = (body: string) =>
    `${body
        .split("\n")
        .filter((l) => l.includes("knext_deep_health_state"))
        .join("\n")}\n`;

const sampleLines = (body: string) =>
    body.split("\n").filter((l) => l.startsWith("knext_deep_health_state{"));

describe("gate closed: no claim, and no import", () => {
    it("never-used pool (no activity slot) => empty body, health module never loaded", async () => {
        const h = harness({ activityAt: () => undefined });
        expect(await h.lite.scrape()).toBe("");
        expect(h.loadHealth).not.toHaveBeenCalled();
        expect(h.checkDeepHealth).not.toHaveBeenCalled();
    });

    it("activity older than the 45 s budget => empty body, nothing loaded or probed", async () => {
        const h = harness({ activityAt: () => NOW - 45_001 });
        expect(await h.lite.scrape()).toBe("");
        expect(h.loadHealth).not.toHaveBeenCalled();
        expect(h.checkDeepHealth).not.toHaveBeenCalled();
    });

    it("activity exactly at the budget is still open (parity with isDbRecentlyActive: <=)", async () => {
        const h = harness({ activityAt: () => NOW - 45_000 });
        expect(sampleLines(await h.lite.scrape())).toHaveLength(12);
    });

    it("DB_ACTIVITY_BUDGET_MS overrides the budget; a non-positive/garbage value falls back to 45 s", async () => {
        const tight = harness({
            activityAt: () => NOW - 5_000,
            env: { DB_ACTIVITY_BUDGET_MS: "1000" },
        });
        expect(await tight.lite.scrape()).toBe("");

        for (const bad of ["0", "-5", "abc", ""]) {
            const h = harness({
                activityAt: () => NOW - 10_000,
                env: { DB_ACTIVITY_BUDGET_MS: bad },
            });
            expect(
                sampleLines(await h.lite.scrape()),
                `DB_ACTIVITY_BUDGET_MS=${JSON.stringify(bad)}`,
            ).toHaveLength(12);
        }
    });

    it("FAIL-CLOSED: an activity read that throws is a closed gate (no probe, no import, empty body)", async () => {
        const h = harness({
            activityAt: () => {
                throw new Error("slot getter exploded");
            },
        });
        expect(await h.lite.scrape()).toBe("");
        expect(h.loadHealth).not.toHaveBeenCalled();
        expect(h.checkDeepHealth).not.toHaveBeenCalled();
    });

    it("FAIL-CLOSED: a non-numeric activity slot is a closed gate", async () => {
        const h = harness({
            activityAt: (() => "yesterday") as unknown as () => number,
        });
        expect(await h.lite.scrape()).toBe("");
        expect(h.checkDeepHealth).not.toHaveBeenCalled();
    });
});

describe("gate open: the gauge", () => {
    it("renders 3 dependencies x 4 states = 12 series, exactly one active state per dependency", async () => {
        const h = harness();
        const lines = sampleLines(await h.lite.scrape());
        expect(lines).toHaveLength(12);
        for (const dep of ["overall", "postgres", "redis"]) {
            const own = lines.filter((l) => l.includes(`dependency="${dep}"`));
            expect(own).toHaveLength(4);
            expect(own.filter((l) => l.endsWith(" 1"))).toHaveLength(1);
            expect(own.filter((l) => l.endsWith(" 0"))).toHaveLength(3);
        }
        expect(lines).toContain(
            'knext_deep_health_state{app="test-app",dependency="overall",state="down"} 1',
        );
        expect(lines).toContain(
            'knext_deep_health_state{app="test-app",dependency="postgres",state="down"} 1',
        );
    });

    it("loads the health module lazily, exactly once across many probes", async () => {
        const h = harness();
        expect(h.loadHealth).not.toHaveBeenCalled(); // creating lite costs nothing
        await h.lite.scrape();
        h.advance(DEEP_HEALTH_LITE_TTL_MS + 1);
        await h.lite.scrape();
        h.advance(DEEP_HEALTH_LITE_TTL_MS + 1);
        await h.lite.scrape();
        expect(h.loadHealth).toHaveBeenCalledTimes(1);
        expect(h.checkDeepHealth).toHaveBeenCalledTimes(3);
    });

    it("is BYTE-IDENTICAL to the prom-client path for every status and postgres state", async () => {
        const statuses = ["ok", "degraded", "down", "waking"] as const;
        const depStates = ["up", "down", "unconfigured", "waking"] as const;
        for (const status of statuses) {
            for (const postgres of depStates) {
                for (const redis of ["up", "down", "unconfigured"] as const) {
                    const snap: Snapshot = {
                        status,
                        checks: { postgres, redis },
                    };
                    const metrics = createMetricsRegistry(
                        new Registry(),
                        "test-app",
                    );
                    refreshDeepHealthGauge(metrics, snap);
                    const expected = familyOf(await metrics.registry.metrics());
                    const h = harness({ snapshot: snap });
                    expect(await h.lite.scrape()).toBe(expected);
                }
            }
        }
    });

    it("escapes the app label exactly as prom-client does", async () => {
        const app = 'we"ird\\app\nname';
        const metrics = createMetricsRegistry(new Registry(), app);
        refreshDeepHealthGauge(metrics, DOWN);
        const lite = createDeepHealthLite({
            app,
            now: () => NOW,
            readActivityAt: () => NOW,
            loadHealth: async () => ({ checkDeepHealth: async () => DOWN }),
            env: {},
        });
        expect(await lite.scrape()).toBe(
            familyOf(await metrics.registry.metrics()),
        );
    });

    it("the lite TTL is the same constant as the prom-client path", () => {
        expect(DEEP_HEALTH_LITE_TTL_MS).toBe(DEEP_HEALTH_PROBE_TTL_MS);
    });
});

describe("#2209: the series is DROPPED while idle, not left at its last value", () => {
    it("active => series; the gate closes => the next scrape carries no series at all", async () => {
        let activity: number | undefined = NOW - 1000;
        const h = harness({ activityAt: () => activity });
        expect(sampleLines(await h.lite.scrape())).toHaveLength(12);

        // The app goes idle. Even INSIDE the probe TTL the claim must not outlive
        // the gate: a stale `waking`/`down` is exactly what the alert keys on.
        activity = NOW - 60_000;
        h.advance(1_000);
        expect(await h.lite.scrape()).toBe("");
    });

    it("active again after idle => probes afresh (the dropped cache is not served)", async () => {
        let activity: number | undefined = NOW - 1000;
        const h = harness({ activityAt: () => activity });
        await h.lite.scrape();
        expect(h.checkDeepHealth).toHaveBeenCalledTimes(1);

        activity = NOW - 60_000;
        h.advance(1_000);
        await h.lite.scrape(); // idle: dropped

        activity = h.clock() - 100; // traffic resumes
        h.advance(1_000); // still inside the 10 s TTL of the first probe
        expect(sampleLines(await h.lite.scrape())).toHaveLength(12);
        expect(h.checkDeepHealth).toHaveBeenCalledTimes(2);
    });
});

describe("single-flight and TTL (amplification bound)", () => {
    it("N concurrent scrapes share ONE probe and all carry its result", async () => {
        let release!: (s: Snapshot) => void;
        const pending = new Promise<Snapshot>((r) => {
            release = r;
        });
        const h = harness({ snapshot: () => pending });
        const callers = Array.from({ length: 25 }, () => h.lite.scrape());
        await new Promise((r) => setTimeout(r, 0));
        expect(h.checkDeepHealth).toHaveBeenCalledTimes(1);
        release(DOWN);
        const bodies = await Promise.all(callers);
        for (const b of bodies) expect(sampleLines(b)).toHaveLength(12);
        expect(h.checkDeepHealth).toHaveBeenCalledTimes(1);
    });

    it("a scrape inside the TTL reuses the result; one after it probes again", async () => {
        const h = harness();
        await h.lite.scrape();
        h.advance(DEEP_HEALTH_LITE_TTL_MS - 1);
        expect(sampleLines(await h.lite.scrape())).toHaveLength(12);
        expect(h.checkDeepHealth).toHaveBeenCalledTimes(1);
        h.advance(2);
        await h.lite.scrape();
        expect(h.checkDeepHealth).toHaveBeenCalledTimes(2);
    });
});

describe("failures never become a 5xx or a stale claim", () => {
    it("a probe that throws => empty body (not stale, not rejected), and the failure is TTL-cached", async () => {
        const h = harness();
        // First a good probe, so there IS something stale to wrongly serve.
        await h.lite.scrape();
        h.checkDeepHealth.mockImplementation(async () => {
            throw new Error("deep check blew up");
        });
        h.advance(DEEP_HEALTH_LITE_TTL_MS + 1);
        expect(await h.lite.scrape()).toBe("");
        expect(h.checkDeepHealth).toHaveBeenCalledTimes(2);
        // a failing dependency is not hammered either
        h.advance(1_000);
        expect(await h.lite.scrape()).toBe("");
        expect(h.checkDeepHealth).toHaveBeenCalledTimes(2);
    });

    it("a health module that fails to load => empty body, and the load is retried on a later probe", async () => {
        let attempts = 0;
        const h = harness({
            loadHealth: async () => {
                attempts++;
                if (attempts === 1) throw new Error("cannot resolve");
                return { checkDeepHealth: async () => DOWN };
            },
        });
        expect(await h.lite.scrape()).toBe("");
        h.advance(DEEP_HEALTH_LITE_TTL_MS + 1);
        expect(sampleLines(await h.lite.scrape())).toHaveLength(12);
        expect(attempts).toBe(2);
    });
});

describe("the loopback server", () => {
    const servers: Array<ReturnType<typeof startDeepHealthLite>> = [];
    afterEach(async () => {
        for (const s of servers.splice(0)) {
            await new Promise<void>((r) => s.close(() => r()));
        }
    });

    const listen = async (opts: Parameters<typeof startDeepHealthLite>[0]) => {
        const server = startDeepHealthLite(opts);
        servers.push(server);
        await new Promise<void>((r) => server.once("listening", () => r()));
        return server;
    };

    const deps = (activity: () => number | undefined) => ({
        app: "test-app",
        readActivityAt: activity,
        loadHealth: async () => ({ checkDeepHealth: async () => DOWN }),
    });

    it("binds LOOPBACK only and serves GET /metrics as 200 text/plain", async () => {
        const server = await listen({
            port: 0,
            ...deps(() => Date.now()),
            env: {},
        });
        const { address, port } = server.address() as AddressInfo;
        expect(address).toBe("127.0.0.1");
        const res = await fetch(`http://127.0.0.1:${port}/metrics`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/plain");
        expect(sampleLines(await res.text())).toHaveLength(12);
    });

    it("serves 200 with an empty body while idle (never a 5xx)", async () => {
        const server = await listen({
            port: 0,
            ...deps(() => undefined),
            env: {},
        });
        const { port } = server.address() as AddressInfo;
        const res = await fetch(`http://127.0.0.1:${port}/metrics`);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("");
    });

    it("serves 200 (empty) even when the scrape itself throws", async () => {
        const server = await listen({
            port: 0,
            ...deps(() => {
                throw new Error("boom");
            }),
            env: {},
        });
        const { port } = server.address() as AddressInfo;
        const res = await fetch(`http://127.0.0.1:${port}/metrics`);
        expect(res.status).toBe(200);
    });

    it("serves 200 (empty) even when rendering a malformed health result throws", async () => {
        const server = await listen({
            port: 0,
            app: "test-app",
            readActivityAt: () => Date.now(),
            // a health module that returns garbage: render() cannot read .checks
            loadHealth: async () => ({
                checkDeepHealth: async () => ({}) as never,
            }),
            env: {},
        });
        const { port } = server.address() as AddressInfo;
        const res = await fetch(`http://127.0.0.1:${port}/metrics`);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("");
    });

    it("only GET /metrics exists: other paths and methods are 404", async () => {
        const server = await listen({
            port: 0,
            ...deps(() => Date.now()),
            env: {},
        });
        const { port } = server.address() as AddressInfo;
        expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);
        expect(
            (
                await fetch(`http://127.0.0.1:${port}/metrics`, {
                    method: "POST",
                })
            ).status,
        ).toBe(404);
    });

    it("EADDRINUSE is swallowed (tracing-on path or a second register() owns the port)", async () => {
        const first = await listen({
            port: 0,
            ...deps(() => Date.now()),
            env: {},
        });
        const { port } = first.address() as AddressInfo;
        const unhandled: unknown[] = [];
        const onUnhandled = (e: unknown) => unhandled.push(e);
        process.on("uncaughtException", onUnhandled);
        try {
            const second = startDeepHealthLite({
                port,
                ...deps(() => Date.now()),
                env: {},
            });
            servers.push(second);
            await new Promise((r) => setTimeout(r, 100));
            expect(second.listening).toBe(false);
            expect(unhandled).toEqual([]);
        } finally {
            process.off("uncaughtException", onUnhandled);
        }
    });

    it("takes its port from KN_CHILD_METRICS_PORT and falls back to 9092 on garbage (the contract's own rule)", () => {
        expect(resolveLitePort({ KN_CHILD_METRICS_PORT: "19999" })).toBe(19999);
        for (const bad of [undefined, "", "abc", "0", "-1", "65536"]) {
            expect(resolveLitePort({ KN_CHILD_METRICS_PORT: bad })).toBe(9092);
        }
    });
});

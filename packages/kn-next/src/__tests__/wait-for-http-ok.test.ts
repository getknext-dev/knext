/**
 * `waitForHttpOk` is how spawned-server tests decide a server is ready: poll
 * until 200 or a bounded deadline, then fail with the last status and the
 * server's output. A single probe flaked under CI load because a server that
 * accepts connections can still answer non-200 while it warms up.
 *
 * The deadline cases inject a clock that passes the deadline only once the
 * stub has actually served what the assertion needs. Wall-clock scheduling
 * on a loaded runner then cannot reach the deadline before the first
 * response arrives (#2201). The real-time per-probe cap stays generous.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { waitForHttpOk } from "./helpers/wait-for-http-ok";

const servers: { stop(force?: boolean): void }[] = [];
afterEach(() => {
    for (const s of servers.splice(0)) s.stop(true);
});

function listen(handler: () => Response | Promise<Response>) {
    const s = Bun.serve({ port: 0, fetch: handler });
    servers.push(s);
    return `http://127.0.0.1:${s.port}/`;
}

const rejection = (p: Promise<unknown>) =>
    p.then(
        () => undefined,
        (e: Error) => e,
    );

/** A clock that never reaches the deadline: only the per-probe cap applies. */
const frozen = () => 0;

/** A clock frozen at 0 until `passed()` says the deadline is behind us. */
const clockUntil = (passed: () => boolean) => () =>
    passed() ? Number.MAX_SAFE_INTEGER : 0;

describe("waitForHttpOk", () => {
    it("rides out a warming server that answers 503 before 200", async () => {
        let n = 0;
        const url = listen(() =>
            ++n < 4
                ? new Response("warming", { status: 503 })
                : new Response("ok"),
        );
        const res = await waitForHttpOk(url, {
            intervalMs: 10,
            deadlineMs: 5000,
            now: frozen,
        });
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("ok");
        expect(n).toBe(4);
    });

    it("rides out connection refused until the server comes up", async () => {
        const probe = Bun.serve({ port: 0, fetch: () => new Response("x") });
        const port = probe.port;
        probe.stop(true);
        setTimeout(() => {
            servers.push(
                Bun.serve({ port, fetch: () => new Response("late") }),
            );
        }, 200);
        const res = await waitForHttpOk(`http://127.0.0.1:${port}/`, {
            intervalMs: 20,
            deadlineMs: 5000,
            now: frozen,
        });
        expect(await res.text()).toBe("late");
    });

    it("fails a genuinely broken (500) server at the deadline with last status and server log", async () => {
        let served = 0;
        const url = listen(() => {
            served++;
            return new Response("boom", { status: 500 });
        });
        const err = await rejection(
            waitForHttpOk(url, {
                intervalMs: 10,
                deadlineMs: 5000,
                // The deadline passes only once the stub has served two 500s,
                // so the failure is always reached with a 500 in hand.
                now: clockUntil(() => served >= 2),
                log: () => "Invalid hook call (server stderr)",
            }),
        );
        expect(err).toBeInstanceOf(Error);
        expect(err?.message).toContain("last status 500");
        expect(err?.message).toContain("Invalid hook call (server stderr)");
        // It stops at the deadline: no probe after the one that crossed it.
        expect(served).toBe(2);
    });

    it("keeps the last status when the final probe is cut short by the deadline", async () => {
        // Request 1: an immediate 500. Request 2: the deadline passes while
        // it is in flight and it never answers, so the helper's own
        // deadline-capped timeout aborts it. That self-inflicted abort must
        // not erase the 500 already observed. Under load this is how a
        // server that answered 500 many times was reported as
        // "no response (The operation timed out.)".
        let served = 0;
        const url = listen(() => {
            served++;
            if (served === 1) return new Response("boom", { status: 500 });
            return new Promise<Response>(() => {});
        });
        const err = await rejection(
            waitForHttpOk(url, {
                intervalMs: 10,
                deadlineMs: 1500,
                now: clockUntil(() => served >= 2),
            }),
        );
        expect(err?.message).toContain("last status 500");
        expect(err?.message).not.toMatch(/no response/i);
        expect(served).toBe(2);
    });

    it("fails fast when the server process has already exited", async () => {
        const t0 = Date.now();
        const err = await rejection(
            waitForHttpOk("http://127.0.0.1:1/", {
                intervalMs: 10,
                deadlineMs: 30_000,
                exited: () => "code=1 signal=null",
                log: () => "EADDRINUSE",
            }),
        );
        expect(err?.message).toContain("exited");
        expect(err?.message).toContain("code=1");
        expect(err?.message).toContain("EADDRINUSE");
        expect(Date.now() - t0).toBeLessThan(2000);
    });

    it("at the deadline, says the server process is still running (slow, not crashed)", async () => {
        let served = 0;
        const url = listen(() => {
            served++;
            return new Response("warming", { status: 503 });
        });
        const err = await rejection(
            waitForHttpOk(url, {
                intervalMs: 10,
                deadlineMs: 5000,
                now: clockUntil(() => served >= 1),
                exited: () => null,
            }),
        );
        expect(err?.message).toContain("server process still running");
        expect(err?.message).not.toContain("exited");
    });

    it("at the deadline, reports an exit that happened during the last probe (crash, not slow)", async () => {
        // A probe that hangs until the deadline: the process dies after the
        // loop's last exit check but before the deadline is judged, so the
        // error must name the exit rather than call the server slow.
        // The injected clock and the exit both flip once the hanging probe has
        // reached the stub, so the loop's own pre-probe check saw a live process.
        let served = 0;
        const url = listen(() => {
            served++;
            return new Promise<Response>(() => {});
        });
        const err = await rejection(
            waitForHttpOk(url, {
                intervalMs: 10,
                deadlineMs: 300,
                now: clockUntil(() => served >= 1),
                exited: () => (served >= 1 ? "code=7 signal=null" : null),
            }),
        );
        expect(err?.message).toContain("server exited before ready");
        expect(err?.message).toContain("code=7");
        expect(err?.message).not.toContain("still running");
    });

    it("reports connection errors when the server never listens", async () => {
        const err = await rejection(
            waitForHttpOk("http://127.0.0.1:1/", {
                intervalMs: 10,
                deadlineMs: 200,
            }),
        );
        expect(err?.message).toMatch(/no response/i);
    });
});

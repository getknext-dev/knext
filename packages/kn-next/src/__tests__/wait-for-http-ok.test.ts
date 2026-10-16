/**
 * `waitForHttpOk` is how spawned-server tests decide a server is ready: poll
 * until 200 or a bounded deadline, then fail with the last status and the
 * server's output. A single probe flaked under CI load because a server that
 * accepts connections can still answer non-200 while it warms up.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { waitForHttpOk } from "./helpers/wait-for-http-ok";

const servers: { stop(force?: boolean): void }[] = [];
afterEach(() => {
    for (const s of servers.splice(0)) s.stop(true);
});

function listen(handler: () => Response) {
    const s = Bun.serve({ port: 0, fetch: handler });
    servers.push(s);
    return `http://127.0.0.1:${s.port}/`;
}

const rejection = (p: Promise<unknown>) =>
    p.then(
        () => undefined,
        (e: Error) => e,
    );

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
        });
        expect(await res.text()).toBe("late");
    });

    it("retries a 500 until the deadline, then fails with last status and server log", async () => {
        // Fake clock: time advances only through the injected sleep, so the
        // attempt count is exact and independent of CI load.
        let clock = 0;
        let attempts = 0;
        const err = await rejection(
            waitForHttpOk("http://broken.invalid/", {
                intervalMs: 100,
                deadlineMs: 1000,
                now: () => clock,
                sleep: async (ms) => {
                    clock += ms;
                },
                fetch: async () => {
                    attempts++;
                    return new Response("boom", { status: 500 });
                },
                log: () => "Invalid hook call (server stderr)",
            }),
        );
        expect(err).toBeInstanceOf(Error);
        expect(err?.message).toContain("500");
        expect(err?.message).toContain("Invalid hook call (server stderr)");
        // Probes at t = 0, 100, ..., 1000 ms: 11 attempts, each retried.
        expect(attempts).toBe(11);
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
        const err = await rejection(
            waitForHttpOk("http://127.0.0.1:1/", {
                intervalMs: 10,
                deadlineMs: 200,
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
        const url = listen(() => new Promise<Response>(() => {}) as never);
        const t0 = Date.now();
        const err = await rejection(
            waitForHttpOk(url, {
                intervalMs: 10,
                deadlineMs: 300,
                exited: () =>
                    Date.now() - t0 >= 100 ? "code=7 signal=null" : null,
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

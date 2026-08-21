import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Deliberately a cross-package RELATIVE import, not a subpath: the emitter is
// internal to @getknext/lib (no new public subpath, no public-API change), and
// this test exists precisely to hold the two copies to one format.
import { logSlowDep as libLogSlowDep } from "../../../lib/src/slow-dep";
import { logSlowDep as coreLogSlowDep } from "../adapters/slow-dep-log.js";

/**
 * Two emitters, one format — the drift guard.
 *
 * The PG reading is timed inside `@getknext/lib` (the `getDbPool` seam) and the
 * two Redis readings inside `@getknext/core`'s cache handler. `lib` cannot
 * import `core` (that is the dependency cycle) and the cache handler is
 * deliberately dependency-light, so the emitter exists twice. That is only
 * acceptable while the two produce the SAME line: the whole point of the
 * instrument is that one `grep '[slow-dep]'` over a stalled pod's logs returns
 * all three readings in one comparable shape.
 */
describe("slow-dep line format parity across the two emitters", () => {
    let warn: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        warn = vi.fn();
        vi.spyOn(console, "warn").mockImplementation(
            warn as unknown as typeof console.warn,
        );
        delete process.env.SLOW_DEP_LOG_MS;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("produces byte-identical lines for the same input", () => {
        libLogSlowDep("pg", "pool.query", 2412, { role: "writer" });
        coreLogSlowDep("pg", "pool.query", 2412, { role: "writer" });

        const lines = warn.mock.calls.map((c: unknown[]) => String(c[0]));
        expect(lines).toHaveLength(2);
        expect(lines[0]).toBe(lines[1]);
        expect(lines[0].startsWith("[slow-dep] ")).toBe(true);
    });

    it("agrees on the threshold, both halves", () => {
        process.env.SLOW_DEP_LOG_MS = "300";
        expect(libLogSlowDep("pg", "pool.query", 299)).toBe(
            coreLogSlowDep("pg", "pool.query", 299),
        );
        expect(libLogSlowDep("pg", "pool.query", 301)).toBe(
            coreLogSlowDep("pg", "pool.query", 301),
        );
        expect(libLogSlowDep("pg", "pool.query", 301)).toBe(true);
        expect(libLogSlowDep("pg", "pool.query", 299)).toBe(false);
        delete process.env.SLOW_DEP_LOG_MS;
    });

    it("both drop URL-shaped context (no DSN, no credentials)", () => {
        const secret = "redis://:hunter2@redis.default.svc.cluster.local.:6379";
        libLogSlowDep("redis-connect", "client.connect", 9000, {
            target: secret,
        });
        coreLogSlowDep("redis-connect", "client.connect", 9000, {
            target: secret,
        });

        const lines = warn.mock.calls.map((c: unknown[]) => String(c[0]));
        expect(lines).toHaveLength(2);
        for (const line of lines) {
            expect(line).not.toContain("hunter2");
            expect(line).not.toContain("://");
        }
    });
});

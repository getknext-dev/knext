/**
 * logger-output-parity.test.ts — cold-start perf (#441 follow-up).
 *
 * Making pino lazy (loaded on first emit rather than at module import) must NOT
 * change a single byte of log OUTPUT. This asserts that a child logger produced
 * by `createLogger(...)` still emits pino's default structured-JSON shape in
 * production mode (transport undefined): `level`, `time`, the child `bindings`,
 * and `msg` — exactly what the eager `pino({...}).child(...)` produced.
 */

import { describe, expect, it, vi } from "vitest";

describe("logger output parity (prod JSON)", () => {
    it("emits pino default JSON with level, time, bindings and msg", async () => {
        vi.stubEnv("NODE_ENV", "production");
        vi.resetModules();

        const { createLogger } = await import("../utils/logger");
        const log = createLogger({ module: "parity" });

        const lines: string[] = [];
        const spy = vi
            .spyOn(process.stdout, "write")
            .mockImplementation((chunk: unknown) => {
                lines.push(String(chunk));
                return true;
            });

        log.info({ imageTag: "v1.0.0" }, "hello");
        spy.mockRestore();

        expect(lines.length).toBeGreaterThan(0);
        const parsed = JSON.parse(lines[0]);
        expect(parsed.level).toBe(30); // pino numeric level for info
        expect(parsed.name).toBe("kn-next");
        expect(parsed.module).toBe("parity");
        expect(parsed.imageTag).toBe("v1.0.0");
        expect(parsed.msg).toBe("hello");
        expect(typeof parsed.time).toBe("number");

        vi.unstubAllEnvs();
    });
});

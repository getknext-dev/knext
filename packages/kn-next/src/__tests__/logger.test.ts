import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
    stubEnv,
    unstubAllEnvs,
} from "../../../../tests/helpers/bun-test-helpers";

// The kn-next framework logger (`../utils/logger`) builds a named pino instance
// at module load and also exposes `createLogger(bindings)` for child scoping.
// In production it writes raw JSON (no pino-pretty worker); we pin its real,
// observable contract:
//   - constructs/exports without throwing,
//   - honors LOG_LEVEL, with a prod default of "info",
//   - carries the load-bearing `name: "kn-next"` binding,
//   - and `createLogger` returns a child that merges extra bindings.

function forceProdEnv() {
    // Force the raw-JSON branch — no pino-pretty transport worker under vitest.
    stubEnv("NODE_ENV", "production");
    // Delete LOG_LEVEL (not ''): kn-next reads it via `??`, so an empty string
    // would survive and hand pino an invalid level.
    stubEnv("LOG_LEVEL", undefined);
}

describe("kn-next logger — instance contract", () => {
    beforeEach(async () => {
        // env FIRST, then the reset. `__resetLoggerForTests` re-reads
        // `NODE_ENV`, so resetting before `forceProdEnv()` recomputes
        // `isProduction` from the OLD value and the logger is rebuilt for the
        // wrong environment — the level assertion then fails describing the
        // logger rather than the ordering.
        forceProdEnv();
        (await import("../utils/logger")).__resetLoggerForTests();
    });

    afterEach(async () => {
        unstubAllEnvs();
    });

    it("constructs and exports a usable logger without throwing", async () => {
        const { logger } = await import("../utils/logger");
        expect(logger).toBeDefined();
        expect(typeof logger.info).toBe("function");
        expect(() => logger.info({ hello: "world" }, "ping")).not.toThrow();
    });

    it("honors LOG_LEVEL from the environment", async () => {
        stubEnv("LOG_LEVEL", "error");
        const { logger } = await import("../utils/logger");
        expect(logger.level).toBe("error");
        expect(logger.isLevelEnabled("error")).toBe(true);
        expect(logger.isLevelEnabled("warn")).toBe(false);
    });

    it("defaults to info level in production when LOG_LEVEL is unset", async () => {
        const { logger } = await import("../utils/logger");
        expect(logger.level).toBe("info");
    });

    it('carries the load-bearing name binding ("kn-next")', async () => {
        const { logger } = await import("../utils/logger");
        expect(logger.bindings().name).toBe("kn-next");
    });
});

describe("kn-next logger — createLogger child scoping", () => {
    beforeEach(async () => {
        // env FIRST, then the reset. `__resetLoggerForTests` re-reads
        // `NODE_ENV`, so resetting before `forceProdEnv()` recomputes
        // `isProduction` from the OLD value and the logger is rebuilt for the
        // wrong environment — the level assertion then fails describing the
        // logger rather than the ordering.
        forceProdEnv();
        (await import("../utils/logger")).__resetLoggerForTests();
    });

    afterEach(async () => {
        unstubAllEnvs();
    });

    it("returns a child logger that merges extra bindings onto the base", async () => {
        const { createLogger } = await import("../utils/logger");
        const child = createLogger({ module: "deploy" });
        const bindings = child.bindings();
        // Child keeps the parent's name and adds its own scope.
        expect(bindings.name).toBe("kn-next");
        expect(bindings.module).toBe("deploy");
        expect(() =>
            child.info({ imageTag: "v1.0.0" }, "deploying"),
        ).not.toThrow();
    });
});

describe("kn-next logger — pino wiring (mocks pino; must run LAST)", () => {
    it("defaults to debug level outside production when LOG_LEVEL is unset", async () => {
        // LAST in the file, deliberately.
        //
        // This case replaces `pino`, and bun registers a module mock for the
        // WHOLE RUN — `mock.restore()` restores spies only, and there is no
        // `doUnmock`. Anything after it would silently receive this fake pino;
        // the `createLogger` case below used to, and only passed because
        // vitest could unregister the mock.
        //
        // Ordering is the enforcement, which is fragile — so if a case is ever
        // added after this one, it must construct its own logger rather than
        // trusting the module.
        // The pretty transport is skipped by passing an explicit destination
        // via the pino mock, so this stays worker-free under vitest while
        // still exercising the real non-prod level default.
        stubEnv("NODE_ENV", "development");
        // Reset AFTER the env change. This case sits in its own describe (see
        // above) and so has no shared `beforeEach` — without this it reuses the
        // logger the previous describe memoised under NODE_ENV=production and
        // reads "info" where it asserts "debug".
        (await import("../utils/logger")).__resetLoggerForTests();
        const realPino = (await import("pino")).default;
        mock.module("pino", () => {
            const factory = (options: Record<string, unknown>) =>
                realPino(
                    { ...options, transport: undefined },
                    { write: () => {} },
                );
            // BOTH shapes. `logger.ts` reaches pino through `createRequire`, so
            // it does a CJS `require("pino")` and receives the module object
            // itself — not `.default`. Returning only `{ default }` gave it a
            // plain object and it died with `requirePino("pino") is not a
            // function`, pointing at the source rather than at this mock.
            //
            // vitest's interop unwrapped `default` for the require; bun does not.
            return Object.assign(factory, { default: factory });
        });
        const { logger } = await import("../utils/logger");
        expect(logger.level).toBe("debug");
    });
});

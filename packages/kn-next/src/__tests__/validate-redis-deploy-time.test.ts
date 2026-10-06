/**
 * The redis cache URL is a DEPLOY-time requirement, not a build-time one: the
 * scaffold tells users to set REDIS_URL at deploy, and the cache handler falls
 * back to in-memory when it is unset. Both halves are asserted — the build
 * passes without a URL, and the deploy still refuses one.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderScaffold } from "../cli/create";
import {
    applyCreateChoices,
    DEFAULT_CREATE_CHOICES,
} from "../cli/create-options";
import { loadConfig } from "../cli/shared";
import { validateConfig } from "../cli/validate";
import type { KnativeNextConfig } from "../config";

const redisNoUrl = {
    name: "my-app",
    registry: "reg.example.com",
    storage: { provider: "gcs", bucket: "b", publicUrl: "https://x" },
    cache: { provider: "redis", url: "" },
} as KnativeNextConfig;

describe("redis cache.url is a deploy-time requirement", () => {
    it("build phase passes with no cache.url", () => {
        expect(() =>
            validateConfig(redisNoUrl, undefined, { phase: "build" }),
        ).not.toThrow();
    });

    it("deploy phase still refuses, naming REDIS_URL at deploy time", () => {
        expect(() =>
            validateConfig(redisNoUrl, undefined, { phase: "deploy" }),
        ).toThrow(/cache\.url.*required.*Redis.*REDIS_URL.*deploy/s);
    });

    it("the default phase is strict (deploy)", () => {
        expect(() => validateConfig(redisNoUrl)).toThrow(/cache\.url/);
    });

    it("build phase still rejects unrelated invalid config", () => {
        expect(() =>
            validateConfig(
                { ...redisNoUrl, name: "" } as KnativeNextConfig,
                undefined,
                { phase: "build" },
            ),
        ).toThrow(/'name' is required/);
    });

    describe("loadConfig", () => {
        const prev = process.cwd();
        let dir = "";
        afterEach(() => {
            process.chdir(prev);
            if (dir) rmSync(dir, { recursive: true, force: true });
        });
        function setup() {
            dir = mkdtempSync(join(tmpdir(), "knext-1885-"));
            writeFileSync(
                join(dir, "knext.config.ts"),
                `export default ${JSON.stringify(redisNoUrl)};\n`,
            );
            process.chdir(dir);
        }
        it("loadConfig({phase:'build'}) succeeds without a redis URL", async () => {
            setup();
            await expect(loadConfig({ phase: "build" })).resolves.toBeDefined();
        });
        it("loadConfig() (deploy) rejects a redis cache without a URL", async () => {
            setup();
            await expect(loadConfig()).rejects.toThrow(/cache\.url/);
        });
    });

    it("build.ts loads config with the build phase", async () => {
        const src = await Bun.file(
            join(import.meta.dir, "../cli/build.ts"),
        ).text();
        expect(src).toMatch(/loadConfig\(\s*\{\s*phase:\s*"build"\s*\}\s*\)/);
    });

    describe("the real cache:redis scaffold (REDIS_URL unset)", () => {
        const prevCwd = process.cwd();
        const prevUrl = process.env.REDIS_URL;
        let dir = "";
        afterEach(() => {
            process.chdir(prevCwd);
            if (prevUrl === undefined) delete process.env.REDIS_URL;
            else process.env.REDIS_URL = prevUrl;
            if (dir) rmSync(dir, { recursive: true, force: true });
        });
        function scaffold(runtime: "bun" | "node") {
            const files = applyCreateChoices(
                renderScaffold({
                    name: "hello-knext",
                    version: "1.3.0",
                    runtime,
                }),
                { ...DEFAULT_CREATE_CHOICES, runtime, cache: "redis" },
            );
            const cfg = files.get("knext.config.ts") ?? "";
            expect(cfg).toContain("process.env.REDIS_URL");
            dir = mkdtempSync(join(tmpdir(), `knext-1885-${runtime}-`));
            writeFileSync(join(dir, "knext.config.ts"), cfg);
            delete process.env.REDIS_URL;
            process.chdir(dir);
        }
        for (const runtime of ["bun", "node"] as const) {
            it(`${runtime}: build passes, deploy rejects with the deploy-time message`, async () => {
                scaffold(runtime);
                await expect(
                    loadConfig({ phase: "build" }),
                ).resolves.toBeDefined();
                await expect(loadConfig()).rejects.toThrow(
                    /when you run `knext deploy`/,
                );
            });
        }
    });
});

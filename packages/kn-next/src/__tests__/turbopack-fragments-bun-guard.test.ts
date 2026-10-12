/**
 * Guard: `experimental.turbopackModuleFragments` + the Bun runtime.
 *
 * With that flag on, Next 16.4 Turbopack emits chunks that assign to a `const`
 * in code that never runs. Bun's parser rejects that at LOAD time (Node does
 * not), so a Bun-runtime app fails on those chunks. The build refuses it up
 * front, and `knext doctor` reports the same condition.
 *
 * Cases: Bun + flag -> refuse; Node + flag -> allow; Bun + flag off -> allow;
 * unreadable next config -> refuse (fail closed); doctor row.
 */

import {
    afterAll,
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    jest,
    mock,
} from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireIsolatedProcess } from "../../../../tests/helpers/require-isolated-process";
import { type KubectlFn, type ProbeOutcome, runDoctor } from "../cli/doctor";
import {
    assertNoBunTurbopackFragments,
    enablesTurbopackModuleFragments,
} from "../cli/turbopack-fragments-guard";

requireIsolatedProcess("turbopack-fragments-bun-guard.test.ts");

const __realExec = { ...(await import("../cli/exec")) };
const __realShared = { ...(await import("../cli/shared")) };
const __realAssets = { ...(await import("../utils/asset-upload")) };
afterAll(() => {
    // Restore: bun cannot unregister mock.module, and a leaked fake of
    // ../cli/shared breaks any later test in the same process.
    mock.module("../cli/exec", () => __realExec);
    mock.module("../cli/shared", () => __realShared);
    mock.module("../utils/asset-upload", () => __realAssets);
});

const runQuiet = (() => mock())();
mock.module("../cli/exec", () => ({ runQuiet, isEntrypoint: () => false }));
const loadConfig = (() => mock())();
mock.module("../cli/shared", () => ({
    loadConfig,
    UsageError: class UsageError extends Error {},
}));
const uploadAssets = (() => mock(async () => {}))();
mock.module("../utils/asset-upload", () => ({ ...__realAssets, uploadAssets }));

import { build } from "../cli/build";

const ON =
    "export default { experimental: { turbopackModuleFragments: true } };";
const OFF =
    "export default { experimental: { turbopackModuleFragments: false } };";

describe("enablesTurbopackModuleFragments", () => {
    it("detects the flag only when truly on", () => {
        expect(enablesTurbopackModuleFragments(ON)).toBe(true);
        expect(enablesTurbopackModuleFragments(OFF)).toBe(false);
        expect(enablesTurbopackModuleFragments("export default {};")).toBe(
            false,
        );
        expect(
            enablesTurbopackModuleFragments(
                "// turbopackModuleFragments: true\nexport default {};",
            ),
        ).toBe(false);
    });
});

describe("assertNoBunTurbopackFragments", () => {
    it("refuses Bun + flag on, with an actionable message", () => {
        let message = "";
        try {
            assertNoBunTurbopackFragments({
                runtime: "bun",
                builder: "turbopack",
                readNextConfig: () => ON,
            });
        } catch (e) {
            message = (e as Error).message;
        }
        expect(message).toMatch(/turbopackModuleFragments/);
        expect(message).toMatch(/Bun/);
        expect(message).toMatch(/turn .*off|remove/i);
        expect(message).toMatch(/runtime: ?"?node/);
    });
    it("allows Node + flag on", () => {
        expect(() =>
            assertNoBunTurbopackFragments({
                runtime: "node",
                builder: "turbopack",
                readNextConfig: () => ON,
            }),
        ).not.toThrow();
    });
    it("allows Bun + flag off, and Bun with no next config", () => {
        expect(() =>
            assertNoBunTurbopackFragments({
                runtime: "bun",
                builder: "turbopack",
                readNextConfig: () => OFF,
            }),
        ).not.toThrow();
        expect(() =>
            assertNoBunTurbopackFragments({
                runtime: "bun",
                builder: "turbopack",
                readNextConfig: () => undefined,
            }),
        ).not.toThrow();
    });
    it("allows Bun + flag on for webpack and vinext builds (no Turbopack chunks)", () => {
        for (const builder of ["webpack", "vinext"]) {
            expect(() =>
                assertNoBunTurbopackFragments({
                    runtime: "bun",
                    builder,
                    readNextConfig: () => ON,
                }),
            ).not.toThrow();
        }
    });
    it("fails closed when the next config exists but cannot be read (Bun)", () => {
        const boom = () => {
            throw new Error("EACCES");
        };
        expect(() =>
            assertNoBunTurbopackFragments({
                runtime: "bun",
                builder: "turbopack",
                readNextConfig: boom,
            }),
        ).toThrow(/could not read/i);
        // Node is unaffected by the Bun bug.
        expect(() =>
            assertNoBunTurbopackFragments({
                runtime: "node",
                builder: "turbopack",
                readNextConfig: boom,
            }),
        ).not.toThrow();
    });
});

describe("build() wiring", () => {
    let dir: string;
    const saved = process.cwd();
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "knext-frag-"));
        process.chdir(dir);
        jest.clearAllMocks();
    });
    afterEach(() => {
        process.chdir(saved);
        rmSync(dir, { recursive: true, force: true });
    });
    const cfg = (over: Record<string, unknown>) => ({
        name: "a",
        registry: "r",
        build: "turbopack",
        storage: { provider: "gcs", bucket: "b" },
        ...over,
    });

    it("refuses on bun (explicit) before running the project build", async () => {
        writeFileSync(join(dir, "next.config.ts"), ON);
        loadConfig.mockResolvedValue(cfg({ runtime: "bun" }));
        await expect(build({})).rejects.toThrow(/turbopackModuleFragments/);
        expect(runQuiet).not.toHaveBeenCalled();
    });
    it("refuses when runtime is unset (bun is the default)", async () => {
        writeFileSync(join(dir, "next.config.ts"), ON);
        loadConfig.mockResolvedValue(cfg({}));
        await expect(build({ skipNextBuild: true })).rejects.toThrow(
            /turbopackModuleFragments/,
        );
    });
    it("does not refuse on node", async () => {
        writeFileSync(join(dir, "next.config.ts"), ON);
        loadConfig.mockResolvedValue(cfg({ runtime: "node" }));
        await build({ skipNextBuild: true }).catch((e) => {
            expect(String(e)).not.toMatch(/turbopackModuleFragments/);
        });
    });
    it("does not refuse on bun for webpack or vinext builds", async () => {
        writeFileSync(join(dir, "next.config.ts"), ON);
        for (const b of ["webpack", "vinext"]) {
            loadConfig.mockResolvedValue(cfg({ runtime: "bun", build: b }));
            await build({ skipNextBuild: true }).catch((e) => {
                expect(String(e)).not.toMatch(/turbopackModuleFragments/);
            });
        }
    });
    it("fails closed on an unreadable next.config", async () => {
        const p = join(dir, "next.config.ts");
        writeFileSync(p, ON);
        chmodSync(p, 0o000);
        loadConfig.mockResolvedValue(cfg({ runtime: "bun" }));
        try {
            await expect(build({ skipNextBuild: true })).rejects.toThrow(
                /could not read/i,
            );
        } finally {
            chmodSync(p, 0o644);
        }
    });
});

describe("doctor row", () => {
    const noKubectl: KubectlFn = () => ({
        ok: false,
        stdout: "",
        stderr: "x",
    });
    const okProbe = async (): Promise<ProbeOutcome> => "ok";
    const run = (text: string | undefined, runtime?: string, bld?: string) =>
        runDoctor({
            kubectl: noKubectl,
            probeImage: okProbe,
            readNextConfigFile: () => text,
            loadAppConfig: async () =>
                ({
                    name: "a",
                    registry: "r",
                    ...(runtime ? { runtime } : {}),
                    ...(bld ? { build: bld } : {}),
                }) as never,
        });
    it("reports a failing row for bun + flag", async () => {
        const row = (await run(ON, "bun")).checks.find(
            (c) => c.id === "turbopack-fragments-bun",
        );
        expect(row?.status).toBe("fail");
        expect(row?.detail).toMatch(/turbopackModuleFragments/);
        expect(row?.hint).toBeTruthy();
    });
    it("reports for the default runtime too", async () => {
        const row = (await run(ON)).checks.find(
            (c) => c.id === "turbopack-fragments-bun",
        );
        expect(row?.status).toBe("fail");
    });
    it("is silent for webpack and vinext builds on bun", async () => {
        for (const b of ["webpack", "vinext"]) {
            const rep = await run(ON, "bun", b);
            expect(
                rep.checks.some((c) => c.id === "turbopack-fragments-bun"),
            ).toBe(false);
        }
    });
    it("is silent for node, flag off, or no config", async () => {
        for (const [t, r] of [
            [ON, "node"],
            [OFF, "bun"],
            [undefined, "bun"],
        ] as const) {
            const rep = await run(t, r);
            expect(
                rep.checks.some((c) => c.id === "turbopack-fragments-bun"),
            ).toBe(false);
        }
    });
});

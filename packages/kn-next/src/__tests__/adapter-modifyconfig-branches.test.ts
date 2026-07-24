/**
 * next-adapter.ts — modifyConfig branch coverage (#356/ADR-0031). The hook only
 * acts on phase-production-build (else it returns config untouched), forces
 * output:'standalone', and COMPOSES the app's own webpack hook before appending
 * the edge-only IgnorePlugin fence. Here we cover the non-build early return and
 * the app-webpack-compose path for a non-edge (nodejs) runtime.
 */

import { describe, expect, it, vi } from "vitest";
import adapter from "../adapters/next-adapter";

type ModifyConfig = NonNullable<typeof adapter.modifyConfig>;
const modifyConfig = adapter.modifyConfig as ModifyConfig;

describe("adapter.modifyConfig", () => {
    it("returns the config untouched outside phase-production-build", () => {
        const config = {
            output: undefined,
        } as unknown as Parameters<ModifyConfig>[0];
        const out = modifyConfig(config, {
            phase: "phase-development-server",
        } as Parameters<ModifyConfig>[1]);
        expect(out).toBe(config);
    });

    it("forces output:standalone and composes the app's own webpack hook (nodejs runtime)", () => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        const appWebpack = vi.fn((wc: Record<string, unknown>) => ({
            ...wc,
            appTouched: true,
        }));
        const config = {
            webpack: appWebpack,
        } as unknown as Parameters<ModifyConfig>[0];

        const out = modifyConfig(config, {
            phase: "phase-production-build",
        } as Parameters<ModifyConfig>[1]) as {
            output: string;
            webpack: (wc: object, ctx: object) => { appTouched?: boolean };
        };

        expect(out.output).toBe("standalone");

        // A nodejs-runtime compile runs the app hook and appends NO edge plugin.
        const result = out.webpack({ plugins: [] }, { nextRuntime: "nodejs" });
        expect(appWebpack).toHaveBeenCalledTimes(1);
        expect(result.appTouched).toBe(true);
    });
});

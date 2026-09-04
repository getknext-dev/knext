/**
 * next-adapter.ts — modifyConfig branch coverage (#356/ADR-0031, amended by
 * #408). The hook injects the edge-only IgnorePlugin fence in EVERY phase
 * (measured: `next dev --webpack` fails the edge compile without it) and
 * COMPOSES the app's own webpack hook before appending it; only
 * `output: 'standalone'` is gated on phase-production-build. Here we cover the
 * non-build phase and the app-webpack-compose path for a non-edge (nodejs)
 * runtime.
 */

import { describe, expect, it, mock, spyOn } from "bun:test";
import adapter from "../adapters/next-adapter";

type ModifyConfig = NonNullable<typeof adapter.modifyConfig>;
const modifyConfig = adapter.modifyConfig as ModifyConfig;

describe("adapter.modifyConfig", () => {
    it("outside phase-production-build: keeps output unset but still carries the fence", () => {
        spyOn(console, "log").mockImplementation(() => {});
        const config = {
            output: undefined,
            reactStrictMode: true,
        } as unknown as Parameters<ModifyConfig>[0];
        const out = modifyConfig(config, {
            phase: "phase-development-server",
        } as Parameters<ModifyConfig>[1]) as {
            output?: string;
            reactStrictMode?: boolean;
            webpack?: unknown;
        };
        expect(out.output).toBeUndefined();
        expect(out.reactStrictMode).toBe(true);
        // #408: dev must NOT lose the edge fence — `next dev --webpack` breaks without it.
        expect(typeof out.webpack).toBe("function");
    });

    it("forces output:standalone and composes the app's own webpack hook (nodejs runtime)", () => {
        spyOn(console, "log").mockImplementation(() => {});
        const appWebpack = mock((wc: Record<string, unknown>) => ({
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

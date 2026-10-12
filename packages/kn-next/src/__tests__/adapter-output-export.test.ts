/**
 * modifyConfig respects a user's `output: 'export'`.
 *
 * The adapter used to overwrite every production build's `output` with
 * 'standalone'. A user who asked for a static export then got a server app they
 * never asked for, and Next's own export-time validation (for example
 * "Intercepting routes are not supported with static export") was silently
 * skipped because Next never saw `export`. 'standalone' is now only the
 * DEFAULT: an explicit `output: 'export'` is left alone so Next validates it,
 * and the CLI refuses the resulting static export (see
 * static-export-refusal.test.ts).
 */

import { describe, expect, it, spyOn } from "bun:test";
import adapter from "../adapters/next-adapter";

type ModifyConfig = NonNullable<typeof adapter.modifyConfig>;
const modifyConfig = adapter.modifyConfig as ModifyConfig;

function build(output: unknown): { output?: string } {
    spyOn(console, "log").mockImplementation(() => {});
    const config = { output } as unknown as Parameters<ModifyConfig>[0];
    return modifyConfig(config, {
        phase: "phase-production-build",
    } as Parameters<ModifyConfig>[1]) as { output?: string };
}

describe("adapter.modifyConfig output handling", () => {
    it("leaves an explicit output:'export' untouched so Next runs its own export validation", () => {
        expect(build("export").output).toBe("export");
    });

    it("still defaults an unset output to 'standalone' on a production build", () => {
        expect(build(undefined).output).toBe("standalone");
    });

    it("leaves output:'standalone' unchanged", () => {
        expect(build("standalone").output).toBe("standalone");
    });

    it("does not touch output outside a production build, whatever the user chose", () => {
        spyOn(console, "log").mockImplementation(() => {});
        const out = modifyConfig(
            { output: "export" } as never,
            {
                phase: "phase-development-server",
            } as Parameters<ModifyConfig>[1],
        ) as { output?: string };
        expect(out.output).toBe("export");
    });
});

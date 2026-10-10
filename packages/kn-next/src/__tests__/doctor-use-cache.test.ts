/**
 * `knext doctor` -- 'use cache' per-pod warning (#2083, 1.x interim).
 *
 * The scaffold sets cacheMaxMemorySize: 0 and wires no cacheHandlers, so a
 * server-side 'use cache' entry is per-pod and lost on scale-to-zero. Doctor
 * says so (WARN only) for an app that enables cacheComponents, and stays
 * silent -- no row at all -- for an app that does not.
 */

import { describe, expect, it } from "bun:test";
import { type KubectlFn, type ProbeOutcome, runDoctor } from "../cli/doctor";

const noKubectl: KubectlFn = () => ({
    ok: false,
    stdout: "",
    stderr: "no stub",
});
const okProbe = async (): Promise<ProbeOutcome> => "ok";

const run = (nextConfig: string | undefined) =>
    runDoctor({
        kubectl: noKubectl,
        probeImage: okProbe,
        readNextConfigFile: () => nextConfig,
    });

describe("doctor use-cache check (#2083)", () => {
    it("warns for an app with cacheComponents: true", async () => {
        const report = await run(
            "export default { cacheComponents: true, output: 'standalone' };",
        );
        const row = report.checks.find((c) => c.id === "use-cache");
        expect(row?.status).toBe("warn");
        expect(row?.detail).toMatch(/per-pod/);
        expect(row?.detail).toMatch(/scale-to-zero/);
        expect(row?.hint).toBeTruthy();
    });

    it("is a warning, not a failure: it never changes the exit code", async () => {
        const withIt = await run("export default { cacheComponents: true };");
        const without = await run("export default {};");
        expect(withIt.exitCode).toBe(without.exitCode);
    });

    it("is silent for an app without it", async () => {
        for (const cfg of [
            "export default { output: 'standalone' };",
            "export default { cacheComponents: false };",
            "// cacheComponents: true is commented out\nexport default {};",
            undefined,
        ]) {
            const report = await run(cfg);
            expect(report.checks.some((c) => c.id === "use-cache")).toBe(false);
        }
    });
});

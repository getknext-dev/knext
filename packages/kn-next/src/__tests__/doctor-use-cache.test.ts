/**
 * `knext doctor` -- 'use cache' on knext (#2083).
 *
 * With knext's cacheHandler the adapter wires the shared Redis 'use cache'
 * backend, so doctor reports it as shared (PASS). With no cacheHandler an app
 * gets Next's built-in handler, which is per-pod and off under the scaffold's
 * cacheMaxMemorySize: 0 -- doctor says so (WARN only). An app that sets its own
 * cacheHandlers owns the choice, and an app without cacheComponents gets no row.
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

const scaffold =
    "export default { cacheComponents: true, cacheHandler: new URL('./cache-handler.js', import.meta.url).pathname, cacheMaxMemorySize: 0 };";

describe("doctor use-cache check (#2083)", () => {
    it("passes for an app with cacheComponents and knext's cacheHandler: shared across pods", async () => {
        const report = await run(scaffold);
        const row = report.checks.find((c) => c.id === "use-cache");
        expect(row?.status).toBe("pass");
        expect(row?.detail).toMatch(/shared across pods/);
        expect(row?.detail).toMatch(/REDIS_URL/);
    });

    it("warns for an app with cacheComponents and NO cacheHandler: per-pod", async () => {
        const report = await run(
            "export default { cacheComponents: true, output: 'standalone' };",
        );
        const row = report.checks.find((c) => c.id === "use-cache");
        expect(row?.status).toBe("warn");
        expect(row?.detail).toMatch(/per-pod/);
        expect(row?.detail).toMatch(/scale-to-zero/);
        expect(row?.hint).toMatch(/cacheHandler/);
    });

    it("has no row when the app sets its own cacheHandlers (their choice)", async () => {
        const report = await run(
            "export default { cacheComponents: true, cacheHandler: './h.js', cacheHandlers: { default: './uc.js' } };",
        );
        expect(report.checks.some((c) => c.id === "use-cache")).toBe(false);
    });

    it("never changes the exit code: PASS and WARN rows are not failures", async () => {
        const without = await run("export default {};");
        for (const cfg of [
            scaffold,
            "export default { cacheComponents: true };",
        ]) {
            expect((await run(cfg)).exitCode).toBe(without.exitCode);
        }
    });

    it("is silent for an app without cacheComponents", async () => {
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

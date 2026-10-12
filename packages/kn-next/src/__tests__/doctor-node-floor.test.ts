/**
 * `knext doctor` Node-version row (v2 K5).
 *
 * The CLI refuses to start below Node 24, so doctor only ever sees a passing
 * version in practice. The row still exists because `runDoctor` is a library
 * surface (and the same check serves `doctor --json` consumers): it reports the
 * running version against the floor, and a failing version carries the exact
 * message the start-up guard prints.
 */

import { describe, expect, it } from "bun:test";
import { runDoctor } from "../cli/doctor";
import { nodeFloorCheck } from "../cli/doctor/checks/node-floor";
import type { CheckContext, DoctorDeps } from "../cli/doctor/types";
import { checkNodeFloor } from "../cli/node-floor";

function ctx(nodeVersion?: string): CheckContext {
    const kubectl = () => ({ ok: false, stdout: "", stderr: "" });
    const deps: DoctorDeps = {
        kubectl,
        probeImage: async () => "ok",
        ...(nodeVersion === undefined ? {} : { nodeVersion }),
    };
    return { deps, kubectl, skipAll: false, verbose: false };
}

describe("nodeFloorCheck", () => {
    it("PASS on Node 24, naming the version and the floor", () => {
        const [r] = nodeFloorCheck(ctx("24.14.0"));
        expect(r?.id).toBe("node-version");
        expect(r?.status).toBe("pass");
        expect(r?.detail).toContain("24.14.0");
        expect(r?.detail).toContain("24");
    });

    it("PASS on a newer Node (26.3.0, e.g. what Bun reports)", () => {
        expect(nodeFloorCheck(ctx("26.3.0"))[0]?.status).toBe("pass");
    });

    it("FAIL on Node 22 with the start-up guard's own message", () => {
        const [r] = nodeFloorCheck(ctx("22.12.0"));
        expect(r?.status).toBe("fail");
        expect(r?.detail).toBe(checkNodeFloor("22.12.0").message);
        expect(r?.hint).toMatch(/Node\.js to 24 or later/);
    });

    it("FAIL on an unreadable version (fails closed)", () => {
        expect(nodeFloorCheck(ctx("not-a-version"))[0]?.status).toBe("fail");
    });

    it("defaults to the running Node when no version is injected", () => {
        const [r] = nodeFloorCheck(ctx());
        expect(r?.detail).toContain(process.versions.node);
    });
});

describe("runDoctor", () => {
    it("reports the row, and a sub-floor Node turns the exit code to 1", async () => {
        const report = await runDoctor({
            kubectl: () => ({ ok: false, stdout: "", stderr: "" }),
            probeImage: async () => "ok",
            nodeVersion: "22.12.0",
        });
        const row = report.checks.find((c) => c.id === "node-version");
        expect(row?.status).toBe("fail");
        expect(report.exitCode).toBe(1);
        const ok = await runDoctor({
            kubectl: () => ({ ok: false, stdout: "", stderr: "" }),
            probeImage: async () => "ok",
            nodeVersion: "24.14.0",
        });
        expect(ok.checks.find((c) => c.id === "node-version")?.status).toBe(
            "pass",
        );
    });
});

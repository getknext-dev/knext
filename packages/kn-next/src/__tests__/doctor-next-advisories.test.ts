/**
 * `knext doctor` -- FAIL on an installed Next.js with a known critical/high
 * advisory that has a published fix. The advisory table lives in
 * `next-advisories.ts`; every range here is copied from the GitHub advisory
 * database entry for the GHSA id, so the row names the same id the user will
 * find in `npm audit`.
 */
import { describe, expect, it } from "bun:test";
import { type KubectlFn, type ProbeOutcome, runDoctor } from "../cli/doctor";
import { nextAdvisoriesCheck } from "../cli/doctor/checks/next-advisories";
import type { CheckContext, DoctorDeps } from "../cli/doctor/types";
import {
    minorWithoutFixedRelease,
    NEXT_ADVISORIES,
    nextAdvisoriesFor,
} from "../next-advisories";

const noKubectl: KubectlFn = () => ({
    ok: false,
    stdout: "",
    stderr: "no stub",
});
const okProbe = async (): Promise<ProbeOutcome> => "ok";

const ctxFor = (installed: string | undefined): CheckContext => {
    const deps: DoctorDeps = {
        kubectl: noKubectl,
        probeImage: okProbe,
        readInstalledNext: () => installed,
    };
    return { deps, kubectl: noKubectl, skipAll: true, verbose: false };
};

const ids = (version: string): string[] =>
    nextAdvisoriesFor(version).map((a) => a.id);

const RCE_IMAGE = "GHSA-2464-fhr4-w9xw";
const RCE_USE_CACHE = "GHSA-673q-mjm6-r5xr";
const DOS_ACTIONS = "GHSA-p3m5-59mp-jv5r";

describe("next advisory table", () => {
    it("carries the three October advisories", () => {
        expect(NEXT_ADVISORIES.map((a) => a.id).sort()).toEqual(
            [DOS_ACTIONS, RCE_IMAGE, RCE_USE_CACHE].sort(),
        );
    });

    it("flags every 16.x up to and including 16.4.0 with all three", () => {
        for (const v of ["16.0.0", "16.2.11", "16.3.8", "16.4.0"]) {
            expect(ids(v).sort()).toEqual(
                [DOS_ACTIONS, RCE_IMAGE, RCE_USE_CACHE].sort(),
            );
        }
    });

    it("clears 16.4.1 and later", () => {
        for (const v of ["16.4.1", "16.4.3", "16.5.0"]) {
            expect(ids(v)).toEqual([]);
        }
    });

    it("flags 15.x below 15.5.28 with the two advisories that reach 15.x", () => {
        expect(ids("15.5.27").sort()).toEqual([DOS_ACTIONS, RCE_IMAGE].sort());
        expect(ids("15.0.0").sort()).toEqual([DOS_ACTIONS, RCE_IMAGE].sort());
    });

    it("clears the 15.x backport (15.5.28)", () => {
        expect(ids("15.5.28")).toEqual([]);
    });

    it("follows each advisory's own lower bound", () => {
        // GHSA-p3m5 starts at 13.0.0, GHSA-2464 at 10.0.0.
        expect(ids("12.3.4")).toEqual([RCE_IMAGE]);
        expect(ids("9.5.0")).toEqual([]);
    });

    it("knows which minors have no fixed release at all", () => {
        expect(minorWithoutFixedRelease("16.3").sort()).toEqual(
            [DOS_ACTIONS, RCE_IMAGE, RCE_USE_CACHE].sort(),
        );
        expect(minorWithoutFixedRelease("16.4")).toEqual([]);
        expect(minorWithoutFixedRelease("15.5")).toEqual([]);
        expect(minorWithoutFixedRelease("15.4").sort()).toEqual(
            [DOS_ACTIONS, RCE_IMAGE].sort(),
        );
        expect(minorWithoutFixedRelease("12.3")).toEqual([RCE_IMAGE]);
        expect(minorWithoutFixedRelease("16.5")).toEqual([]);
        expect(minorWithoutFixedRelease("nope")).toEqual([]);
    });

    it("returns nothing for a version it cannot parse", () => {
        expect(ids("canary")).toEqual([]);
    });
});

describe("doctor next-advisories row", () => {
    it("emits no row when next is not installed", () => {
        expect(nextAdvisoriesCheck(ctxFor(undefined))).toEqual([]);
    });

    it("emits no row when the dep is not injected", () => {
        const deps: DoctorDeps = { kubectl: noKubectl, probeImage: okProbe };
        expect(
            nextAdvisoriesCheck({
                deps,
                kubectl: noKubectl,
                skipAll: true,
                verbose: false,
            }),
        ).toEqual([]);
    });

    it("FAILs on 16.4.0, naming every advisory and the fixed version", () => {
        const [row] = nextAdvisoriesCheck(ctxFor("16.4.0"));
        expect(row?.id).toBe("next-advisories");
        expect(row?.status).toBe("fail");
        expect(row?.detail).toContain("16.4.0");
        expect(row?.detail).toContain(RCE_IMAGE);
        expect(row?.detail).toContain(RCE_USE_CACHE);
        expect(row?.detail).toContain(DOS_ACTIONS);
        expect(row?.hint).toContain("16.4.1");
    });

    it("FAILs on 16.3.8 (the previous scaffold pin)", () => {
        expect(nextAdvisoriesCheck(ctxFor("16.3.8"))[0]?.status).toBe("fail");
    });

    it("FAILs on 15.5.27 and points at the 15.x backport", () => {
        const [row] = nextAdvisoriesCheck(ctxFor("15.5.27"));
        expect(row?.status).toBe("fail");
        expect(row?.detail).toContain(RCE_IMAGE);
        expect(row?.detail).not.toContain(RCE_USE_CACHE);
        expect(row?.hint).toContain("15.5.28");
    });

    it("passes on 16.4.1, 16.4.3 and 15.5.28", () => {
        for (const v of ["16.4.1", "16.4.3", "15.5.28"]) {
            const [row] = nextAdvisoriesCheck(ctxFor(v));
            expect(row?.id).toBe("next-advisories");
            expect(row?.status).toBe("pass");
        }
    });

    it("warns, never passes, on a version it cannot compare", () => {
        expect(nextAdvisoriesCheck(ctxFor("canary"))[0]?.status).toBe("warn");
    });
});

describe("runDoctor wires the advisory row into the exit code", () => {
    // Cluster unreachable: every cluster row SKIPs, which never fails, so
    // the exit code is decided by the local rows alone.
    const depsFor = (installed: string): DoctorDeps => ({
        kubectl: noKubectl,
        probeImage: okProbe,
        readInstalledNext: () => installed,
    });

    it("exits 1 on a vulnerable next", async () => {
        const report = await runDoctor(depsFor("16.4.0"));
        const row = report.checks.find((c) => c.id === "next-advisories");
        expect(row?.status).toBe("fail");
        expect(report.exitCode).toBe(1);
    });

    it("does not fail on a fixed next", async () => {
        const report = await runDoctor(depsFor("16.4.3"));
        const row = report.checks.find((c) => c.id === "next-advisories");
        expect(row?.status).toBe("pass");
        expect(
            report.checks.filter(
                (c) => c.status === "fail" || c.status === "error",
            ),
        ).toEqual([]);
        expect(report.exitCode).toBe(0);
    });
});

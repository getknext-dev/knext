/**
 * `knext doctor` -- Next.js minor vs the credentialed list. The list is read
 * from `next-compat.ts`, the same module the peer range and the docs are
 * checked against, so there is one source of truth.
 */
import { describe, expect, it } from "bun:test";
import type { KubectlFn, ProbeOutcome } from "../cli/doctor";
import { nextMinorCheck } from "../cli/doctor/checks/next-minor";
import type { CheckContext, DoctorDeps } from "../cli/doctor/types";
import {
    minorWithoutFixedRelease,
    nextAdvisoriesFor,
} from "../next-advisories";
import { CREDENTIALED_NEXT_MINORS, NEXT_PEER_RANGE } from "../next-compat";

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

describe("doctor next-minor row", () => {
    it("emits no row when next is not installed", () => {
        expect(nextMinorCheck(ctxFor(undefined))).toEqual([]);
    });

    it("emits no row when the dep is not injected (golden reports stay unchanged)", () => {
        const deps: DoctorDeps = { kubectl: noKubectl, probeImage: okProbe };
        expect(
            nextMinorCheck({
                deps,
                kubectl: noKubectl,
                skipAll: true,
                verbose: false,
            }),
        ).toEqual([]);
    });

    it("passes a credentialed minor only when no advisory affects the version", () => {
        expect(CREDENTIALED_NEXT_MINORS.length).toBeGreaterThan(0);
        for (const minor of CREDENTIALED_NEXT_MINORS) {
            const v = `${minor}.2`;
            const [row] = nextMinorCheck(ctxFor(v));
            expect(row?.id).toBe("next-minor");
            expect(row?.status).toBe(
                nextAdvisoriesFor(v).length === 0 ? "pass" : "warn",
            );
        }
    });

    // #2594 round 2: never PASS what the next-advisories row FAILs. 16.4.0 is
    // on the credentialed minor AND affected by the October advisories.
    it("never PASSes a version next-advisories FAILs (16.4.0)", () => {
        const [row] = nextMinorCheck(ctxFor("16.4.0"));
        expect(row?.status).toBe("warn");
        expect(row?.detail).toContain("GHSA-2464-fhr4-w9xw");
        expect(row?.hint).toContain("16.4.1");
    });

    it("still passes the patched credentialed release (16.4.3)", () => {
        expect(nextMinorCheck(ctxFor("16.4.3"))[0]?.status).toBe("pass");
    });

    it("never recommends a credentialed minor that has no fixed release", () => {
        for (const v of ["canary", "16.5.0", "15.5.28"]) {
            const hint = nextMinorCheck(ctxFor(v))[0]?.hint ?? "";
            for (const minor of CREDENTIALED_NEXT_MINORS) {
                if (minorWithoutFixedRelease(minor).length > 0) {
                    expect(hint).not.toContain(`${minor}.x`);
                }
            }
        }
    });

    it("warns on an admitted but uncredentialed minor (policy wider than its credentialed list)", () => {
        // The shipped policy admits only credentialed minors, so widen the
        // range under test: 16.5 is inside it but not credentialed.
        const [row] = nextMinorCheck(ctxFor("16.5.0"), {
            range: ">=16.4.0 <16.6.0",
            minors: ["16.4"],
        });
        expect(row?.status).toBe("warn");
        expect(row?.detail).toContain("16.5.0");
        expect(row?.detail).toContain("not a credentialed minor");
        expect(row?.hint).toBeTruthy();
    });

    it("every minor the shipped range admits is credentialed (no silent uncredentialed minor)", () => {
        // 16.4.3, not 16.4.0: the floor release carries the October
        // advisories, so it WARNs on that ground (#2594) — this test is about
        // the minor, so it uses the minor's patched release.
        const [row] = nextMinorCheck(ctxFor("16.4.3"));
        expect(row?.status).toBe("pass");
    });

    it("warns, naming the declared range, on a version above it", () => {
        const [row] = nextMinorCheck(ctxFor("16.5.0"));
        expect(row?.status).toBe("warn");
        expect(row?.detail).toContain(NEXT_PEER_RANGE);
        expect(row?.detail).toContain("outside the range");
    });

    it("warns on a version below the floor", () => {
        expect(nextMinorCheck(ctxFor("15.5.0"))[0]?.status).toBe("warn");
        expect(nextMinorCheck(ctxFor("16.3.8"))[0]?.status).toBe("warn");
    });

    it("warns on an unparseable version rather than guessing", () => {
        expect(nextMinorCheck(ctxFor("canary"))[0]?.status).toBe("warn");
    });

    for (const range of ["^16.4.0", ">=16.4.0 <16.5.0 || >=17.0.0"]) {
        it(`fails safe: an unparseable range (${range}) warns as outside the range, never passes`, () => {
            const [row] = nextMinorCheck(ctxFor("16.4.0"), {
                range,
                minors: ["16.3"],
            });
            expect(row?.status).toBe("warn");
            expect(row?.detail).toContain("outside the range");
        });
    }
});

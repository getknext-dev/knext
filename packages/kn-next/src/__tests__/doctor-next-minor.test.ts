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
import {
    CREDENTIALED_NEXT_MINORS,
    NEXT_PEER_RANGE,
    SECURITY_FORCED_NEXT_MINORS,
} from "../next-compat";

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

    // #2594 round 2: the row must never PASS what next-advisories FAILs, and
    // its hint must never point at a minor with no release that fixes a
    // known advisory (on 1.x that is the credentialed 16.3 itself).
    it("never PASSes a version next-advisories FAILs (16.3.8)", () => {
        const [row] = nextMinorCheck(ctxFor("16.3.8"));
        expect(row?.status).toBe("warn");
        expect(row?.detail).toContain("GHSA-2464-fhr4-w9xw");
        expect(row?.hint).toContain("16.4.1");
    });

    for (const v of ["16.4.3", "15.5.28", "16.1.0", "canary", "16.5.0"]) {
        it(`never recommends a minor without a fixed release (${v})`, () => {
            const [row] = nextMinorCheck(ctxFor(v));
            for (const minor of [
                ...CREDENTIALED_NEXT_MINORS,
                ...SECURITY_FORCED_NEXT_MINORS.map((f) => f.minor),
            ]) {
                if (minorWithoutFixedRelease(minor).length > 0) {
                    expect(row?.hint ?? "").not.toContain(`${minor}.x`);
                    expect(row?.hint ?? "").not.toContain(`(${minor}`);
                }
            }
        });
    }

    it("on a security-forced minor, says why instead of telling the user to go back", () => {
        for (const forced of SECURITY_FORCED_NEXT_MINORS) {
            const [row] = nextMinorCheck(ctxFor(`${forced.minor}.3`));
            expect(row?.status).toBe("warn");
            for (const id of forced.advisories)
                expect(row?.detail).toContain(id);
            expect(row?.hint).toBeUndefined();
        }
    });

    it("warns on an admitted but uncredentialed minor (16.4.0)", () => {
        const [row] = nextMinorCheck(ctxFor("16.4.0"));
        expect(row?.status).toBe("warn");
        expect(row?.detail).toContain("16.4.0");
        expect(row?.detail).toContain(CREDENTIALED_NEXT_MINORS.join(", "));
        expect(row?.hint).toBeTruthy();
    });

    it("warns, naming the declared range, on a version above it", () => {
        const [row] = nextMinorCheck(ctxFor("16.5.0"));
        expect(row?.status).toBe("warn");
        expect(row?.detail).toContain(NEXT_PEER_RANGE);
        expect(row?.detail).toContain("outside the range");
    });

    it("warns on a version below the floor", () => {
        expect(nextMinorCheck(ctxFor("15.5.0"))[0]?.status).toBe("warn");
    });

    it("warns on an unparseable version rather than guessing", () => {
        expect(nextMinorCheck(ctxFor("canary"))[0]?.status).toBe("warn");
    });
});

/**
 * `knext doctor` -- Next.js minor vs the credentialed list. The list is read
 * from `next-compat.ts`, the same module the peer range and the docs are
 * checked against, so there is one source of truth.
 */
import { describe, expect, it } from "bun:test";
import type { KubectlFn, ProbeOutcome } from "../cli/doctor";
import { nextMinorCheck } from "../cli/doctor/checks/next-minor";
import type { CheckContext, DoctorDeps } from "../cli/doctor/types";
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

    it("passes on every credentialed minor", () => {
        expect(CREDENTIALED_NEXT_MINORS.length).toBeGreaterThan(0);
        for (const minor of CREDENTIALED_NEXT_MINORS) {
            const [row] = nextMinorCheck(ctxFor(`${minor}.2`));
            expect(row?.id).toBe("next-minor");
            expect(row?.status).toBe("pass");
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
        const [row] = nextMinorCheck(ctxFor("16.4.0"));
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
});

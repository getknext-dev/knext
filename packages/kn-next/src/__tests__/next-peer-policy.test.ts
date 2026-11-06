/**
 * The Next.js peer-range policy for the 1.x line: a bounded peer range
 * (only minors with compatibility evidence are admitted) plus a doctor
 * warning for admitted-but-uncredentialed minors. The manifests and the
 * scaffold pins are checked against `next-compat.ts`.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { NEXT_ADVISORIES, nextAdvisoriesFor } from "../next-advisories";
import {
    CREDENTIALED_NEXT_MINORS,
    NEXT_PEER_RANGE,
    SECURITY_FORCED_NEXT_MINORS,
} from "../next-compat";

const PKGS = resolve(import.meta.dirname, "../../..");
const read = (p: string) => readFileSync(p, "utf8");

describe("next peer policy", () => {
    it("the policy is a bounded range", () => {
        expect(NEXT_PEER_RANGE).toMatch(/^>=16\.\d+\.\d+ <\d+\.\d+\.\d+$/);
    });

    it("every publishable @getknext/* manifest that declares a next peer uses exactly the policy range", () => {
        let seen = 0;
        for (const dir of readdirSync(PKGS)) {
            let m: {
                name?: string;
                private?: boolean;
                peerDependencies?: Record<string, string>;
            };
            try {
                m = JSON.parse(read(join(PKGS, dir, "package.json")));
            } catch {
                continue;
            }
            if (m.private === true || !m.name?.startsWith("@getknext/"))
                continue;
            const peer = m.peerDependencies?.next;
            if (peer === undefined) continue;
            seen++;
            expect(peer, m.name).toBe(NEXT_PEER_RANGE);
        }
        expect(seen, "scan found the core manifest").toBeGreaterThanOrEqual(1);
    });

    it("scaffold templates pin an advisory-free next on a credentialed or security-forced minor", () => {
        const dir = join(PKGS, "kn-next/templates/app");
        const pins = readdirSync(dir)
            .filter((f) => f.startsWith("package.json"))
            .map((f) => read(join(dir, f)).match(/"next":\s*"([^"]+)"/)?.[1]);
        expect(pins.length).toBeGreaterThanOrEqual(1);
        const allowed = [
            ...CREDENTIALED_NEXT_MINORS,
            ...SECURITY_FORCED_NEXT_MINORS.map((f) => f.minor),
        ];
        for (const pin of pins) {
            expect(pin).toBeTruthy();
            const [maj, min] = (pin as string).split(".");
            expect(allowed).toContain(`${maj}.${min}`);
            // What users get never carries a known critical/high advisory.
            expect(nextAdvisoriesFor(pin as string)).toEqual([]);
        }
    });

    describe("a security-forced minor is genuinely forced", () => {
        // The exception is legitimate only while some advisory it names has no
        // fix on ANY credentialed minor: if a credentialed minor gets a patched
        // release, the scaffold goes back to it and this entry must be removed.
        it("names at least one advisory", () => {
            for (const forced of SECURITY_FORCED_NEXT_MINORS) {
                expect(forced.advisories.length).toBeGreaterThan(0);
            }
        });

        it("is not itself credentialed, and sits inside the peer range", () => {
            for (const forced of SECURITY_FORCED_NEXT_MINORS) {
                expect(CREDENTIALED_NEXT_MINORS).not.toContain(forced.minor);
                const [, hi] = /<16\.(\d+)\.0$/.exec(NEXT_PEER_RANGE) ?? [];
                expect(Number(forced.minor.split(".")[1])).toBeLessThan(
                    Number(hi),
                );
            }
        });

        it("every credentialed minor's fix for a named advisory lands on a later minor", () => {
            for (const forced of SECURITY_FORCED_NEXT_MINORS) {
                for (const id of forced.advisories) {
                    const advisory = NEXT_ADVISORIES.find((a) => a.id === id);
                    expect(
                        advisory,
                        `${id} is in the advisory table`,
                    ).toBeTruthy();
                    for (const minor of CREDENTIALED_NEXT_MINORS) {
                        // The newest patch of the credentialed minor is still
                        // inside the advisory's affected range ...
                        const range = advisory?.ranges.find(
                            (r) =>
                                cmpMinor(r.introduced, minor) <= 0 &&
                                cmpMinor(r.lastAffected, minor) >= 0,
                        );
                        expect(range, `${id} affects ${minor}`).toBeTruthy();
                        // ... and its fix is on the forced minor or later.
                        expect(
                            cmpMinor(range?.fixed as string, minor),
                        ).toBeGreaterThan(0);
                        expect(
                            cmpMinor(range?.fixed as string, forced.minor),
                        ).toBe(0);
                    }
                }
            }
        });
    });
});

/** Compare an `X.Y.Z` version's `X.Y` against a `X.Y` minor. */
function cmpMinor(version: string, minor: string): number {
    const [a, b] = version.split(".").map(Number);
    const [c, d] = minor.split(".").map(Number);
    return a !== c ? a - c : b - d;
}

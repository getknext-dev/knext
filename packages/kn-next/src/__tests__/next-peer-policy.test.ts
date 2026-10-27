/**
 * The Next.js peer-range policy for the 1.x line: a bounded peer range
 * (only minors with compatibility evidence are admitted) plus a doctor
 * warning for admitted-but-uncredentialed minors. The manifests and the
 * scaffold pins are checked against `next-compat.ts`.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { nextAdvisoriesFor } from "../next-advisories";
import { CREDENTIALED_NEXT_MINORS, NEXT_PEER_RANGE } from "../next-compat";

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

    it("scaffold templates pin an advisory-free next on a credentialed minor inside the range", () => {
        const dir = join(PKGS, "kn-next/templates/app");
        const pins = readdirSync(dir)
            .filter((f) => f.startsWith("package.json"))
            .map((f) => read(join(dir, f)).match(/"next":\s*"([^"]+)"/)?.[1]);
        expect(pins.length).toBeGreaterThanOrEqual(1);
        for (const pin of pins) {
            expect(pin).toBeTruthy();
            const [maj, min] = (pin as string).split(".");
            expect(CREDENTIALED_NEXT_MINORS).toContain(`${maj}.${min}`);
            // What users get never carries a known critical/high advisory
            // (#2594: 16.4.0 is inside the range and the credentialed minor,
            // and still vulnerable).
            expect(nextAdvisoriesFor(pin as string)).toEqual([]);
        }
    });
});

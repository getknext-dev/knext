/**
 * GUARD: every in-repo `next` pin satisfies the core peer floor (>=16.4.0).
 *
 * A scaffolded app pinned below the peer range fails `npm install` with
 * ERESOLVE, so a template drifting below the floor must be red here. The scan
 * walks every package.json / package.json*.hbs under the shipped and example
 * trees instead of listing them: a new app or template is covered the moment
 * it lands, and a pin that cannot be parsed fails rather than passes.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(__dirname, "..", "..", "..", "..");

const SCAN_ROOTS = [
    "packages",
    "apps",
    "examples",
    "spikes",
    "turbo/generators/templates",
];
const SKIP = new Set(["node_modules", ".next", "dist", ".git", ".turbo"]);

function walk(dir: string, out: string[]): void {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(e.name)) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (/^package\.json(\.[a-z]+)?(\.hbs)?$/.test(e.name)) {
            out.push(p);
        }
    }
}

const manifests: string[] = [];
for (const root of SCAN_ROOTS) {
    const abs = join(repoRoot, root);
    if (existsSync(abs)) walk(abs, manifests);
}

/**
 * The FLOOR of a range: the lowest version it can resolve to. A union
 * (`a || b`) is as low as its lowest arm. Anything whose floor cannot be read
 * (`*`, `latest`, `x`-ranges, an upper-bound-only `<`) is undefined and the
 * caller fails it -- an unreadable pin is never a pass.
 */
function lowest(range: string): [number, number, number] | undefined {
    let min: [number, number, number] | undefined;
    for (const arm of range.split("||")) {
        const m = arm
            .trim()
            .match(/^(?:>=|>|\^|~|=)?\s*v?(\d+)\.(\d+)\.(\d+)(?:\s|$)/);
        if (!m) return undefined;
        const v: [number, number, number] = [
            Number(m[1]),
            Number(m[2]),
            Number(m[3]),
        ];
        if (
            !min ||
            v[0] < min[0] ||
            (v[0] === min[0] &&
                (v[1] < min[1] || (v[1] === min[1] && v[2] < min[2])))
        ) {
            min = v;
        }
    }
    return min;
}

function belowFloor(v: [number, number, number]): boolean {
    return v[0] < 16 || (v[0] === 16 && v[1] < 4);
}

describe("every in-repo next pin satisfies the peer floor", () => {
    it("finds the manifests (an over-narrowed scan fails here)", () => {
        const rel = manifests.map((p) => p.slice(repoRoot.length + 1));
        expect(rel).toContain(
            "packages/kn-next/templates/app/package.json.hbs",
        );
        expect(rel).toContain(
            "packages/kn-next/templates/app/package.json.vinext.hbs",
        );
        expect(rel).toContain("apps/file-manager/package.json");
    });

    it("every concrete next pin is >=16.4.0 and parseable", () => {
        const bad: string[] = [];
        let seen = 0;
        for (const p of manifests) {
            const text = readFileSync(p, "utf8");
            let ranges: string[];
            if (p.endsWith(".hbs")) {
                // Templates are not JSON until rendered: scan the text.
                ranges = [...text.matchAll(/"next":\s*"([^"]*)"/g)].map(
                    (m) => m[1],
                );
            } else {
                const pkg = JSON.parse(text) as Record<string, unknown>;
                // Only manifests that consume knext are bound by its peer
                // range; an unrelated demo app pinning its own Next is not.
                const deps = [
                    "dependencies",
                    "devDependencies",
                    "optionalDependencies",
                    "peerDependencies",
                    "overrides",
                    "resolutions",
                ].map((k) => (pkg[k] ?? {}) as Record<string, string>);
                if (
                    !deps.some((d) =>
                        Object.keys(d).some((n) => n.startsWith("@getknext/")),
                    )
                )
                    continue;
                ranges = deps.flatMap((d) =>
                    typeof d.next === "string" ? [d.next] : [],
                );
            }
            for (const range of ranges) {
                seen++;
                const v = lowest(range);
                if (!v) {
                    bad.push(`${p}: unparseable next pin "${range}"`);
                } else if (belowFloor(v)) {
                    bad.push(`${p}: next "${range}" is below the peer floor`);
                }
            }
        }
        expect(seen).toBeGreaterThan(5);
        expect(bad).toEqual([]);
    });
});

describe("the range parser judges a range by its floor", () => {
    it("rejects every range whose minimum is below 16.4.0", () => {
        for (const r of [
            ">=16.0.0",
            "^16.3.8",
            "~16.3.0",
            "16.3.8",
            ">=15.0.0 || 16.4.0",
            "16.4.0 || ^16.1.0",
        ]) {
            const v = lowest(r);
            expect(v, r).toBeDefined();
            expect(belowFloor(v as [number, number, number]), r).toBe(true);
        }
    });
    it("accepts ranges whose minimum is at or above 16.4.0", () => {
        for (const r of [
            "16.4.0",
            "^16.4.0",
            ">=16.4.0",
            "~16.4.1",
            "^17.0.0",
            ">=16.4.0 || ^17.0.0",
        ]) {
            const v = lowest(r);
            expect(v, r).toBeDefined();
            expect(belowFloor(v as [number, number, number]), r).toBe(false);
        }
    });
    it("cannot read a floor from * / latest / x-ranges / upper bounds", () => {
        for (const r of ["*", "latest", "16.x", "<17.0.0", ""]) {
            expect(lowest(r), r).toBeUndefined();
        }
    });
});

describe("every workflow next pin satisfies the peer floor", () => {
    const wfDir = join(repoRoot, ".github", "workflows");
    const workflows = readdirSync(wfDir)
        .filter((f) => /\.ya?ml$/.test(f))
        .map((f) => ({ name: f, text: readFileSync(join(wfDir, f), "utf8") }));

    // Deliberately EXEMPT: these name the Next.js ref the compat credential
    // runs against (a git tag of vercel/next.js, moved only by the credential
    // re-ref), not the Next an app is installed with.
    const CREDENTIAL_REF_KEYS = ["NEXTJS_REF", "nextjsRef"];

    it("the exemption list is real: every exempt key occurs in a workflow", () => {
        for (const key of CREDENTIAL_REF_KEYS) {
            expect(
                workflows.some((w) => w.text.includes(key)),
                `${key} is exempt but no workflow uses it`,
            ).toBe(true);
        }
    });

    it("every NEXT_VERSION / dependencies.next literal is >=16.4.0 and parseable", () => {
        const bad: string[] = [];
        let seen = 0;
        for (const w of workflows) {
            const pins = [
                ...w.text.matchAll(/^\s*NEXT_VERSION:\s*['"]?([^'"\s#]+)/gm),
                ...w.text.matchAll(/dependencies\.next=([^"'\s$]+)/g),
            ].map((m) => m[1]);
            for (const range of pins) {
                seen++;
                const v = lowest(range);
                if (!v) bad.push(`${w.name}: unparseable next pin "${range}"`);
                else if (belowFloor(v))
                    bad.push(
                        `${w.name}: next "${range}" is below the peer floor`,
                    );
            }
        }
        expect(seen).toBeGreaterThanOrEqual(3);
        expect(bad).toEqual([]);
    });
});

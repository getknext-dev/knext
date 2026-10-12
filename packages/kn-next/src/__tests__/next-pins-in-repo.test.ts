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

/** The lowest version an exact / ^ / ~ pin can resolve to, else undefined. */
function lowest(range: string): [number, number, number] | undefined {
    const m = range.match(/^[\^~]?(\d+)\.(\d+)\.(\d+)$/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
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
                ranges = [...text.matchAll(/"next":\s*"([^"]*)"/g)]
                    .map((m) => m[1])
                    .filter((r) => !r.startsWith(">="));
            } else {
                const pkg = JSON.parse(text) as Record<string, unknown>;
                // Only manifests that consume knext are bound by its peer
                // range; an unrelated demo app pinning its own Next is not.
                const deps = ["dependencies", "devDependencies"].map(
                    (k) => (pkg[k] ?? {}) as Record<string, string>,
                );
                if (
                    !deps.some((d) =>
                        Object.keys(d).some((n) => n.startsWith("@getknext/")),
                    )
                )
                    continue;
                ranges = deps.flatMap((d) => (d.next ? [d.next] : []));
            }
            for (const range of ranges) {
                seen++;
                const v = lowest(range);
                if (!v) {
                    bad.push(`${p}: unparseable next pin "${range}"`);
                } else if (v[0] < 16 || (v[0] === 16 && v[1] < 4)) {
                    bad.push(`${p}: next "${range}" is below the peer floor`);
                }
            }
        }
        expect(seen).toBeGreaterThan(5);
        expect(bad).toEqual([]);
    });
});

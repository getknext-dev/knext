/**
 * #894 — the smoke's startup contract is PINNED to what the entries print.
 *
 * `runPostCompileSmoke` learns the child's ports by matching `STARTUP_LINE`
 * against its stdout. That makes the exact text of one `console.log` in the
 * scaffolded entry a load-bearing interface — and an invisible one: rename it to
 * `READY:` in a template and nothing fails, no type breaks, no test reds. Every
 * `kn-next build` for every app scaffolded afterwards just reports a boot
 * timeout, blaming the app for a change in knext's own template.
 *
 * So the two are pinned to each other here, the way this repo pins its other
 * template↔copy pairs: DISCOVER the entries by scanning (an enumerated list is
 * how the second one gets missed — there are two templates plus the reference
 * example and two app copies), render each one's startup `console.log` with
 * stand-in port numbers, and require the smoke's own regex to match it.
 *
 * Both halves, deliberately:
 *   - a template that stops printing the line (or renames it) reds this;
 *   - a regex that stops matching what the templates print reds it too.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { STARTUP_LINE } from "../cli/postcompile-smoke";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");

/** Directories with nothing to say about the runtime contract. */
const SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    ".next",
    ".output",
    "dist",
    "coverage",
    "coverage-bun",
    ".claude",
    ".turbo",
]);

/**
 * Every server entry in the repo, found by NAME rather than listed. A new zone
 * template or app copy is picked up the day it lands, which is the whole point:
 * the copies drift one at a time.
 */
function discoverEntries(dir: string, found: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        if (SKIP_DIRS.has(name)) continue;
        const full = join(dir, name);
        let isDir = false;
        try {
            isDir = statSync(full).isDirectory();
        } catch {
            continue; // a broken symlink is not an entry
        }
        if (isDir) {
            discoverEntries(full, found);
        } else if (/^knext-bun-entry\.mjs(\.hbs)?$/.test(name)) {
            found.push(relative(REPO_ROOT, full));
        }
    }
    return found;
}

/** The startup `console.log`'s template literal, or undefined if it is gone. */
function startupLiteral(source: string): string | undefined {
    const m = /console\.log\(`(LISTENING[^`]*)`\)/.exec(source);
    return m?.[1];
}

/** Render `${...}` holes as concrete ports, so the regex sees a real line. */
function render(literal: string): string {
    let n = 3000;
    return literal.replace(/\$\{[^}]*\}/g, () => String(n++));
}

const ENTRIES = discoverEntries(REPO_ROOT);

describe("#894 the smoke's STARTUP_LINE matches every entry that prints one", () => {
    it("finds the entries by scanning, including both templates", () => {
        // A FLOOR, never the complete set: a scan that discovers nothing reports
        // no violations and reads exactly like a clean tree.
        for (const known of [
            "packages/kn-next/templates/app/knext-bun-entry.mjs.hbs",
            "turbo/generators/templates/zone/knext-bun-entry.mjs.hbs",
            "examples/bun-exec/knext-bun-entry.mjs",
        ]) {
            expect(ENTRIES, `the scan missed ${known}`).toContain(known);
        }
    });

    it("every discovered entry still PRINTS the startup line", () => {
        const silent = ENTRIES.filter(
            (f) => !startupLiteral(readFileSync(join(REPO_ROOT, f), "utf8")),
        );
        // An entry that stops printing it makes the smoke report a boot timeout
        // for every app built from it — a failure that reads as the app's fault.
        expect(silent).toEqual([]);
    });

    it("and the smoke's regex matches what each one prints", () => {
        for (const file of ENTRIES) {
            const literal = startupLiteral(
                readFileSync(join(REPO_ROOT, file), "utf8"),
            );
            if (!literal) continue; // reported by the case above
            const line = render(literal);
            const m = STARTUP_LINE.exec(line);
            expect(
                m,
                `${file} prints "${line}", which STARTUP_LINE misses`,
            ).not.toBeNull();
            // Not merely "it matched": the smoke uses both captures as ports, so
            // a regex that matched while capturing the wrong halves would send
            // every probe to the wrong listener.
            expect(Number(m?.[1]), `${file}: app port capture`).toBe(3000);
            expect(Number(m?.[2]), `${file}: metrics port capture`).toBe(3001);
        }
    });

    it("the pin can FAIL — a renamed line does not match", () => {
        // Non-vacuity, in-line rather than by mutation: if STARTUP_LINE were
        // loosened to something that matches anything, the cases above would
        // pass on any template at all.
        expect(STARTUP_LINE.exec(render("READY:${a} SCRAPE:${b}"))).toBeNull();
        expect(STARTUP_LINE.exec("LISTENING:3000")).toBeNull();
    });
});

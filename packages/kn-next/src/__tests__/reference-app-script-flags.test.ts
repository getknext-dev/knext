/**
 * #1082 — a reference-app or template `package.json` script must never invoke a
 * `kn-next` verb with a flag that verb's parser has REMOVED.
 *
 * The concrete failure: `apps/file-manager/package.json` shipped
 * `"build:exec": "kn-next build --target=vinext"`, but ADR-0048 made vinext the
 * only target and DELETED the `--target` flag. `kn-next build` now hard-errors
 * on any unknown flag (`unknown flag "--target=vinext"`), so the very command a
 * developer copies from the reference app is dead on arrival. Nothing connected
 * "the flags a script passes" to "the flags the verb still accepts".
 *
 * This scans — never enumerates — every apps/-star/package.json and every
 * template package.json (and .hbs), finds each kn-next build invocation in a
 * script, and asserts every flag it passes is one the REAL build parser accepts
 * (ACCEPTED_BUILD_FLAGS, imported from the verb itself so the guard tracks the
 * parser rather than a copy of it). --target is the specific removed flag, so
 * it also gets its own named assertion.
 *
 * Written RED-first: with `build:exec` still `--target=vinext`, the scan reds on
 * the unknown flag.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ACCEPTED_BUILD_FLAGS } from "../cli/build";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..", "..");
const repoRoot = resolve(pkgRoot, "..", "..");

/** A script's `kn-next <verb>` invocation, with the flag tokens it passes. */
interface KnNextInvocation {
    source: string; // which package.json + script (for the failure message)
    verb: string;
    flags: string[]; // "--target=vinext" → normalised to "--target" below
}

/**
 * Pull every `kn-next <verb> ...` invocation out of a package.json's scripts.
 * A script value can chain commands (`&&`, `|`, `;`), so each segment is
 * inspected independently.
 */
function invocationsIn(
    sourceLabel: string,
    scripts: Record<string, string>,
): KnNextInvocation[] {
    const out: KnNextInvocation[] = [];
    for (const [name, command] of Object.entries(scripts)) {
        for (const segment of command.split(/&&|\|\||[|;]/)) {
            const tokens = segment.trim().split(/\s+/).filter(Boolean);
            const idx = tokens.indexOf("kn-next");
            if (idx === -1 || idx + 1 >= tokens.length) continue;
            const verb = tokens[idx + 1];
            const flags = tokens
                .slice(idx + 2)
                .filter((t) => t.startsWith("-"))
                // "--flag=value" → "--flag"; the parser keys on the flag name.
                .map((t) => t.split("=")[0]);
            out.push({ source: `${sourceLabel} › "${name}"`, verb, flags });
        }
    }
    return out;
}

/** Parse a package.json / .hbs — placeholders live inside JSON strings. */
function readScripts(path: string): Record<string, string> {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
        scripts?: Record<string, string>;
    };
    return parsed.scripts ?? {};
}

/** All reference-app + template package.json paths, discovered by scan. */
function manifestPaths(): { label: string; path: string }[] {
    const found: { label: string; path: string }[] = [];

    const appsDir = join(repoRoot, "apps");
    if (existsSync(appsDir)) {
        for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const path = join(appsDir, entry.name, "package.json");
            if (existsSync(path)) {
                found.push({ label: `apps/${entry.name}/package.json`, path });
            }
        }
    }

    const templatesDir = join(pkgRoot, "templates");
    if (existsSync(templatesDir)) {
        const walk = (dir: string) => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const full = join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(full);
                } else if (/^package\.json(\.hbs)?$/.test(entry.name)) {
                    found.push({
                        label: full.slice(repoRoot.length + 1),
                        path: full,
                    });
                }
            }
        };
        walk(templatesDir);
    }

    return found;
}

function allInvocations(): KnNextInvocation[] {
    return manifestPaths().flatMap(({ label, path }) =>
        invocationsIn(label, readScripts(path)),
    );
}

describe("reference-app + template scripts pass no removed kn-next flag (#1082)", () => {
    it("scans at least the file-manager reference app (the guard has a subject)", () => {
        // Both halves: if the scan finds nothing, every assertion below is
        // vacuously green — a decoration. Anchor on a manifest we know exists.
        const labels = manifestPaths().map((m) => m.label);
        expect(labels).toContain("apps/file-manager/package.json");
    });

    it("every `kn-next build` invocation uses only flags the build parser accepts", () => {
        const builds = allInvocations().filter((i) => i.verb === "build");
        for (const inv of builds) {
            for (const flag of inv.flags) {
                expect(
                    ACCEPTED_BUILD_FLAGS.has(flag),
                    `${inv.source} passes ${flag} to \`kn-next build\`, which the parser does not accept (see ACCEPTED_BUILD_FLAGS)`,
                ).toBe(true);
            }
        }
    });

    it("no script passes the removed --target flag to `kn-next build`", () => {
        // The specific ADR-0048 removal, named so a regression reads plainly.
        const offenders = allInvocations()
            .filter((i) => i.verb === "build")
            .filter((i) => i.flags.includes("--target"))
            .map((i) => i.source);
        expect(offenders).toEqual([]);
    });
});

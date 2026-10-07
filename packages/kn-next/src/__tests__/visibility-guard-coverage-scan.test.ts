/**
 * #1865 (review round 3) — "scan for ANY other `kubectl apply` of a NextApp
 * in `src/cli/` and guard it too. Use a scan test, not an enumerated list,
 * so a new apply path that skips the guard reds."
 *
 * `deploy.ts` and `preview.ts` are the two call sites known today. This test
 * does not enumerate them: it walks every `*.ts` under `src/cli/`
 * (recursively — same scope-by-construction fix `cr-apply-strict-
 * validation.test.ts` already applies, after #314 added a FOURTH apply site
 * one directory down from where "all of them live today" used to be true),
 * and flags any file that BOTH renders a NextApp CR (calls
 * `renderNextAppCR(`) AND issues a `kubectl apply` of it, but never
 * references the shared guard (`assertVisibilityDowngradeIsExplicit` /
 * `visibilityGuard`). A file that only PATCHES a NextApp with a narrow JSON
 * merge patch (`db-bind.ts`, `rollback.ts`) is correctly exempt: a merge
 * patch only touches the keys it names, so it structurally cannot clear
 * `spec.networking` the way a full `kubectl apply` can when the field is
 * omitted from the new manifest. A file that applies some OTHER resource
 * kind (`loadtest.ts`'s k6 Job) never calls `renderNextAppCR` and is exempt
 * for the same reason the apply-strict-validation guard's own scope note
 * explains.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = join(__dirname, "..", "cli");

/** Every `*.ts` under `src/cli/`, RECURSIVELY — scope by construction. */
function cliSources(): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (dir: string, prefix: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                walk(join(dir, entry.name), rel);
            } else if (entry.name.endsWith(".ts")) {
                out.set(rel, readFileSync(join(dir, entry.name), "utf8"));
            }
        }
    };
    walk(CLI_DIR, "");
    return out;
}

/** Blank out comments while preserving line numbers (mirrors the apply-strict-validation guard). */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
        .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Index of the string terminator starting at `start` (quote char at start). */
function skipString(s: string, start: number): number {
    const quote = s[start];
    for (let i = start + 1; i < s.length; i++) {
        if (s[i] === "\\") {
            i++;
            continue;
        }
        if (s[i] === quote) return i;
    }
    return s.length;
}

/** Index of the `]` matching the `[` at `start`, or -1. */
function matchBracket(s: string, start: number): number {
    let depth = 0;
    for (let i = start; i < s.length; i++) {
        const c = s[i];
        if (c === '"' || c === "'" || c === "`") {
            i = skipString(s, i);
            continue;
        }
        if (c === "[") depth++;
        else if (c === "]" && --depth === 0) return i;
    }
    return -1;
}

/**
 * Whether `src` contains a flat argv array literal that spawns `kubectl
 * apply` — same construct `cr-apply-strict-validation.test.ts`'s
 * `scanApplySites` parses, trimmed here to a boolean (this scan does not
 * need the flags, only whether an apply site exists at all).
 */
function hasKubectlApplySite(src: string): boolean {
    for (let i = 0; i < src.length; i++) {
        if (src[i] !== "[") continue;
        const end = matchBracket(src, i);
        if (end < 0) continue;
        const region = src.slice(i + 1, end);
        if (region.includes("[")) continue; // not a flat argv literal
        const args = [...region.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)].map(
            (m) => m[2] as string,
        );
        const isApplyArgv =
            (args[0] === "kubectl" && args[1] === "apply") ||
            (args[0] === "apply" &&
                /["'`]kubectl["'`]\s*,\s*$/.test(src.slice(0, i)));
        if (isApplyArgv) return true;
    }
    return false;
}

const RENDERS_NEXTAPP_CR = /\brenderNextAppCR\s*\(/;
const REFERENCES_GUARD =
    /\bassertVisibilityDowngradeIsExplicit\b|\bvisibilityGuard\b/;

/** Files that both render AND apply a NextApp CR — the scan's candidate set. */
function filesThatApplyARenderedNextAppCR(
    sources: Map<string, string>,
): string[] {
    const out: string[] = [];
    for (const [file, raw] of sources) {
        const src = stripComments(raw);
        if (RENDERS_NEXTAPP_CR.test(src) && hasKubectlApplySite(src)) {
            out.push(file);
        }
    }
    return out.sort();
}

describe("every kubectl apply of a rendered NextApp CR under src/cli/ is guarded (#1865)", () => {
    it("the scan actually finds real apply sites (anti-vacuity — must at least cover deploy.ts and preview.ts)", () => {
        const candidates = filesThatApplyARenderedNextAppCR(cliSources());
        expect(candidates).toContain("deploy.ts");
        expect(candidates).toContain("preview.ts");
    });

    it("every such file references the shared downgrade guard", () => {
        const sources = cliSources();
        const candidates = filesThatApplyARenderedNextAppCR(sources);
        const offenders = candidates.filter(
            (file) => !REFERENCES_GUARD.test(stripComments(sources.get(file)!)),
        );
        expect(
            offenders,
            `${offenders.join(", ")}: renders a NextApp CR and issues a kubectl apply ` +
                "of it, but never references assertVisibilityDowngradeIsExplicit / " +
                "visibilityGuard — a kubectl apply omits a field the previous apply set, " +
                "so without the guard this path can silently make a private app public. " +
                "Wire the shared guard from visibility-guard.ts in before the apply.",
        ).toEqual([]);
    });

    it("a file that only PATCHES a NextApp (db-bind.ts, rollback.ts) is correctly exempt", () => {
        const candidates = filesThatApplyARenderedNextAppCR(cliSources());
        expect(candidates).not.toContain("db-bind.ts");
        expect(candidates).not.toContain("rollback.ts");
    });

    it("a file that applies some OTHER resource kind (loadtest.ts's k6 Job) is correctly exempt", () => {
        const candidates = filesThatApplyARenderedNextAppCR(cliSources());
        expect(candidates).not.toContain("loadtest.ts");
    });
});

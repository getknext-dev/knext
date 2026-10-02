import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Domain-rename guard (#1832, integration/v1.3 half): knext's public site
 * moved from `knext.dev` to `knext-platform.dev` (2026-10-02 founder
 * correction — `knext.dev` is now a Cloudflare 403 page we do not own).
 * This asserts the bare literal `knext.dev` never reappears in the
 * CLI-facing surface of `@getknext/core` — help text, templates, error
 * messages, READMEs.
 *
 * Scope is deliberately narrow to the published packages fixed in this PR
 * (`packages/kn-next`, sibling guard in `packages/lib`) — docs/CI live in a
 * separate PR against `main` (#1824) because the two lines freeze bytes
 * differently. `packages/kn-next-operator` and `apps/file-manager` carry
 * only allowlisted K8s-label literals (see below) and are not re-scanned.
 *
 * ALLOWLIST: `apps.knext.dev/build-id` is a Kubernetes label KEY (API-group
 * style DNS prefix), not a web link — renaming the website domain must not
 * rename it, or it silently breaks the CRD-adjacent build-id contract. jev
 * confirmed this split (0.95 "yes, leave it unchanged") before this guard
 * was written.
 */

const PKG_ROOT = resolve(import.meta.dirname, "..", "..");

const ROOTS = ["README.md", "templates", "src"];

const ALLOWLISTED_LABEL_MARKERS = ["build-id"];

const SELF = relative(
    PKG_ROOT,
    resolve(import.meta.dirname, "knext-platform-dev-domain-guard.test.ts"),
);

function walk(path: string): string[] {
    const full = join(PKG_ROOT, path);
    let st: ReturnType<typeof statSync>;
    try {
        st = statSync(full);
    } catch {
        return [];
    }
    if (st.isFile()) return [path];
    if (!st.isDirectory()) return [];
    const out: string[] = [];
    for (const entry of readdirSync(full)) {
        if (entry === "node_modules" || entry === ".git") continue;
        out.push(...walk(join(path, entry)));
    }
    return out;
}

function findings(): string[] {
    const out: string[] = [];
    for (const root of ROOTS) {
        for (const file of walk(root)) {
            if (file === SELF) continue;
            let text: string;
            try {
                text = readFileSync(join(PKG_ROOT, file), "utf-8");
            } catch {
                continue;
            }
            const lines = text.split("\n");
            lines.forEach((line, i) => {
                if (!line.includes("knext.dev")) return;
                if (ALLOWLISTED_LABEL_MARKERS.some((m) => line.includes(m)))
                    return;
                out.push(`${file}:${i + 1}: ${line.trim()}`);
            });
        }
    }
    return out;
}

describe("domain-rename guard (knext.dev -> knext-platform.dev, @getknext/core)", () => {
    it("scans a non-empty file set", () => {
        const count = ROOTS.flatMap((r) => walk(r)).length;
        expect(count).toBeGreaterThan(20);
    });

    it("never re-introduces the bare knext.dev literal outside the K8s-label allowlist", () => {
        expect(findings()).toEqual([]);
    });
});

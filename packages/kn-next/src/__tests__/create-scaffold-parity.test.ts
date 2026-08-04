/**
 * #407 / ADR-0041 (amends ADR-0031) — DRIFT GUARD between the two scaffolding
 * paths.
 *
 * ADR-0031 put the guarded-instrumentation shape in ONE place: the in-repo
 * `turbo gen zone` template. #407 adds a second emitter (`kn-next create`, for
 * apps outside this monorepo), and two copies of a 200-line safety-critical
 * guard drift — silently, and in the direction that matters least visibly (the
 * published one, which nobody in this repo builds).
 *
 * So the copies are pinned rather than trusted:
 *
 *   - VERBATIM  — byte-identical between the two template trees. These files
 *     carry no layout assumption, so there is no reason for them to differ, and
 *     any edit to the turbo copy reddens until the CLI copy matches.
 *   - NORMALIZED — identical once the placeholder-bearing lines are dropped.
 *     `standalone-seam-alive.test.ts` differs ONLY in the standalone path (the
 *     app's layout) and the run instructions; its ~150 lines of chunk-scanning
 *     logic must not diverge. The placeholder lines it drops are asserted
 *     behaviourally in `create-scaffold.test.ts`.
 *   - LAYOUT — genuinely different by construction (workspace-protocol deps and
 *     the zone `basePath` cannot appear in an app generated into a user's repo).
 *     Listed WITH the reason, so "different" is a decision, not an accident.
 *
 * The classification is an ALLOWLIST and it FAILS CLOSED: every file in the
 * turbo zone template must appear in exactly one bucket, so a new template file
 * fails this test until someone decides which it is.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
// packages/kn-next/src/__tests__ → repo root
const REPO_ROOT = resolve(here, "../../../..");
const PKG_ROOT = resolve(here, "../..");
const ZONE_TEMPLATE = join(
    REPO_ROOT,
    "turbo",
    "generators",
    "templates",
    "zone",
);
const CLI_TEMPLATE = join(PKG_ROOT, "templates", "app");

/** Files that must be byte-identical in both template trees. */
const VERBATIM = [
    "next-adapter.ts.hbs",
    "instrumentation-edge-safe.test.ts.hbs",
    "src/instrumentation.ts.hbs",
    "src/instrumentation-node.ts.hbs",
] as const;

/** Files identical once placeholder-bearing lines are dropped. */
const NORMALIZED = ["standalone-seam-alive.test.ts.hbs"] as const;

/** Files that legitimately differ, each with the reason it does. */
const LAYOUT: Record<string, string> = {
    "package.json.hbs":
        "workspace:* deps + the monorepo start path cannot ship to a user's repo",
    "next.config.ts.hbs":
        "the zone template sets a multi-zone basePath; a CLI-created app has none",
    "kn-next.config.ts.hbs": "app name/registry/storage placeholders differ",
    "tsconfig.json.hbs": "the zone tsconfig is tuned for this workspace",
    "src/app/page.tsx.hbs": "the zone page is a workspace-UI demo",
    "src/app/layout.tsx.hbs":
        "the zone layout imports the private @getknext/ui",
};

/** Every `.hbs` under `dir`, as POSIX-ish relative paths, sorted. */
function templateFiles(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string) => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
            const full = join(d, entry.name);
            if (entry.isDirectory()) walk(full);
            else out.push(relative(dir, full).split(sep).join("/"));
        }
    };
    walk(dir);
    return out.sort();
}

/** Drop every line carrying a `{{ … }}` placeholder. */
function withoutPlaceholderLines(source: string): string {
    return source
        .split("\n")
        .filter((line) => !line.includes("{{"))
        .join("\n");
}

describe("kn-next create — the CLI ships its own template tree", () => {
    it("packages/kn-next/templates/app exists", () => {
        expect(
            existsSync(CLI_TEMPLATE),
            "packages/kn-next/templates/app is missing — `kn-next create` has nothing to emit",
        ).toBe(true);
    });

    it("every template file uses the .hbs extension (never collected by vitest/biome/tsc)", () => {
        // A template named `standalone-seam-alive.test.ts` inside the package
        // would be picked up by this repo's own vitest run and skip forever.
        const offenders = templateFiles(CLI_TEMPLATE).filter(
            (f) => !f.endsWith(".hbs"),
        );
        expect(offenders).toEqual([]);
    });

    it("the published package includes the templates (else `kn-next create` 404s post-install)", () => {
        const manifest = JSON.parse(
            readFileSync(join(PKG_ROOT, "package.json"), "utf8"),
        ) as { files?: string[] };
        expect(manifest.files ?? []).toContain("templates");
    });
});

describe("kn-next create — no drift from the turbo zone template (#356/#407)", () => {
    it("classifies EVERY zone template file (fails closed on a new one)", () => {
        const classified = new Set<string>([
            ...VERBATIM,
            ...NORMALIZED,
            ...Object.keys(LAYOUT),
        ]);
        const unclassified = templateFiles(ZONE_TEMPLATE).filter(
            (f) => !classified.has(f),
        );
        expect(
            unclassified,
            "new zone template file(s) — classify each as VERBATIM, NORMALIZED " +
                "or LAYOUT (with a reason) in create-scaffold-parity.test.ts",
        ).toEqual([]);
    });

    it.each(VERBATIM)("%s is byte-identical in both template trees", (rel) => {
        const zone = join(ZONE_TEMPLATE, rel);
        const cli = join(CLI_TEMPLATE, rel);
        expect(existsSync(cli), `${cli} missing`).toBe(true);
        expect(
            readFileSync(cli, "utf8"),
            `${rel} differs between the turbo zone template and the CLI template — ` +
                "the guarded-instrumentation shape must be ONE shape",
        ).toBe(readFileSync(zone, "utf8"));
    });

    it.each(
        NORMALIZED,
    )("%s is identical apart from its placeholder lines", (rel) => {
        const cli = join(CLI_TEMPLATE, rel);
        expect(existsSync(cli), `${cli} missing`).toBe(true);
        expect(
            withoutPlaceholderLines(readFileSync(cli, "utf8")),
            `${rel} logic drifted between the two scaffolders`,
        ).toBe(
            withoutPlaceholderLines(
                readFileSync(join(ZONE_TEMPLATE, rel), "utf8"),
            ),
        );
    });

    it.each([
        ...VERBATIM,
        ...NORMALIZED,
    ])("%s names BOTH scaffolders in its generated-by header", (rel) => {
        // A shared file that claims `turbo gen zone` generated it is a lie
        // in half the apps that carry it.
        const src = readFileSync(join(CLI_TEMPLATE, rel), "utf8");
        expect(src).toContain("turbo gen zone");
        expect(src).toContain("kn-next create");
    });
});

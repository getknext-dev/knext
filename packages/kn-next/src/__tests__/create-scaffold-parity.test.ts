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

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

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
    "cache-handler.js.hbs",
    "instrumentation-edge-safe.test.ts.hbs",
    "knext-bun-entry.mjs.hbs",
    "runtime-contract.mjs.hbs",
    // The shallow readiness/liveness route (#910). It carries no layout
    // assumption — the operator probes the SAME default path whichever
    // scaffolder emitted the app — so there is no version of this file that
    // may legitimately differ between the trees.
    "src/app/api/health/route.ts.hbs",
    "src/instrumentation.ts.hbs",
    "src/instrumentation-node.ts.hbs",
] as const;

/**
 * Files identical once placeholder-bearing lines are dropped.
 *
 * Empty since ADR-0048. It held `standalone-seam-alive.test.ts.hbs`, whose only
 * difference between the trees was the standalone path each layout produces.
 * There is no standalone path any more, so the file was DELETED rather than
 * un-compared — see SHAPE_FROZEN's note.
 */
const NORMALIZED = [] as const;

/** Files that legitimately differ, each with the reason it does. */
const LAYOUT: Record<string, string> = {
    "package.json.hbs":
        "workspace:* deps + the monorepo start path cannot ship to a user's repo",
    "next.config.ts.hbs":
        "the zone template sets a multi-zone basePath; a CLI-created app has none",
    "kn-next.config.ts.hbs": "app name/registry/storage placeholders differ",
    "vite.config.ts.hbs":
        "same plugin stack, but the zone variant carries the multi-zone basePath wiring",
    "tsconfig.json.hbs": "the zone tsconfig is tuned for this workspace",
    "src/app/page.tsx.hbs": "the zone page is a workspace-UI demo",
    "src/app/layout.tsx.hbs":
        "the zone layout imports the private @getknext/ui",
};

/**
 * Files that exist ONLY in the CLI tree, each with the reason. The zone app is
 * built and imaged by this monorepo's own pipeline, so it needs neither.
 */
const CLI_ONLY: Record<string, string> = {
    "Dockerfile.hbs":
        "the zone app is built by this repo's pipeline; a created app needs its own image recipe",
    ".dockerignore.hbs":
        "paired with Dockerfile.hbs — it bounds THAT image recipe's build context, so it is CLI-only for the same reason",
    "public/.gitkeep.hbs":
        "keeps the generated Dockerfile's `COPY … public` layer resolvable before the app has assets",
};

/**
 * The SAFETY-CRITICAL files: the #342 fence pair, the adapter wiring, and the
 * two graduated guards. **Their bucket is frozen.**
 *
 * Without this, the whole parity guard is one line from being switched off:
 * move `standalone-seam-alive.test.ts.hbs` from NORMALIZED to LAYOUT with any
 * string as the "reason", and the CLI copy is compared against NOTHING — you
 * can then gut its `SEAM_SYMBOLS` and every suite stays green. That is the
 * "editing the guard is the routine way to get green" failure this repo has
 * already been bitten by, so the membership is asserted, not assumed.
 *
 * Moving one of these into LAYOUT is not a refactor: it is a decision to stop
 * comparing a file whose whole purpose is to be compared.
 */
const SHAPE_FROZEN = [
    "instrumentation-edge-safe.test.ts.hbs",
    "knext-bun-entry.mjs.hbs",
    "runtime-contract.mjs.hbs",
    // #910: a scaffolded app whose readiness AND liveness probes both 404 never
    // becomes Ready and then restart-loops. Dropping this file out of the
    // compared buckets would stop comparing the one route Kubernetes calls.
    "src/app/api/health/route.ts.hbs",
    "src/instrumentation.ts.hbs",
    "src/instrumentation-node.ts.hbs",
] as const;

/*
 * ADR-0048 changed WHICH files are safety-critical, and the change is recorded
 * rather than made quietly, because this list exists to make quiet changes
 * impossible.
 *
 * REMOVED — both DELETED from both trees, not moved to LAYOUT:
 *   `next-adapter.ts.hbs`            the official-adapter hooks are a
 *                                    webpack/turbopack mechanism. vinext is
 *                                    Vite/rolldown and never calls them, so the
 *                                    file would be inert in a scaffolded app.
 *   `standalone-seam-alive.test.ts.hbs`
 *                                    guarded module state across webpack layers
 *                                    in the Next standalone bundle. vinext emits
 *                                    no standalone tree and no layers.
 *
 * ADDED — these now carry what those protected:
 *   `knext-bun-entry.mjs.hbs`        re-provides the RuntimeContract (health,
 *   `runtime-contract.mjs.hbs`       :9464 metrics, SIGTERM drain) that vinext
 *                                    cannot get from adapter hooks. If these
 *                                    drift between the trees, one scaffolder
 *                                    emits an app that fails its probes.
 *
 * `vite.config.ts.hbs` is deliberately NOT frozen: it is in LAYOUT because the
 * zone and CLI variants legitimately differ, and its one load-bearing line
 * (`inlineDynamicImports`) is asserted directly in create-scaffold.test.ts.
 */

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

    it("classifies EVERY CLI template file too (the published tree is the one that drifts unnoticed)", () => {
        // Enumerating only the ZONE side left the published tree unguarded —
        // exactly the tree this file's own docblock calls "the copy that drifts
        // unnoticed, which nobody in this repo builds". A new file added there
        // would ship to every created app, unclassified and uncompared.
        const classified = new Set<string>([
            ...VERBATIM,
            ...NORMALIZED,
            ...Object.keys(LAYOUT),
            ...Object.keys(CLI_ONLY),
        ]);
        const unclassified = templateFiles(CLI_TEMPLATE).filter(
            (f) => !classified.has(f),
        );
        expect(
            unclassified,
            "new CLI template file(s) — classify each as VERBATIM, NORMALIZED, " +
                "LAYOUT or CLI_ONLY (with a reason) in create-scaffold-parity.test.ts",
        ).toEqual([]);
    });

    it.each([
        ...SHAPE_FROZEN,
    ])("%s stays in VERBATIM/NORMALIZED — its bucket is frozen", (rel) => {
        const compared = new Set<string>([...VERBATIM, ...NORMALIZED]);
        expect(
            compared.has(rel),
            `${rel} was moved out of the compared buckets. That is not a ` +
                "refactor — it stops comparing a safety-critical file against " +
                "the other tree. Re-classify it back, or delete it from " +
                "SHAPE_FROZEN only with a decision recorded in an ADR.",
        ).toBe(true);
        expect(
            Object.hasOwn(LAYOUT, rel),
            `${rel} must never be LAYOUT-bucketed (LAYOUT means "compared on nothing")`,
        ).toBe(false);
    });

    it.each([
        ...VERBATIM,
    ])("%s is byte-identical in both template trees", (rel) => {
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

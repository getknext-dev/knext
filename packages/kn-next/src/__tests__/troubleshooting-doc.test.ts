/**
 * Accuracy guard for docs/runbooks/troubleshooting.md (#313).
 *
 * A troubleshooting guide is only useful if every symptom → cause → fix it
 * lists is GROUNDED in the real platform. This test enforces that:
 *
 *   1. The guide exists and catalogs the top ~10 failure modes (one `##`
 *      section each).
 *   2. Every ground-truth token the guide cites — operator Event reasons,
 *      status Condition types, the exact `:latest` rejection phrasing, the
 *      alert names, the `kn-next doctor` command, ADR references — is present
 *      BOTH in the guide AND in the source of truth it claims to quote. If the
 *      code renames a reason/alert/condition, this test goes red so the doc
 *      cannot silently drift into fiction (CLAUDE.md rule 2b: doc drift = defect).
 *
 * The guide is a docs-only deliverable, so this is the test-first artifact: it
 * fails until the guide is authored and stays green only while it stays honest.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// packages/kn-next/src/__tests__ -> repo root is four levels up.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const DOC_PATH = join(REPO_ROOT, "docs", "runbooks", "troubleshooting.md");

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf-8");
const doc = () => readFileSync(DOC_PATH, "utf-8");

/**
 * Each entry: a token the guide cites, and the source file that must also
 * contain it (the guide's claimed source of truth). Both sides are asserted so
 * neither the doc nor the code can drift alone.
 */
const GROUNDED_TOKENS: Array<{ token: string; source: string }> = [
    // Operator Event reasons + Condition types (nextapp_controller.go).
    {
        token: "InvalidImage",
        source: "packages/kn-next-operator/internal/controller/nextapp_controller.go",
    },
    {
        token: "ReconcileFailed",
        source: "packages/kn-next-operator/internal/controller/nextapp_controller.go",
    },
    {
        token: "IngressNotProgrammed",
        source: "packages/kn-next-operator/internal/controller/nextapp_controller.go",
    },
    {
        token: "PinnedRevisionNotFound",
        source: "packages/kn-next-operator/internal/controller/nextapp_controller.go",
    },
    {
        token: "EnvVarIgnored",
        source: "packages/kn-next-operator/internal/controller/nextapp_controller.go",
    },
    {
        token: "Degraded",
        source: "packages/kn-next-operator/internal/controller/nextapp_controller.go",
    },
    // The exact :latest rejection wording, from the single validation source.
    {
        token: ":latest tag which is forbidden",
        source: "packages/kn-next-operator/internal/validation/validate.go",
    },
    {
        token: "@sha256:",
        source: "packages/kn-next-operator/internal/validation/validate.go",
    },
    // Alert names — the observability contract the guide links each mode to.
    {
        token: "KnextColdStartLatencyHigh",
        source: "docs/observability/slos.md",
    },
    { token: "KnextCacheUnreachable", source: "docs/observability/slos.md" },
    {
        token: "KnextOperatorReconcileErrors",
        source: "docs/observability/slos.md",
    },
    { token: "KnextNextAppDegraded", source: "docs/observability/slos.md" },
    // The diagnostic command really exists (audited, not invented).
    {
        token: "kn-next doctor",
        source: "packages/kn-next/src/cli/doctor.ts",
    },
    // DB binding failure mode is grounded in ADR-0019.
    {
        token: "ADR-0019",
        source: "docs/adr/0019-database-binding-secretref.md",
    },
    // The webhook fail-closed behaviour the guide warns about.
    {
        token: "failurePolicy: Fail",
        source: "packages/kn-next-operator/config/webhook/manifests.yaml",
    },
];

describe("docs/runbooks/troubleshooting.md (#313)", () => {
    it("exists and is a symptom/cause/fix playbook", () => {
        const md = doc();
        expect(md).toMatch(/symptom/i);
        expect(md).toMatch(/cause/i);
        expect(md).toMatch(/fix/i);
    });

    it("catalogs at least 10 failure modes (## sections)", () => {
        const sections = doc()
            .split("\n")
            .filter(
                (l) => /^##\s+/.test(l) && !/^##\s+(quick|contents)/i.test(l),
            );
        expect(sections.length).toBeGreaterThanOrEqual(10);
    });

    it("documents the audited `kn-next doctor` diagnostic", () => {
        expect(doc()).toContain("kn-next doctor");
    });

    it.each(GROUNDED_TOKENS)("grounds %s in its cited source", ({
        token,
        source,
    }) => {
        expect(doc(), `guide must cite "${token}"`).toContain(token);
        expect(
            read(source),
            `source ${source} must actually contain "${token}"`,
        ).toContain(token);
    });
});

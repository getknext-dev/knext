/**
 * #869 — keep ADR-0036 and ADR-0042's state-correction blocks true.
 *
 * Both ADRs described a `build` × `runtime` matrix that was designed and never
 * built, and four of their load-bearing statements were false against `main`.
 * That is not a cosmetic problem: two readings came straight from Accepted ADRs
 * and both were wrong, sending work at things either unnecessary or already
 * done. `CLAUDE.md` §9 exists for exactly this failure mode and says the remedy
 * plainly — fix, don't propagate.
 *
 * The corrections are prose, and prose decays silently. So the facts they
 * assert are pinned here, and each is pinned in BOTH directions — the guard
 * reds if the claim stops being true, which is the signal that the ADR text
 * needs updating, not that the guard needs editing.
 *
 * ## What is NOT tractable, measured rather than asserted
 *
 * The issue asked for something more general: a test that any ADR claiming a
 * config key or CRD field exists can be checked against the actual schema.
 * That is not tractable, for the same reason the half-a-scan lint in #639 was
 * not. A state claim in an ADR is a sentence, and the sentence's TENSE is the
 * whole content — `docs/adr/` contains, across the accepted set, backticked
 * identifiers inside specifications ("we will add `build`"), inside rejected
 * options, inside close-outs recording what was removed, and inside quoted
 * upstream API surface that is not knext's at all. A scanner keyed on
 * backticked identifiers cannot separate those from live claims, and one that
 * cries wolf gets skimmed past — which is strictly worse than no scanner,
 * because it looks like coverage.
 *
 * What IS tractable is the narrow form below: the specific facts the two
 * correction blocks assert. It does not generalise, and pretending otherwise
 * would be the same overclaim the corrections exist to fix.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(resolve(repoRoot, rel), 'utf8');

const CRD_YAML = 'packages/kn-next-operator/config/crd/bases/apps.kn-next.dev_nextapps.yaml';
const TYPES = 'packages/kn-next-operator/api/v1alpha1/nextapp_types.go';
const CONFIG = 'packages/kn-next/src/config.ts';
const ADR36 = 'docs/adr/0036-optional-vinext-bun-build-target.md';
const ADR42 = 'docs/adr/0042-vinext-bun-bytecode-as-the-default-runtime.md';

describe('ADR-0036 / ADR-0042 state corrections stay true (#869)', () => {
  it('no CEL rule pairs build against runtime — the abandoned `bun ⇒ vinext` admission', () => {
    // ADR-0036 specified this rule as "enforced fail-closed by CEL admission
    // on the CRD". It was never implemented, and `nextapp_types.go` records
    // why it is now deliberately abandoned: encoding compatibility here pins
    // a policy into every cluster's CRD, where changing it later needs a CRD
    // roll rather than a CLI release.
    //
    // Scanned, not enumerated: any CEL rule mentioning either field name is
    // caught, so implementing the rule under a different shape still reds.
    const rules = read(CRD_YAML)
      .split('\n')
      .filter((l) => l.trim().startsWith('rule:'));
    expect(rules.length).toBeGreaterThan(0); // the scan can see rules at all
    const crossField = rules.filter((r) =>
      /\bself\.(build|runtime)\b|['"](build|runtime)['"]/.test(r),
    );
    expect(crossField).toEqual([]);
  });

  it('the build axis exists on BOTH the CLI config and the CRD', () => {
    // False when the ADRs were written; true since ADR-0048. The correction
    // says so, and this is what keeps that half honest.
    expect(read(CONFIG)).toMatch(/build\?:\s*"turbopack"\s*\|\s*"vinext"/);
    expect(read(TYPES)).toMatch(/Build string `json:"build,omitempty"`/);
  });

  it('the CRD enum admits BOTH builders — the CLI/CRD gap is closed, in one change', () => {
    // This guard used to pin the opposite: enum=turbopack only, with the gap
    // deliberate. ADR-0048 Amendment 3 closed it (2026-09-03) — and the
    // types.go comment demanded the closure happen "in the same change" as
    // the operator learning the shape, so BOTH halves are pinned here: the
    // enum admits vinext, and the controller's command branch knows the
    // single-exec shape. Widening the enum while reverting the controller
    // (or vice versa) is the regression this now catches.
    const types = read(TYPES);
    const lines = types.split('\n');
    const enumLine = lines.find(
      (l, i) => l.includes('kubebuilder:validation:Enum') && lines[i + 1]?.includes('Build string'),
    );
    expect(enumLine).toBeDefined();
    expect(enumLine).toContain('Enum=turbopack;vinext');

    // The generated CRD carries the same enum — types.go alone is not what
    // the apiserver enforces.
    expect(read(CRD_YAML)).toMatch(/enum:\n\s+- turbopack\n\s+- vinext/);

    // The other half of the "same change" contract: the controller must gate
    // the standalone command away from the vinext shape.
    const controller = read('packages/kn-next-operator/internal/controller/nextapp_controller.go');
    expect(controller).toMatch(/Spec\.Build != "vinext" && nextApp\.Spec\.Runtime == "bun"/);
  });

  it('both ADRs carry a dated state-correction block', () => {
    // The blocks themselves — deleting one would leave the false claims
    // reading as current, which is the whole defect.
    expect(read(ADR36)).toContain('State correction (2026-08-30)');
    expect(read(ADR42)).toContain('State correction (2026-08-30)');
  });

  it("ADR-0036's correction sits ABOVE the specification it corrects", () => {
    // A correction below the table it corrects is a footnote, and a reader
    // who stops at the table never reaches it. Two readers already took
    // that table as description; placement is the mitigation.
    const adr = read(ADR36);
    expect(adr.indexOf('State correction (2026-08-30)')).toBeLessThan(
      adr.indexOf('**Valid combinations (3)'),
    );
  });
});

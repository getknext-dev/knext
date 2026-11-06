import { describe, expect, it } from 'bun:test';
import {
  auditImageLanes,
  auditOperatorTags,
  auditTemplateImages,
  type Ctx,
  discoverImageLanes,
  evalExpr,
  type Finding,
  jobsOf,
  loadWorkflows,
  operatorTagWorkflows,
  templateDirs,
  UNKNOWN,
  type Workflow,
} from './helpers/image-supply-chain';

/**
 * SUPPLY-CHAIN GUARD, image half (#2044, v2 task R8).
 *
 * `security.md`: SBOM per image, Trivy fail on HIGH/CRITICAL, cosign signing.
 * The npm half (every publish lane `needs` the audit + SBOM job; `@getknext/grpc`
 * enters the audit/SBOM scope the moment it loses `private`) is
 * `tests/publish-lane-supply-chain.test.ts`. This file covers images:
 *   - every workflow job that PUBLISHES an image, discovered by what it does
 *     (build-push-action with push, `docker push`, `crane push`, `--push`, ...)
 *     under ANY trigger, local composite actions expanded, reusable workflows
 *     resolved: an enforcing HIGH+CRITICAL Trivy gate, an SBOM, and cosign;
 *   - function template images (`templates/*`): SBOM and cosign.
 * Gate steps that cannot fail or run (continue-on-error, a disabling `if`) do
 * not count. An unreadable or unresolvable construct is a finding or a throw.
 *
 * KNOWN_GAPS is the one explicit, named exception list. The engine reds on a
 * gap that is not listed AND on a listed gap that no longer exists (stale).
 *
 * Mutation-proved by `scripts/mutation-prove-2044-image-supply-chain.mjs`.
 */

interface KnownGap {
  subject: string;
  check: string;
  reason: string;
}

const KNOWN_GAPS: readonly KnownGap[] = [
  {
    subject: 'template:go',
    check: 'cosign',
    reason:
      'TODO(#2044), tracked in #2425: go-template.yml builds, SBOMs and Trivy-scans the image but never publishes or signs it; its header defers GHCR push + cosign to a separate push-only workflow (Z4 follow-up)',
  },
  {
    subject: 'template:rust',
    check: 'cosign',
    reason:
      'TODO(#2044), tracked in #2425: rust-template.yml has the same deferral (Z5 follow-up): SBOM and Trivy, no push, no cosign',
  },
];

const key = (f: { subject: string; check: string }) => `${f.subject}|${f.check}`;

/** Findings not excused by KNOWN_GAPS, plus listed gaps that no longer exist. */
function judge(findings: Finding[], gaps: readonly KnownGap[]): string[] {
  const listed = new Set(gaps.map(key));
  const present = new Set(findings.map(key));
  return [
    ...findings
      .filter((f) => !listed.has(key(f)))
      .map((f) => `${f.subject}: ${f.check}: ${f.detail}`),
    ...gaps.filter((g) => !present.has(key(g))).map((g) => `STALE known gap ${key(g)}`),
  ];
}

const wfs = loadWorkflows();
const templates = templateDirs();
const clone = <T>(x: T): T => structuredClone(x);
const real = {};

function wfNamed(file: string, list: Workflow[] = wfs): Workflow {
  const w = list.find((x) => x.file === file);
  if (!w) throw new Error(`${file} not found`);
  return w;
}
// biome-ignore lint/suspicious/noExplicitAny: fixture editing of parsed YAML
const withWf = (file: string, edit: (doc: any) => void): Workflow[] => {
  const copy = clone(wfs);
  edit(wfNamed(file, copy).doc);
  return copy;
};
const checks = (f: Finding[]) => f.map((x) => x.check);

// ───────────────────────── real tree ─────────────────────────

describe('image publish lanes: the real workflows', () => {
  const { lanes, findings } = discoverImageLanes(wfs);
  const names = lanes.map((l) => `${l.wf.file}#${l.id}`);

  it('discovers lanes by behaviour: the operator AND the app image (supply-chain.yml)', () => {
    expect(names).toEqual(
      expect.arrayContaining([
        'operator-supply-chain.yml#operator-image-publish',
        'supply-chain.yml#image-publish',
      ]),
    );
    expect(findings).toEqual([]);
  });

  it('every publish lane has enforcing Trivy, SBOM and cosign, tied to the image', () => {
    expect(auditImageLanes(wfs, real)).toEqual([]);
  });

  it('is not vacuous: the ref-gated continue-on-error expressions in the real lanes are exercised and accepted', () => {
    const trivyCoe = (file: string) =>
      Object.values(jobsOf(wfNamed(file)))
        .flatMap((j) => (j.steps as Array<Record<string, unknown>>) ?? [])
        .filter((s) => /trivy-action/.test(String(s.uses ?? '')))
        .map((s) => s['continue-on-error'])
        .filter((v) => typeof v === 'string');
    expect(trivyCoe('supply-chain.yml').length).toBeGreaterThan(0);
    expect(trivyCoe('operator-supply-chain.yml').length).toBeGreaterThan(0);
  });

  it('operator-e2e-nightly crane copy goes to the LOCAL registry: not a lane, with no allowlist', () => {
    const wf = wfNamed('operator-e2e-nightly.yml');
    const step = (jobsOf(wf)['scale-to-zero-cache'].steps as Array<Record<string, unknown>>).find(
      (x) => /crane copy "\$\{RESOLVED_IMAGE\}"/.test(String(x.run ?? '')),
    ) as Record<string, unknown>;
    // The destination variable is assigned a localhost registry in the same step.
    expect(String(step.run)).toMatch(/local_ref="localhost:5001\//);
    expect(names).not.toContain('operator-e2e-nightly.yml#scale-to-zero-cache');
  });

  it('a GHCR push added to that job makes it a lane that reds', () => {
    const m = withWf('operator-e2e-nightly.yml', (d) => {
      d.jobs['scale-to-zero-cache'].steps.push({ run: 'crane push layout ghcr.io/x/y:1' });
    });
    expect(auditImageLanes(m).map((f) => f.subject)).toContain(
      'operator-e2e-nightly.yml#scale-to-zero-cache',
    );
  });
});

describe('operator tags: trigger shape', () => {
  const OP = 'operator-supply-chain.yml';
  it('discovers the operator tag workflow by its trigger', () => {
    expect(operatorTagWorkflows(wfs).map((w) => w.file)).toContain(OP);
  });
  it('the real tag trigger fires from any branch and the lane publishes on the tag', () => {
    expect(auditOperatorTags(wfs)).toEqual([]);
  });
  it('a path filter on the push trigger reds', () => {
    const m = withWf(OP, (d) => {
      d.on.push.paths = ['packages/kn-next-operator/**'];
    });
    expect(checks(auditOperatorTags(m))).toContain('any-branch');
  });
  it('a push job confined to main (tag from another branch unpublished) reds', () => {
    const m = withWf(OP, (d) => {
      d.jobs['operator-image-publish'].if = "github.ref == 'refs/heads/main'";
    });
    expect(checks(auditOperatorTags(m))).toContain('any-branch');
  });
  it('an operator-v* workflow with no push step reds', () => {
    const m = withWf(OP, (d) => {
      for (const j of Object.values<{ steps?: unknown[] }>(d.jobs))
        j.steps = (j.steps ?? []).filter(
          (s) => !/crane\s+(push|tag)/.test(String((s as { run?: string }).run)),
        );
    });
    expect(checks(auditOperatorTags(m))).toContain('no-publish');
  });
  it('no operator tag lane at all reds (a vacuous scan fails)', () => {
    expect(checks(auditOperatorTags(wfs.filter((w) => w.file !== OP)))).toContain('discovered');
  });
  it('an unreadable workflow directory fails closed (throws)', () => {
    expect(() => loadWorkflows(`${import.meta.dirname}/helpers`)).toThrow();
  });
});

describe('operator and app lanes: removing a gate from the REAL workflows reds', () => {
  // biome-ignore lint/suspicious/noExplicitAny: fixture editing of parsed YAML
  const dropSteps = (file: string, match: (s: any) => boolean) =>
    withWf(file, (d) => {
      for (const j of Object.values<{ steps?: unknown[] }>(d.jobs))
        j.steps = (j.steps ?? []).filter((s) => !match(s));
    });
  for (const file of ['operator-supply-chain.yml', 'supply-chain.yml']) {
    it(`${file}: no Trivy step`, () => {
      const m = dropSteps(file, (s) => /trivy-action/.test(s.uses ?? ''));
      expect(checks(auditImageLanes(m, real))).toContain('trivy');
    });
    it(`${file}: no SBOM step`, () => {
      const m = dropSteps(
        file,
        (s) =>
          /sbom-action/.test(s.uses ?? '') || /\b(syft|cyclonedx-npm)\b/.test(String(s.run ?? '')),
      );
      expect(checks(auditImageLanes(m, real))).toContain('sbom');
    });
    it(`${file}: no cosign step`, () => {
      const m = dropSteps(file, (s) => /\bcosign\s+(sign|attest)\b/.test(s.run ?? ''));
      expect(checks(auditImageLanes(m, real))).toContain('cosign');
    });
  }
  it('operator: the push job stops waiting for the scan job', () => {
    const m = withWf('operator-supply-chain.yml', (d) => {
      d.jobs['operator-image-publish'].needs = [];
    });
    expect(checks(auditImageLanes(m, real))).toContain('trivy');
  });
});

// ───────────────────────── fixtures: lane engine ─────────────────────────

type Any = Record<string, unknown>;
const noVars = () => ({});
const trivyStep = (extra: Any = {}, withExtra: Any = {}): Any => ({
  uses: 'aquasecurity/trivy-action@abc',
  with: { input: 'oci', severity: 'HIGH,CRITICAL', 'exit-code': '1', ...withExtra },
  ...extra,
});
const sbomStep = (extra: Any = {}): Any => ({ uses: 'anchore/sbom-action@abc', ...extra });
const pushStep = (extra: Any = {}): Any => ({ run: 'crane push oci "$IMG:1"', ...extra });
const signStep = (extra: Any = {}): Any => ({ run: 'cosign sign --yes "$IMG@$DIGEST"', ...extra });

interface LaneOpts {
  on?: Any;
  scan?: Any[];
  push?: Any[];
  pushJob?: Any;
  scanJob?: Any;
  extraJobs?: Record<string, Any>;
}
const lane = (o: LaneOpts = {}): Workflow => ({
  file: 'fx.yml',
  doc: {
    on: o.on ?? { push: { branches: ['main'] } },
    jobs: {
      // contents: read — a job with NO permissions block is credentialed (fail closed).
      scan: {
        permissions: { contents: 'read' },
        steps: o.scan ?? [trivyStep(), sbomStep()],
        ...(o.scanJob ?? {}),
      },
      publish: {
        needs: 'scan',
        steps: o.push ?? [pushStep(), signStep()],
        ...(o.pushJob ?? {}),
      },
      ...(o.extraJobs ?? {}),
    },
  },
});
const fx = (w: Workflow[] | Workflow, extra: Any = {}) =>
  auditImageLanes(Array.isArray(w) ? w : [w], {
    varsFor: noVars,
    resolveAction: () => null,
    ...extra,
  });

describe('lane engine: both halves', () => {
  it('a compliant lane passes', () => {
    expect(fx(lane())).toEqual([]);
  });

  describe('discovery is by behaviour, under any trigger', () => {
    const noGates = (step: Any, on?: Any) =>
      lane({ on, scan: [], push: [step], pushJob: { needs: [] } });
    const forms: Array<[string, Any]> = [
      ['crane push', { run: 'crane push oci ghcr.io/x:1' }],
      ['docker push', { run: 'docker push ghcr.io/x:1' }],
      ['docker buildx build --push', { run: 'docker buildx build --push -t ghcr.io/x:1 .' }],
      [
        'a line-continued push',
        { run: 'docker \\\n push ghcr.io/x:1'.replace('docker \\\n push', 'crane \\\n push') },
      ],
      [
        'build-push-action push: true',
        { uses: 'docker/build-push-action@abc', with: { push: true } },
      ],
      [
        'build-push-action push expression',
        {
          uses: 'docker/build-push-action@abc',
          with: { push: "${{ github.ref == 'refs/heads/main' }}" },
        },
      ],
      [
        'build-push-action type=registry',
        { uses: 'docker/build-push-action@abc', with: { outputs: 'type=registry' } },
      ],
      ['a push-to-registry action', { uses: 'redhat-actions/push-to-registry@abc' }],
    ];
    for (const [label, step] of forms) {
      for (const [trigName, on] of [
        ['workflow_dispatch', { workflow_dispatch: {} }],
        ['workflow_call', { workflow_call: {} }],
        ['schedule', { schedule: [{ cron: '0 0 * * *' }] }],
      ] as const) {
        it(`${label} under ${trigName} with no gates reds on trivy, sbom and cosign`, () => {
          expect(checks(fx(noGates(step, on)))).toEqual(
            expect.arrayContaining(['trivy', 'sbom', 'cosign']),
          );
        });
      }
    }
    it('build-push-action with push: false is not a lane', () => {
      const w = noGates({ uses: 'docker/build-push-action@abc', with: { push: false } });
      expect(fx(w)).toEqual([]);
    });
    it('comment prose that says `crane push` is not a lane', () => {
      expect(fx(noGates({ run: '# crane push later\necho ok' }))).toEqual([]);
    });
  });

  describe('reusable workflows and local actions are resolved, never skipped', () => {
    it('a local reusable workflow that resolves is accepted as a call; its callee is scanned as a lane', () => {
      const callee = { ...lane({ on: { workflow_call: {} }, scan: [] }), file: 'callee.yml' };
      const caller: Workflow = {
        file: 'caller.yml',
        doc: { on: {}, jobs: { go: { uses: './.github/workflows/callee.yml' } } },
      };
      expect(checks(fx([caller, callee]))).toEqual(expect.arrayContaining(['trivy', 'sbom']));
      expect(discoverImageLanes([caller, callee]).findings).toEqual([]);
    });
    it('a local reusable workflow that does not exist reds', () => {
      const caller: Workflow = {
        file: 'caller.yml',
        doc: { on: {}, jobs: { go: { uses: './.github/workflows/missing.yml' } } },
      };
      expect(checks(fx(caller))).toContain('unresolved');
    });
    it('a remote reusable workflow reds (cannot be scanned)', () => {
      const caller: Workflow = {
        file: 'caller.yml',
        doc: { on: {}, jobs: { go: { uses: 'org/repo/.github/workflows/p.yml@v1' } } },
      };
      expect(checks(fx(caller))).toContain('unresolved');
    });
    it('a local composite action that pushes makes its caller a lane', () => {
      const w: Workflow = {
        file: 'c.yml',
        doc: { on: {}, jobs: { j: { steps: [{ uses: './.github/actions/p' }] } } },
      };
      const out = fx(w, { resolveAction: () => [{ run: 'crane push oci ghcr.io/x:1' }] });
      expect(checks(out)).toEqual(expect.arrayContaining(['trivy', 'sbom', 'cosign']));
    });
    it('a local action that cannot be resolved reds', () => {
      const w: Workflow = {
        file: 'c.yml',
        doc: { on: {}, jobs: { j: { steps: [{ uses: './.github/actions/p' }] } } },
      };
      expect(checks(fx(w))).toContain('unresolved');
    });
  });

  describe('a gate that cannot fail or cannot run does not count', () => {
    const kinds: Array<[string, (e: Any) => LaneOpts]> = [
      ['trivy', (e) => ({ scan: [trivyStep(e), sbomStep()] })],
      ['sbom', (e) => ({ scan: [trivyStep(), sbomStep(e)] })],
      ['cosign', (e) => ({ push: [pushStep(), signStep(e)] })],
    ];
    for (const [kind, build] of kinds) {
      it(`${kind}: continue-on-error: true reds`, () => {
        expect(checks(fx(lane(build({ 'continue-on-error': true }))))).toContain(kind);
      });
      it(`${kind}: continue-on-error as an expression true on main reds`, () => {
        const e = { 'continue-on-error': "${{ github.ref == 'refs/heads/main' }}" };
        expect(checks(fx(lane(build(e))))).toContain(kind);
      });
      it(`${kind}: a continue-on-error expression that is false on every publishing ref passes`, () => {
        const e = { 'continue-on-error': "${{ github.ref != 'refs/heads/main' }}" };
        expect(fx(lane(build(e)))).toEqual([]);
      });
      it(`${kind}: a continue-on-error expression the evaluator cannot read reds (fail closed)`, () => {
        expect(
          checks(fx(lane(build({ 'continue-on-error': '${{ fromJSON(env.X) }}' })))),
        ).toContain(kind);
      });
      it(`${kind}: a step if that disables it on main reds`, () => {
        expect(checks(fx(lane(build({ if: "github.ref == 'refs/heads/dev'" }))))).toContain(kind);
      });
      it(`${kind}: a step if that depends on something unprovable reds`, () => {
        expect(checks(fx(lane(build({ if: "steps.x.outputs.y == 'z'" }))))).toContain(kind);
      });
      it(`${kind}: a step if provably true on the publishing ref passes`, () => {
        expect(fx(lane(build({ if: "github.ref == 'refs/heads/main'" })))).toEqual([]);
        expect(fx(lane(build({ if: 'always()' })))).toEqual([]);
      });
    }
    it('job-level continue-on-error on the scan job reds', () => {
      expect(checks(fx(lane({ scanJob: { 'continue-on-error': true } })))).toContain('trivy');
    });
    it('a job-level if that disables the UPSTREAM scan job also skips the push, so it is not a bypass', () => {
      expect(fx(lane({ scanJob: { if: "github.ref == 'refs/heads/dev'" } }))).toEqual([]);
    });
    it('...unless the push job opts in to running after a skipped/failed need (always())', () => {
      const w = lane({
        scanJob: { if: "github.ref == 'refs/heads/dev'" },
        pushJob: { if: 'always()' },
      });
      expect(checks(fx(w))).toContain('trivy');
    });
    it('a job `if` that is UNKNOWN on a DOWNSTREAM cosign job reds (it may be skipped after the push)', () => {
      const w = lane({
        push: [pushStep()],
        extraJobs: {
          sign: { needs: 'publish', if: "needs.x.outputs.y == 'z'", steps: [signStep()] },
        },
      });
      expect(checks(fx(w))).toContain('cosign');
    });
    it('a job `if` provably true on every publishing ref on a downstream cosign job passes', () => {
      const w = lane({
        push: [pushStep()],
        extraJobs: { sign: { needs: 'publish', if: 'always()', steps: [signStep()] } },
      });
      expect(fx(w)).toEqual([]);
    });
    it('a job-level if on an UPSTREAM scan job that depends on another job output passes (its skip skips the push)', () => {
      expect(fx(lane({ scanJob: { if: "needs.changes.outputs.relevant == 'true'" } }))).toEqual([]);
    });
  });

  describe('Trivy must cover HIGH and CRITICAL and fail the build', () => {
    for (const sev of ['LOW', 'LOW,MEDIUM', 'CRITICAL', 'HIGH', 'MEDIUM,HIGH']) {
      it(`severity ${sev} reds`, () => {
        const w = lane({ scan: [trivyStep({}, { severity: sev }), sbomStep()] });
        expect(checks(fx(w))).toContain('trivy');
      });
    }
    it('severity HIGH,CRITICAL, lowercase, and an absent severity (Trivy default = all) pass', () => {
      expect(
        fx(lane({ scan: [trivyStep({}, { severity: 'high, critical' }), sbomStep()] })),
      ).toEqual([]);
      const noSev = trivyStep();
      delete (noSev.with as Any).severity;
      expect(fx(lane({ scan: [noSev, sbomStep()] }))).toEqual([]);
    });
    it('exit-code 0 reds', () => {
      expect(
        checks(fx(lane({ scan: [trivyStep({}, { 'exit-code': '0' }), sbomStep()] }))),
      ).toContain('trivy');
    });
    it('a CLI trivy call with --severity LOW reds; with --exit-code 1 HIGH,CRITICAL passes', () => {
      const cli = (a: string): LaneOpts => ({
        scan: [{ run: `trivy image --exit-code 1 --severity ${a} oci` }, sbomStep()],
      });
      expect(checks(fx(lane(cli('LOW'))))).toContain('trivy');
      expect(fx(lane(cli('HIGH,CRITICAL')))).toEqual([]);
    });
  });

  describe('ordering and tie to the published image (as far as YAML allows)', () => {
    it('a push job that does not wait for the Trivy job reds', () => {
      expect(checks(fx(lane({ pushJob: { needs: [] } })))).toContain('trivy');
    });
    it('cosign before the push in the same job reds', () => {
      expect(checks(fx(lane({ push: [signStep(), pushStep()] })))).toContain('cosign-order');
    });
    it('pushing a layout Trivy did not scan reds', () => {
      expect(
        checks(fx(lane({ push: [pushStep({ run: 'crane push other "$IMG:1"' }), signStep()] }))),
      ).toContain('tie-trivy');
    });
    it('pushing a layout derived from the scanned one by a named script passes', () => {
      const w = lane({
        scan: [{ run: 'bash build-index.sh oci oci-mp' }, trivyStep(), sbomStep()],
        push: [pushStep({ run: 'crane push oci-mp "$IMG:1-mp"' }), signStep()],
      });
      expect(fx(w)).toEqual([]);
    });
    it('cosign addressed by tag instead of digest reds', () => {
      const w = lane({
        push: [pushStep(), signStep({ run: 'cosign sign --yes ghcr.io/x/y:latest' })],
      });
      expect(checks(fx(w))).toContain('tie-cosign');
    });
  });
});

describe('evalExpr (the small three-valued evaluator)', () => {
  const ctx = (ref: string, event = 'push', vars: Record<string, string> = {}): Ctx => ({
    ref,
    event,
    vars,
  });
  const main = ctx('refs/heads/main');
  it('decides ref gates on literal refs', () => {
    expect(evalExpr("${{ github.ref != 'refs/heads/main' }}", main)).toBe(false);
    expect(evalExpr("github.ref == 'refs/heads/main'", main)).toBe(true);
    expect(evalExpr("startsWith(github.ref, 'refs/tags/')", ctx('refs/tags/v1'))).toBe(true);
    expect(evalExpr("!startsWith(github.ref, 'refs/heads/integration/')", main)).toBe(true);
  });
  it('handles && || ! parentheses and always()', () => {
    expect(
      evalExpr(
        "(github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/main'",
        main,
      ),
    ).toBe(true);
    expect(evalExpr('always()', main)).toBe(true);
    expect(evalExpr('failure()', main)).toBe(false);
  });
  it('is three-valued: an unknown operand propagates unless short-circuited', () => {
    expect(evalExpr("steps.x.outputs.y == 'z'", main)).toBe(UNKNOWN);
    expect(evalExpr("steps.x.outputs.y == 'z' && github.ref == 'refs/heads/dev'", main)).toBe(
      false,
    );
    expect(evalExpr("steps.x.outputs.y == 'z' || github.ref == 'refs/heads/main'", main)).toBe(
      true,
    );
  });
  it('an unknown operand under && stays UNKNOWN, never false (a soft-fail cannot hide behind it)', () => {
    expect(evalExpr("github.ref == 'refs/heads/main' && steps.x.outputs.y == 'z'", main)).toBe(
      UNKNOWN,
    );
    const e = {
      'continue-on-error': "${{ github.ref == 'refs/heads/main' && steps.x.outputs.y == 'z' }}",
    };
    expect(checks(fx(lane({ push: [pushStep(), signStep(e)] })))).toContain('cosign');
  });
  it('resolves provided variables', () => {
    expect(
      evalExpr(
        "steps.channel.outputs.publish != 'true'",
        ctx('refs/heads/main', 'push', { 'steps.channel.outputs.publish': 'true' }),
      ),
    ).toBe(false);
  });
  it('anything it cannot parse or does not know is UNKNOWN (fail closed)', () => {
    expect(evalExpr('fromJSON(env.X)', main)).toBe(UNKNOWN);
    expect(evalExpr('github.ref ==', main)).toBe(UNKNOWN);
    expect(evalExpr("github.ref @ 'x'", main)).toBe(UNKNOWN);
    expect(evalExpr(42, main)).toBe(UNKNOWN);
  });
});

// ───────────────────────── function template images ─────────────────────────

describe('function template images: the real tree', () => {
  it('derives the template images from templates/*/Dockerfile', () => {
    expect(templates).toEqual(expect.arrayContaining(['go', 'rust']));
  });

  it('every template image has an SBOM and cosign, except the NAMED known gaps (#2425)', () => {
    expect(judge(auditTemplateImages(wfs, templates), KNOWN_GAPS)).toEqual([]);
  });

  it('every template image has an SBOM (no exception)', () => {
    expect(auditTemplateImages(wfs, templates).filter((f) => f.check === 'sbom')).toEqual([]);
  });

  it('every known gap cites #2425', () => {
    expect(KNOWN_GAPS.every((g) => g.reason.includes('#2425'))).toBe(true);
  });

  it('the known gaps are load-bearing: without them the real tree is NOT clean', () => {
    expect(judge(auditTemplateImages(wfs, templates), []).length).toBe(KNOWN_GAPS.length);
  });
});

describe('function template images: both halves on fixtures', () => {
  const image = (steps: unknown[], extra: Record<string, unknown> = {}) =>
    ({ file: 'fx.yml', doc: { on: {}, jobs: { image: { steps }, ...extra } } }) as Workflow;
  const build = { run: 'docker build -t x templates/go' };
  const sbom = { uses: 'anchore/sbom-action@abc' };
  const sign = { run: 'cosign sign --yes "$IMG@$DIGEST"' };
  const tpl = (w: Workflow, t = ['go']) => auditTemplateImages([w], t, { varsFor: noVars });

  it('a compliant template (build + SBOM + cosign) passes', () => {
    expect(tpl(image([build, sbom, sign]))).toEqual([]);
  });
  it('a downstream publish job that signs counts', () => {
    expect(tpl(image([build, sbom], { sign: { needs: 'image', steps: [sign] } }))).toEqual([]);
  });
  it('missing SBOM reds', () => {
    expect(checks(tpl(image([build, sign])))).toEqual(['sbom']);
  });
  it('missing cosign reds', () => {
    expect(checks(tpl(image([build, sbom])))).toEqual(['cosign']);
  });
  it('an SBOM or cosign step that is continue-on-error reds', () => {
    expect(checks(tpl(image([build, { ...sbom, 'continue-on-error': true }, sign])))).toEqual([
      'sbom',
    ]);
    expect(checks(tpl(image([build, sbom, { ...sign, 'continue-on-error': true }])))).toEqual([
      'cosign',
    ]);
  });
  it('an SBOM or cosign step with a disabling if reds', () => {
    expect(
      checks(tpl(image([build, { ...sbom, if: "github.ref == 'refs/heads/dev'" }, sign]))),
    ).toEqual(['sbom']);
    expect(checks(tpl(image([build, sbom, { ...sign, if: 'false' }])))).toEqual(['cosign']);
  });
  it('installing cosign without signing is not signing', () => {
    expect(checks(tpl(image([build, sbom, { uses: 'sigstore/cosign-installer@abc' }])))).toEqual([
      'cosign',
    ]);
  });
  it('a signing job that does not need the image job is not counted', () => {
    expect(checks(tpl(image([build, sbom], { sign: { steps: [sign] } })))).toEqual(['cosign']);
  });
  it('a template with a Dockerfile that no job builds reds', () => {
    expect(tpl(image([build, sbom, sign]), ['go', 'zig']).map((f) => f.subject)).toEqual([
      'template:zig',
    ]);
  });
  it('a build-push-action context under templates/ is discovered too', () => {
    const w = image([{ uses: 'docker/build-push-action@abc', with: { context: 'templates/go' } }]);
    expect(checks(tpl(w)).sort()).toEqual(['cosign', 'sbom']);
  });
  it('comment prose that mentions cosign sign is not a signing step', () => {
    expect(checks(tpl(image([build, sbom, { run: '# cosign sign later\necho ok' }])))).toEqual([
      'cosign',
    ]);
  });
});

describe('judge: the known-gap list cannot go stale or hide a new gap', () => {
  const gap = { subject: 's', check: 'cosign', reason: 'r' };
  it('an unlisted finding reds', () => {
    expect(judge([{ subject: 's', check: 'sbom', detail: 'd' }], [gap]).length).toBe(2);
  });
  it('a listed gap that is gone reds as stale', () => {
    expect(judge([], [gap])).toEqual(['STALE known gap s|cosign']);
  });
  it('a listed gap that is present passes', () => {
    expect(judge([{ subject: 's', check: 'cosign', detail: 'd' }], [gap])).toEqual([]);
  });
});
// ───────────────────────── round 3: contexts, Trivy bypasses, ties, more push forms ─────────────────────────

const noGateLane = (step: Any, extra: Any = {}): Workflow => ({
  file: 'fx.yml',
  doc: {
    on: { push: { branches: ['main'] } },
    jobs: { publish: { steps: [step], ...extra } },
  },
});
const lanesOf = (w: Workflow, o: Any = {}) =>
  discoverImageLanes([w], { resolveAction: () => null, ...o }).lanes.length;

describe('contexts: refs the workflow can run on are sampled', () => {
  const bad = (name: string, expr: string, on: Any, kind: 'trivy' | 'sbom' | 'cosign') => {
    const e = { 'continue-on-error': expr };
    const build: Record<string, LaneOpts> = {
      trivy: { scan: [trivyStep(e), sbomStep()] },
      sbom: { scan: [trivyStep(), sbomStep(e)] },
      cosign: { push: [pushStep(), signStep(e)] },
    };
    it(`${name}: ${kind} soft-fails -> red`, () => {
      expect(checks(fx(lane({ ...build[kind], on })))).toContain(kind);
    });
  };
  for (const kind of ['trivy', 'sbom', 'cosign'] as const) {
    bad(
      'an unfiltered `on: push` fires on a tag',
      "${{ github.ref_type == 'tag' }}",
      { push: null },
      kind,
    );
    bad(
      'a tag filter is sampled',
      "${{ github.ref_type == 'tag' }}",
      { push: { tags: ['v*'] } },
      kind,
    );
    bad(
      'release fires',
      "${{ github.event_name == 'release' }}",
      { release: { types: ['published'] } },
      kind,
    );
    bad(
      'schedule fires',
      "${{ github.event_name == 'schedule' }}",
      { schedule: [{ cron: '0 0 * * *' }] },
      kind,
    );
    bad(
      'workflow_run fires',
      "${{ github.event_name == 'workflow_run' }}",
      { workflow_run: {} },
      kind,
    );
    bad('dispatch from a tag', "${{ github.ref_type == 'tag' }}", { workflow_dispatch: {} }, kind);
    bad(
      'dispatch from a release branch',
      "${{ startsWith(github.ref, 'refs/heads/release/') }}",
      { workflow_dispatch: {} },
      kind,
    );
  }
  it('an expression about a context that is not sampled (the actor) is unprovable -> red', () => {
    const e = { 'continue-on-error': "${{ github.actor == 'dependabot[bot]' }}" };
    expect(checks(fx(lane({ push: [pushStep(), signStep(e)], on: { push: null } })))).toContain(
      'cosign',
    );
  });
  it('the SAME tag-only expression passes when only main can run it (the sample is not noise)', () => {
    const e = { 'continue-on-error': "${{ github.ref_type == 'tag' }}" };
    expect(
      fx(lane({ push: [pushStep(), signStep(e)], on: { push: { branches: ['main'] } } })),
    ).toEqual([]);
  });
  it('a pull_request-only soft-fail does not count against a push that never runs on PRs', () => {
    const e = { 'continue-on-error': "${{ github.event_name == 'pull_request' }}" };
    const on = { push: { branches: ['main'] }, pull_request: {} };
    expect(
      fx(
        lane({
          push: [pushStep(), signStep(e)],
          on,
          pushJob: { if: "github.event_name == 'push'" },
        }),
      ),
    ).toEqual([]);
  });
});

describe('Trivy: discarded exit status and non-image scans do not count', () => {
  const cli = (run: string, extra: Any = {}): LaneOpts => ({
    scan: [{ run, ...extra }, sbomStep()],
  });
  const base = 'trivy image --exit-code 1 --severity HIGH,CRITICAL oci';
  for (const [label, run] of [
    ['`|| true`', `${base} || true`],
    ['`|| :`', `${base} || :`],
    ['`; true`', `${base}; true`],
    ['`|| exit 0`', `${base} || exit 0`],
    ['a pipe with no pipefail', `${base} | tee out.txt`],
    ['`set +e`', `set +e\n${base}`],
  ] as const) {
    it(`${label} reds`, () => {
      expect(checks(fx(lane(cli(run))))).toContain('trivy');
    });
  }
  it('a plain enforcing CLI call passes', () => {
    expect(fx(lane(cli(base)))).toEqual([]);
  });
  it('a pipe is fine when pipefail is set, or when the step selects `shell: bash`', () => {
    expect(fx(lane(cli(`set -o pipefail\n${base} | tee out.txt`)))).toEqual([]);
    expect(fx(lane(cli(`${base} | tee out.txt`, { shell: 'bash' })))).toEqual([]);
  });
  for (const run of [
    'trivy fs --exit-code 1 --severity HIGH,CRITICAL .',
    'trivy config --exit-code 1 .',
    'trivy repo --exit-code 1 .',
    'trivy rootfs --exit-code 1 /',
  ]) {
    it(`\`${run}\` does not satisfy "image scanned"`, () => {
      expect(checks(fx(lane(cli(run))))).toContain('trivy');
    });
  }
  for (const t of ['fs', 'config', 'repo', 'rootfs', 'sbom']) {
    it(`trivy-action scan-type: ${t} does not satisfy "image scanned"`, () => {
      const w = lane({ scan: [trivyStep({}, { 'scan-type': t }), sbomStep()] });
      expect(checks(fx(w))).toContain('trivy');
    });
  }
  it('trivy-action with scan-type: image (or none) does', () => {
    expect(fx(lane({ scan: [trivyStep({}, { 'scan-type': 'image' }), sbomStep()] }))).toEqual([]);
  });
});

describe('ties for docker push and build-push-action, and cosign by name', () => {
  const refStep = (ref: string): Any => trivyStep({}, { 'image-ref': ref, input: undefined });
  const dockerLane = (scanRef: string, push: Any[]) =>
    lane({ scan: [refStep(scanRef), sbomStep()], push });
  const dpush = (name: string): Any => ({ run: `docker push ${name}` });
  const sign = (name: string): Any => ({ run: `cosign sign --yes "${name}@$DIGEST"` });

  it('docker push of the scanned literal name, signed by that name, passes', () => {
    expect(fx(dockerLane('ghcr.io/x/y:1', [dpush('ghcr.io/x/y:1'), sign('ghcr.io/x/y')]))).toEqual(
      [],
    );
  });
  it('docker push of a literal name Trivy did not scan reds', () => {
    const w = dockerLane('ghcr.io/x/y:1', [dpush('ghcr.io/x/other:1'), sign('ghcr.io/x/other')]);
    expect(checks(fx(w))).toContain('tie-trivy');
  });
  it('build-push-action tags a literal name Trivy did not scan -> red; the scanned one -> pass', () => {
    const bpa = (tag: string): Any => ({
      uses: 'docker/build-push-action@abc',
      with: { push: true, tags: tag },
    });
    expect(
      checks(fx(dockerLane('ghcr.io/x/y:1', [bpa('ghcr.io/x/other:1'), sign('ghcr.io/x/other')]))),
    ).toContain('tie-trivy');
    expect(fx(dockerLane('ghcr.io/x/y:1', [bpa('ghcr.io/x/y:1'), sign('ghcr.io/x/y')]))).toEqual(
      [],
    );
  });
  it('variable names compare after normalisation (${{ env.IMAGE }} == ${IMAGE}); different variables are untied, not red', () => {
    expect(
      fx(
        dockerLane('${{ env.IMAGE }}:${{ github.sha }}', [
          dpush('"${IMAGE}:${GITHUB_SHA}"'),
          sign('${IMAGE}'),
        ]),
      ),
    ).toEqual([]);
    expect(
      checks(fx(dockerLane('${{ env.A }}:1', [dpush('"${B}:1"'), sign('${B}')]))),
    ).not.toContain('tie-trivy');
  });
  it('signing an extra name the lane never pushed reds (the pushed name IS signed)', () => {
    const w = dockerLane('ghcr.io/x/y:1', [
      dpush('ghcr.io/x/y:1'),
      sign('ghcr.io/x/y'),
      sign('someone/else'),
    ]);
    expect(checks(fx(w))).toContain('tie-cosign-name');
  });
  it('cosign signing a DIFFERENT name than the one pushed reds (even at a digest)', () => {
    const w = dockerLane('ghcr.io/x/y:1', [dpush('ghcr.io/x/y:1'), sign('other/img')]);
    expect(checks(fx(w))).toContain('tie-cosign-name');
  });
  it('a pushed name that is never signed reds (two pushes, one signature)', () => {
    const w = dockerLane('ghcr.io/x/y:1', [
      dpush('ghcr.io/x/y:1'),
      dpush('ghcr.io/x/z:1'),
      sign('ghcr.io/x/y'),
    ]);
    expect(checks(fx(w))).toContain('tie-cosign-name');
  });
  it('signing every pushed name passes', () => {
    const w = dockerLane('ghcr.io/x/y:1', [
      dpush('ghcr.io/x/y:1'),
      dpush('ghcr.io/x/y:2'),
      sign('ghcr.io/x/y'),
    ]);
    expect(fx(w)).toEqual([]);
  });
  it('cosign sign-blob signs a file, not an image: it is not a cosign gate', () => {
    const w = lane({ push: [pushStep(), { run: 'cosign sign-blob --yes SHA256SUMS' }] });
    expect(checks(fx(w))).toContain('cosign');
  });
});

describe('more ways to push an image are discovered', () => {
  const forms: Array<[string, Any]> = [
    ['buildah push', { run: 'buildah push img docker://ghcr.io/x:1' }],
    ['ko publish', { run: 'ko publish ./cmd/app' }],
    ['ko build', { run: 'ko build ./cmd/app' }],
    ['regctl image copy', { run: 'regctl image copy a b' }],
    ['docker image push', { run: 'docker image push ghcr.io/x:1' }],
    [
      '--output type=registry',
      { run: 'docker buildx build --output type=registry,name=ghcr.io/x:1 .' },
    ],
    ['--output type=registry on any tool', { run: 'buildctl build --output type=registry,name=x' }],
    ['bake-action with push', { uses: 'docker/bake-action@abc', with: { push: true } }],
    [
      'bake-action with a registry output',
      { uses: 'docker/bake-action@abc', with: { set: '*.output=type=registry' } },
    ],
    ['gcloud builds submit --tag', { run: 'gcloud builds submit --tag gcr.io/p/i .' }],
    ['crane tag', { run: 'crane tag ghcr.io/x@sha256:abc v1' }],
    ['podman push', { run: 'podman push ghcr.io/x:1' }],
  ];
  for (const [label, step] of forms)
    it(`${label} is a lane`, () => {
      expect(lanesOf(noGateLane(step))).toBe(1);
    });
  it('bake-action without push is not a lane', () => {
    expect(lanesOf(noGateLane({ uses: 'docker/bake-action@abc', with: {} }))).toBe(0);
  });
  it('gcloud builds submit without --tag or --config is not a lane', () => {
    expect(lanesOf(noGateLane({ run: 'gcloud builds submit .' }))).toBe(0);
  });
  it('an echo that merely prints a push command is not a lane', () => {
    expect(lanesOf(noGateLane({ run: 'echo "docker push ghcr.io/x:1"' }))).toBe(0);
  });

  describe('Cloud Build configs are read', () => {
    const step = { run: 'gcloud builds submit . --config infra/cb.yaml' };
    it('a config listing `images:` is a lane', () => {
      expect(
        lanesOf(noGateLane(step), { readScript: () => 'steps: []\nimages:\n  - gcr.io/p/i' }),
      ).toBe(1);
    });
    it('a config with no images and no push step is not a lane', () => {
      expect(lanesOf(noGateLane(step), { readScript: () => 'steps:\n  - name: ubuntu\n' })).toBe(0);
    });
    it('an unreadable config is assumed to push (fail closed)', () => {
      expect(lanesOf(noGateLane(step), { readScript: () => null })).toBe(1);
    });
  });

  describe('local destinations publish nothing; a non-local one beside them does', () => {
    it('crane copy / docker push to localhost, or a variable assigned localhost, are not lanes', () => {
      expect(lanesOf(noGateLane({ run: 'docker push localhost:5001/x:1' }))).toBe(0);
      expect(
        lanesOf(noGateLane({ run: 'ref="localhost:5001/x@$d"\ncrane copy "$SRC" "$ref"' })),
      ).toBe(0);
      expect(lanesOf(noGateLane({ run: 'docker push 127.0.0.1:5000/x:1' }))).toBe(0);
    });
    it('a variable with no local assignment, or assigned GHCR, is a lane', () => {
      expect(lanesOf(noGateLane({ run: 'crane copy "$SRC" "$ref"' }))).toBe(1);
      expect(lanesOf(noGateLane({ run: 'ref="ghcr.io/x@$d"\ncrane copy "$SRC" "$ref"' }))).toBe(1);
    });
    it('one local copy plus one GHCR push in the same step is a lane', () => {
      expect(
        lanesOf(
          noGateLane({ run: 'crane copy a localhost:5001/x\ncrane push layout ghcr.io/x:1' }),
        ),
      ).toBe(1);
    });
  });
});

describe('repo-local scripts are read for pushes', () => {
  const script = (body: string | null) => ({ readScript: () => body });
  const invoke = (run: string, extra: Any = {}, job: Any = {}) =>
    noGateLane({ run, ...extra }, job);
  const findingsOf = (w: Workflow, body: string | null) =>
    discoverImageLanes([w], { resolveAction: () => null, ...script(body) }).findings;

  it('a script that pushes makes the invoking job a lane (bash, node, ./direct, source)', () => {
    for (const run of ['bash hack/p.sh', 'node scripts/p.mjs', './hack/p.sh', 'source hack/p.sh']) {
      expect(lanesOf(invoke(run), script('crane push layout ghcr.io/x:1'))).toBe(1);
    }
  });
  it('a script that does not push does not', () => {
    expect(lanesOf(invoke('bash hack/p.sh'), script('echo hi'))).toBe(0);
  });
  it('comment lines in the script are not code', () => {
    expect(
      lanesOf(invoke('bash hack/p.sh'), script('# crane push layout x\n// docker push y')),
    ).toBe(0);
  });
  it('a script called by a script is followed', () => {
    const read = (p: string) =>
      p === 'a.sh' ? 'bash b.sh' : p === 'b.sh' ? 'docker push ghcr.io/x:1' : null;
    expect(lanesOf(invoke('bash a.sh'), { readScript: read })).toBe(1);
  });
  it('the push inherits the invoker `if`, so a disabled invocation never runs', () => {
    const out = fx(invoke('bash hack/p.sh', { if: 'false' }), {
      readScript: () => 'crane push layout ghcr.io/x:1',
    });
    expect(checks(out)).toContain('never-runs');
  });
  it('an unreadable script in a CREDENTIALED job reds', () => {
    const w = invoke('bash hack/p.sh', {}, { permissions: { packages: 'write' } });
    expect(checks(findingsOf(w, null))).toContain('unresolved-script');
  });
  it('...also when the job logs in to a registry or runs cosign', () => {
    for (const steps of [
      [{ uses: 'docker/login-action@abc' }, { run: 'bash hack/p.sh' }],
      [{ run: 'cosign version' }, { run: 'bash hack/p.sh' }],
    ]) {
      const w: Workflow = { file: 'fx.yml', doc: { on: {}, jobs: { j: { steps } } } };
      expect(checks(findingsOf(w, null))).toContain('unresolved-script');
    }
  });
  it('an unreadable script in a job with no registry credential cannot publish, so it is not a finding', () => {
    const ro = { permissions: { contents: 'read' } };
    expect(findingsOf(invoke('bash hack/p.sh', {}, ro), null)).toEqual([]);
    expect(findingsOf(invoke('bash hack/p.sh', {}, { permissions: {} }), null)).toEqual([]);
  });

  describe('credential scope the raw job.steps/permissions do not show', () => {
    const ro = { permissions: { contents: 'read' } };
    const withAction = (resolved: Any[] | null) =>
      discoverImageLanes(
        [
          {
            file: 'fx.yml',
            doc: {
              on: {},
              jobs: {
                j: { ...ro, steps: [{ uses: './.github/actions/reg' }, { run: 'bash hack/p.sh' }] },
              },
            },
          },
        ],
        { resolveAction: () => resolved, readScript: () => null },
      ).findings;
    it('a registry login inside a local composite action makes the job credentialed', () => {
      expect(checks(withAction([{ uses: 'docker/login-action@abc' }]))).toContain(
        'unresolved-script',
      );
      expect(checks(withAction([{ run: 'crane auth login ghcr.io -u x' }]))).toContain(
        'unresolved-script',
      );
    });
    it('...also when the login is nested one composite deeper', () => {
      const nested = (u: string) =>
        u === './.github/actions/reg'
          ? [{ uses: './.github/actions/inner' }]
          : [{ uses: 'docker/login-action@abc' }];
      const f = discoverImageLanes(
        [
          {
            file: 'fx.yml',
            doc: {
              on: {},
              jobs: {
                j: { ...ro, steps: [{ uses: './.github/actions/reg' }, { run: 'bash h.sh' }] },
              },
            },
          },
        ],
        { resolveAction: nested, readScript: () => null },
      ).findings;
      expect(checks(f)).toContain('unresolved-script');
    });
    describe('third-party registry login shapes (#2756)', () => {
      const direct = (steps: Any[]) =>
        discoverImageLanes(
          [
            {
              file: 'fx.yml',
              doc: { on: {}, jobs: { j: { ...ro, steps: [...steps, { run: 'bash hack/p.sh' }] } } },
            },
          ],
          { resolveAction: () => null, readScript: () => null },
        ).findings;
      const positives: Array<[string, Any[]]> = [
        ['aws-actions/amazon-ecr-login', [{ uses: 'aws-actions/amazon-ecr-login@abc' }]],
        ['azure/docker-login', [{ uses: 'azure/docker-login@abc' }]],
        ['az acr login', [{ run: 'az acr login --name reg' }]],
        ['helm registry login', [{ run: 'helm registry login ghcr.io -u x' }]],
        [
          'gcloud auth configure-docker',
          [{ run: 'gcloud auth configure-docker us-docker.pkg.dev' }],
        ],
        ['aws ecr get-login-password', [{ run: 'aws ecr get-login-password | crane x' }]],
        ['aws ecr-public get-login-password', [{ run: 'aws ecr-public get-login-password' }]],
        ['buildah login', [{ run: 'buildah login -u x ghcr.io' }]],
        ['nerdctl login', [{ run: 'nerdctl login ghcr.io' }]],
        [
          'google-github-actions/auth + docker push',
          [{ uses: 'google-github-actions/auth@abc' }, { run: 'docker push img' }],
        ],
        [
          'google-github-actions/auth + pkg.dev image',
          [
            { uses: 'google-github-actions/auth@abc' },
            { run: 'crane copy a us-docker.pkg.dev/p/r/i:1' },
          ],
        ],
        [
          'google-github-actions/auth + gcr.io image in with',
          [
            { uses: 'google-github-actions/auth@abc' },
            { uses: 'x/y@abc', with: { image: 'gcr.io/p/i' } },
          ],
        ],
        [
          'google-github-actions/auth + configure-docker',
          [{ uses: 'google-github-actions/auth@abc' }, { run: 'gcloud auth configure-docker' }],
        ],
      ];
      for (const [label, steps] of positives) {
        it(`${label} makes the job credentialed`, () => {
          expect(checks(direct(steps))).toContain('unresolved-script');
        });
      }
      const negatives: Array<[string, Any[]]> = [
        ['helm repo add', [{ run: 'helm repo add bitnami https://charts.bitnami.com' }]],
        ['az login without acr', [{ run: 'az login --service-principal' }]],
        ['aws s3 cp', [{ run: 'aws s3 cp a s3://b/c' }]],
        ['google-github-actions/auth alone', [{ uses: 'google-github-actions/auth@abc' }]],
        ['xbuildah login', [{ run: 'xbuildah login' }]],
        [
          'aws-actions/configure-aws-credentials',
          [{ uses: 'aws-actions/configure-aws-credentials@abc' }],
        ],
      ];
      for (const [label, steps] of negatives) {
        it(`${label} does not make the job credentialed`, () => {
          expect(checks(direct(steps))).not.toContain('unresolved-script');
        });
      }
    });
    it('a composite action with no registry login leaves the job uncredentialed', () => {
      expect(checks(withAction([{ run: 'echo hi' }]))).not.toContain('unresolved-script');
    });
    it('a job with no permissions block anywhere inherits the repo default token, so it is credentialed', () => {
      expect(checks(findingsOf(invoke('bash hack/p.sh'), null))).toContain('unresolved-script');
    });
    it('...a workflow-level permissions block covers a job that has none', () => {
      const w: Workflow = {
        file: 'fx.yml',
        doc: {
          on: {},
          permissions: { contents: 'read' },
          jobs: { j: { steps: [{ run: 'bash hack/p.sh' }] } },
        },
      };
      expect(findingsOf(w, null)).toEqual([]);
    });
    it('a secret handed in through workflow_call.secrets makes the callee credentialed', () => {
      const w: Workflow = {
        file: 'fx.yml',
        doc: {
          on: { workflow_call: { secrets: { REGISTRY_TOKEN: { required: true } } } },
          jobs: { j: { ...ro, steps: [{ run: 'bash hack/p.sh' }] } },
        },
      };
      expect(checks(findingsOf(w, null))).toContain('unresolved-script');
    });
    it('a registry-named secret in job env, step env or step with makes the job credentialed', () => {
      const tok = '${{ secrets.REGISTRY_TOKEN }}';
      for (const extra of [
        { env: { T: tok }, steps: [{ run: 'bash hack/p.sh' }] },
        { steps: [{ run: 'bash hack/p.sh', env: { T: tok } }] },
        { steps: [{ uses: 'some/action@abc', with: { token: tok } }, { run: 'bash hack/p.sh' }] },
      ]) {
        const w: Workflow = {
          file: 'fx.yml',
          doc: { on: {}, jobs: { j: { ...ro, ...extra } } },
        };
        expect(checks(findingsOf(w, null))).toContain('unresolved-script');
      }
    });
    it('bracket-form, toJSON(secrets) and dynamic secrets[...] reads make the job credentialed', () => {
      for (const tok of [
        "${{ secrets['DOCKER_TOKEN'] }}",
        '${{ secrets["DOCKER_TOKEN"] }}',
        '${{ toJSON(secrets) }}',
        '${{ secrets[matrix.name] }}',
      ]) {
        const w: Workflow = {
          file: 'fx.yml',
          doc: {
            on: {},
            jobs: { j: { ...ro, steps: [{ run: 'bash hack/p.sh', env: { T: tok } }] } },
          },
        };
        expect(checks(findingsOf(w, null))).toContain('unresolved-script');
      }
    });
    it('...but a non-registry secret in bracket form does not', () => {
      const w: Workflow = {
        file: 'fx.yml',
        doc: {
          on: {},
          jobs: {
            j: {
              ...ro,
              steps: [
                { run: 'bash hack/p.sh', env: { T: "${{ secrets['PREVIEW_KUBECONFIG'] }}" } },
              ],
            },
          },
        },
      };
      expect(findingsOf(w, null)).toEqual([]);
    });
    it('registry credentials on job.container or job.services.* make the job credentialed', () => {
      const creds = { username: 'u', password: '${{ secrets.PULL_PW }}' };
      for (const extra of [
        { container: { image: 'x', credentials: creds } },
        { services: { db: { image: 'x', credentials: creds } } },
      ]) {
        const w: Workflow = {
          file: 'fx.yml',
          doc: { on: {}, jobs: { j: { ...ro, ...extra, steps: [{ run: 'bash hack/p.sh' }] } } },
        };
        expect(checks(findingsOf(w, null))).toContain('unresolved-script');
      }
    });
    it('...a container without credentials does not', () => {
      const w: Workflow = {
        file: 'fx.yml',
        doc: {
          on: {},
          jobs: { j: { ...ro, container: { image: 'x' }, steps: [{ run: 'bash hack/p.sh' }] } },
        },
      };
      expect(findingsOf(w, null)).toEqual([]);
    });
    it('generic push names (PUSH_TOKEN, CR_PAT) count as registry secrets; NPM_TOKEN does not', () => {
      const run = (name: string) =>
        findingsOf(
          {
            file: 'fx.yml',
            doc: {
              on: {},
              jobs: {
                j: {
                  ...ro,
                  steps: [{ run: 'bash hack/p.sh', env: { T: '${{ secrets.' + name + ' }}' } }],
                },
              },
            },
          },
          null,
        );
      expect(checks(run('PUSH_TOKEN'))).toContain('unresolved-script');
      expect(checks(run('CR_PAT'))).toContain('unresolved-script');
      expect(run('NPM_TOKEN')).toEqual([]);
    });
    describe('a caller handing secrets to a local reusable workflow', () => {
      const pair = (callerSecrets: Any | string | undefined) => {
        const caller: Workflow = {
          file: 'caller.yml',
          doc: {
            on: {},
            jobs: {
              c: {
                uses: './.github/workflows/callee.yml',
                ...(callerSecrets === undefined ? {} : { secrets: callerSecrets }),
              },
            },
          },
        };
        const callee: Workflow = {
          file: 'callee.yml',
          doc: {
            on: { workflow_call: {} },
            jobs: { j: { ...ro, steps: [{ run: 'bash hack/p.sh' }] } },
          },
        };
        return discoverImageLanes([caller, callee], {
          resolveAction: () => null,
          ...script(null),
        }).findings;
      };
      it('secrets: inherit makes the callee credentialed even with no declared secrets', () => {
        expect(checks(pair('inherit'))).toContain('unresolved-script');
      });
      it('a secrets map naming a registry secret (key or value) does too', () => {
        expect(checks(pair({ REGISTRY_TOKEN: 'x' }))).toContain('unresolved-script');
        expect(checks(pair({ T: '${{ secrets.GHCR_PAT }}' }))).toContain('unresolved-script');
      });
      it('...but no secrets, or only a non-registry one, leaves the callee uncredentialed', () => {
        expect(pair(undefined)).toEqual([]);
        expect(pair({ KUBECONFIG: '${{ secrets.PREVIEW_KUBECONFIG }}' })).toEqual([]);
      });
    });
    it('a non-registry secret (kubeconfig, deploy hook) does not make the job credentialed', () => {
      const tok = '${{ secrets.PREVIEW_KUBECONFIG }}';
      for (const extra of [
        { env: { T: tok }, steps: [{ run: 'bash hack/p.sh' }] },
        { steps: [{ run: 'bash hack/p.sh', env: { T: tok } }] },
        { steps: [{ uses: 'some/action@abc', with: { token: tok } }, { run: 'bash hack/p.sh' }] },
      ]) {
        const w: Workflow = {
          file: 'fx.yml',
          doc: { on: {}, jobs: { j: { ...ro, ...extra } } },
        };
        expect(findingsOf(w, null)).toEqual([]);
      }
    });
    it('the GITHUB_TOKEN alone, with contents: read, is not a registry credential', () => {
      const w: Workflow = {
        file: 'fx.yml',
        doc: {
          on: {},
          jobs: {
            j: {
              ...ro,
              steps: [{ run: 'bash hack/p.sh', env: { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' } }],
            },
          },
        },
      };
      expect(findingsOf(w, null)).toEqual([]);
    });
  });
  it('a script path built from a variable, in a credentialed job, reds', () => {
    const w = invoke('bash "$DIR/p.sh"', {}, { permissions: { 'id-token': 'write' } });
    expect(checks(findingsOf(w, 'echo'))).toContain('unresolved-script');
  });
  it('a script a step writes itself (run-time generated) is not looked up', () => {
    const w = invoke(
      'cat > gen.sh <<EOF\ncrane push x y\nEOF\nbash gen.sh',
      {},
      { permissions: { packages: 'write' } },
    );
    expect(findingsOf(w, null)).toEqual([]);
  });
  it('a script under a checkout `path:` resolves to this repo; one in another repo is skipped', () => {
    const read = (p: string) => (p === 'scripts/p.sh' ? 'crane push layout ghcr.io/x:1' : null);
    const mk = (repository?: string): Workflow => ({
      file: 'fx.yml',
      doc: {
        on: {},
        jobs: {
          j: {
            permissions: { packages: 'write' },
            steps: [
              {
                uses: 'actions/checkout@abc',
                with: { path: 'knext', ...(repository ? { repository } : {}) },
              },
              { run: 'bash knext/scripts/p.sh' },
            ],
          },
        },
      },
    });
    expect(lanesOf(mk(), { readScript: read })).toBe(1);
    const other = discoverImageLanes([mk('vercel/next.js')], {
      resolveAction: () => null,
      readScript: read,
    });
    expect(other.lanes.length).toBe(0);
    expect(other.findings).toEqual([]);
  });
  it('the real tree: no repo-local script a credentialed job invokes is unreadable', () => {
    expect(discoverImageLanes(wfs).findings).toEqual([]);
  });
});

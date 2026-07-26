import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type NextAppStatusView, toView } from './nextapp';

/**
 * P1.4 (ADR-0038) — CRD CONTRACT gate (PR-520 sysdesign follow-up).
 *
 * The reader hand-copies the operator's `v1alpha1` JSON tags. A rename on an
 * alpha API would otherwise degrade the page to "no data yet" **silently** —
 * the one dishonest failure mode in a feature built around honesty. This turns
 * that drift into a red build by asserting every projected field path against
 * `nextapp_types.go` itself, in BOTH directions:
 *   - the field exists as a JSON tag in the Go type, and
 *   - the reader still projects it (so this list cannot drift from the code).
 */

const APP_ROOT = resolve(import.meta.dirname, '../../../..');
const REPO_ROOT = resolve(APP_ROOT, '../..');
const TYPES_GO = resolve(REPO_ROOT, 'packages/kn-next-operator/api/v1alpha1/nextapp_types.go');
const GROUP_GO = resolve(REPO_ROOT, 'packages/kn-next-operator/api/v1alpha1/groupversion_info.go');
const READER = resolve(import.meta.dirname, 'nextapp.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/** Every `json:"name..."` tag declared by the operator's API types. */
function jsonTags(): Set<string> {
  const src = read(TYPES_GO);
  const tags = src.match(/json:"[^",]+/g) ?? [];
  return new Set(tags.map((t) => t.replace('json:"', '')));
}

/** The field paths the reader projects into `NextAppStatusView`. */
const PROJECTED = [
  'image',
  'traffic',
  'revisionName',
  'canaryPercent',
  'observedRevision',
  'lastSuccessfulDeployTime',
  'scaledToZero',
  'currentTraffic',
  'conditions',
  'percent',
  'latestRevision',
] as const;

/**
 * A representative `NextApp` document with EVERY projected field populated with a
 * distinct value, so a dropped or mis-wired projection changes the built view.
 */
const FIXTURE = {
  spec: {
    image: 'registry.example.com/demo@sha256:feedface',
    traffic: { revisionName: 'demo-00002', canaryPercent: 10 },
  },
  status: {
    observedRevision: 'demo-00003',
    lastSuccessfulDeployTime: '2026-07-24T15:30:00Z',
    scaledToZero: true,
    currentTraffic: [{ revisionName: 'demo-00002', percent: 90, latestRevision: false }],
    conditions: [
      {
        type: 'Ready',
        status: 'True',
        reason: 'ServiceReady',
        message: 'Knative Service is ready',
        lastTransitionTime: '2026-07-24T15:30:05Z',
      },
    ],
  },
} as const;

/** The exact view {@link FIXTURE} must produce — nothing dropped, nothing renamed. */
const EXPECTED_VIEW: NextAppStatusView = {
  observedRevision: 'demo-00003',
  lastSuccessfulDeployTime: '2026-07-24T15:30:00Z',
  scaledToZero: true,
  image: 'registry.example.com/demo@sha256:feedface',
  pinnedRevision: 'demo-00002',
  canaryPercent: 10,
  currentTraffic: [{ revisionName: 'demo-00002', percent: 90, latestRevision: false }],
  conditions: [
    {
      type: 'Ready',
      status: 'True',
      reason: 'ServiceReady',
      message: 'Knative Service is ready',
      lastTransitionTime: '2026-07-24T15:30:05Z',
    },
  ],
};

/**
 * Where each CRD JSON tag must surface in the built view. This ties {@link
 * PROJECTED} (a list of *operator* field names) to observable *view* state, so
 * the list cannot claim a field the reader no longer carries.
 */
const OBSERVED_IN_VIEW: Record<(typeof PROJECTED)[number], (view: NextAppStatusView) => unknown> = {
  image: (v) => v.image,
  // `spec.traffic` has no view key of its own: it is observable only through the
  // two fields the reader lifts out of it.
  traffic: (v) => v.pinnedRevision ?? v.canaryPercent,
  revisionName: (v) => v.pinnedRevision,
  canaryPercent: (v) => v.canaryPercent,
  observedRevision: (v) => v.observedRevision,
  lastSuccessfulDeployTime: (v) => v.lastSuccessfulDeployTime,
  scaledToZero: (v) => v.scaledToZero,
  currentTraffic: (v) => v.currentTraffic[0]?.revisionName,
  conditions: (v) => v.conditions[0]?.type,
  percent: (v) => v.currentTraffic[0]?.percent,
  latestRevision: (v) => v.currentTraffic[0]?.latestRevision,
};

describe('NextApp CRD contract — the reader cannot silently drift', () => {
  it('every projected field is a real JSON tag on the operator API type', () => {
    const tags = jsonTags();
    const missing = PROJECTED.filter((field) => !tags.has(field));
    expect(missing).toEqual([]);
  });

  it('the reader still projects every field in this contract list — on the BUILT view', () => {
    // Asserted against the OBJECT `toView` builds, not the source text: a
    // substring scan of `nextapp.ts` also matches its doc comments (which name
    // every field) and `'percent'` matches `canaryPercent`, so deleting the whole
    // projection left that version green (PR-520 review finding).
    const view = toView(FIXTURE);

    expect(view).toEqual(EXPECTED_VIEW);

    const unobservable = PROJECTED.filter((field) => OBSERVED_IN_VIEW[field](view) === undefined);
    expect(unobservable).toEqual([]);
  });

  it('a dropped projection is observable through this gate', () => {
    // Guards the gate itself: an object built WITHOUT one projected field must
    // fail the same assertions the test above makes.
    const { image: _dropped, ...withoutImage } = toView(FIXTURE);
    expect(withoutImage).not.toEqual(EXPECTED_VIEW);
    expect(OBSERVED_IN_VIEW.image(withoutImage as NextAppStatusView)).toBeUndefined();
  });

  it('a field the API does NOT declare would fail this gate', () => {
    // Guards the gate itself: the assertion above must be capable of failing.
    expect(jsonTags().has('observedRevisionRenamed')).toBe(false);
    expect(jsonTags().has('observedRevision')).toBe(true);
  });

  it('the reader targets the operator’s declared API group and version', () => {
    const groupSrc = read(GROUP_GO);
    const group = /Group:\s*"([^"]+)"/.exec(groupSrc)?.[1];
    const version = /Version:\s*"([^"]+)"/.exec(groupSrc)?.[1];
    expect(group).toBeTruthy();
    expect(version).toBeTruthy();

    const src = read(READER);
    expect(src).toContain(`API_GROUP = '${group}'`);
    expect(src).toContain(`API_VERSION = '${version}'`);
    // …and the resource path is the plural of the Kind the operator declares.
    expect(read(TYPES_GO)).toContain('type NextApp struct');
    expect(src).toContain('/nextapps/');
  });

  it('the RBAC manifest grants exactly the group/resource the reader calls', () => {
    const manifest = read(resolve(APP_ROOT, 'deploy/observability-nextapp-read-rbac.yaml'));
    const group = /Group:\s*"([^"]+)"/.exec(read(GROUP_GO))?.[1];
    expect(manifest).toContain(`apiGroups: ["${group}"]`);
    expect(manifest).toContain('resources: ["nextapps", "nextapps/status"]');
  });
});

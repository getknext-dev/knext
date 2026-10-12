import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, parseAllDocuments } from 'yaml';

/**
 * The deep-health alert kind e2e used to prove the alert pipeline on ONE install
 * shape: tracing on. The default install has tracing off, and on it the gauge was
 * not registered at all. This pins what makes the e2e a PROOF for both shapes:
 *
 *   - both arms are deployed, and the tracing-off arm is the real default (the
 *     OTEL_* variables are ABSENT, not set to "false" — the operator sets them
 *     only from the CR);
 *   - the fixture runs the reference app's real register(), so the arm is chosen
 *     by the environment alone and the off arm cannot silently become a copy of
 *     the on arm;
 *   - every port comes from the pod spec, nothing in the script or fixture
 *     hardcodes one;
 *   - the idle drop, the alert resolving, and the series returning are asserted,
 *     and the two arms are told apart by what the loopback registry serves.
 */

const ROOT = join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const SCRIPT = read('scripts/deep-health-alert-e2e.sh');
const ASSERT = read('scripts/deep-health-alert-e2e/assert-alert.mjs');
const FIXTURE_APP = read('scripts/deep-health-alert-e2e/fixture-app.yaml');
const FIXTURE_TS = read('apps/file-manager/e2e-support/deep-health-alert-fixture.ts');
const WORKFLOW = parse(read('.github/workflows/deep-health-alert-kind-e2e.yml')) as {
  on: { pull_request: { paths: string[] } };
};

interface PodContainer {
  env?: Array<{ name: string; value?: string }>;
  ports?: Array<{ containerPort: number }>;
}
interface FixtureDeployment {
  kind: string;
  metadata: { name: string };
  spec: {
    template: {
      metadata: { labels: Record<string, string> };
      spec: { containers: PodContainer[] };
    };
  };
}

const DEPLOYMENTS = parseAllDocuments(FIXTURE_APP)
  .map((d) => d.toJS() as FixtureDeployment)
  .filter((d) => d?.kind === 'Deployment');

const containerOf = (name: string): PodContainer => {
  const d = DEPLOYMENTS.find((x) => x.metadata.name === name);
  if (!d) throw new Error(`the fixture has no Deployment named ${name}`);
  return d.spec.template.spec.containers[0] as PodContainer;
};
const envNames = (c: PodContainer) => (c.env ?? []).map((e) => e.name);
const envValue = (c: PodContainer, n: string) => c.env?.find((e) => e.name === n)?.value;

// Down (tracing on and off), waking, and up. Every non-first arm is the default
// install: the OTEL_* variables are absent.
const ARMS = ['e2e-app', 'e2e-app-notracing', 'e2e-app-waking', 'e2e-app-up'];
const TRACING_OFF_ARMS = ARMS.slice(1);

describe('deep-health e2e: both tracing arms are deployed', () => {
  it('the tracing-ON arm turns tracing on; the tracing-OFF arm is the DEFAULT install', () => {
    expect(envValue(containerOf('e2e-app'), 'OTEL_TRACING_ENABLED')).toBe('true');
    // "default install" = the variable is ABSENT. Setting it to "false" would be a
    // different (and unreachable) shape: the operator sets it only from the CR.
    for (const name of TRACING_OFF_ARMS) {
      expect(
        envNames(containerOf(name)).filter((n) => n.startsWith('OTEL_')),
        name,
      ).toEqual([]);
    }
  });

  it('each state is reached the way a real install reaches it', () => {
    // down: refused connection to a bring-your-own host
    expect(envValue(containerOf('e2e-app-notracing'), 'DATABASE_URL')).toMatch(/127\.0\.0\.1:1\//);
    // waking: a refusal on a database declared scale-to-zero reads `waking`
    expect(envValue(containerOf('e2e-app-waking'), 'KNEXT_DB_SCALE_TO_ZERO')).toBe('true');
    expect(envValue(containerOf('e2e-app-waking'), 'DATABASE_URL')).toMatch(/127\.0\.0\.1:1\//);
    // up: a REAL Postgres, not a stub, pinned by digest
    expect(envValue(containerOf('e2e-app-up'), 'DATABASE_URL')).toMatch(/@e2e-postgres[.:/]/);
    expect(FIXTURE_APP).toMatch(/image: postgres:[\w.-]+@sha256:[0-9a-f]{64}/);
  });

  it('both arms take their ports from the pod spec and declare the scraped one', () => {
    for (const name of ARMS) {
      const c = containerOf(name);
      const declared = (c.ports ?? []).map((p) => String(p.containerPort));
      for (const envName of ['PORT', 'METRICS_PORT']) {
        const v = envValue(c, envName);
        expect(v, `${name} ${envName}`).toBeDefined();
        expect(declared, `${name} declares ${envName}=${v}`).toContain(v as string);
      }
      expect(envValue(c, 'METRICS_PORT')).toBe('9464');
      // The loopback port is the pod spec's too, so no script below hardcodes it.
      expect(envValue(c, 'KN_CHILD_METRICS_PORT'), `${name} KN_CHILD_METRICS_PORT`).toBeDefined();
    }
  });

  it('every app arm carries the labels the shipped PodMonitor selects', () => {
    for (const name of ARMS) {
      const d = DEPLOYMENTS.find((x) => x.metadata.name === name) as FixtureDeployment;
      expect(d.spec.template.metadata.labels['generated-by']).toBe('kn-next-operator');
      expect(d.spec.template.metadata.labels.app).toBe(name);
      expect(envValue(containerOf(name), 'KN_APP_NAME')).toBe(name);
    }
  });

  it("the fixture runs the reference app's REAL register(), so the arm is chosen by env alone", () => {
    expect(FIXTURE_TS).toMatch(/from '\.\.\/src\/instrumentation'/);
    expect(FIXTURE_TS).toMatch(/await register\(\)/);
    expect(FIXTURE_TS).toMatch(/NEXT_RUNTIME/);
    // registerNode() called directly would make the OFF arm a copy of the ON arm.
    expect(FIXTURE_TS).not.toMatch(/registerNode\(\)/);
    // a port has no in-code default
    expect(FIXTURE_TS).not.toMatch(/\?\?\s*\d{4}/);
  });

  it('the script waits for both arms, and the assertions run against both', () => {
    const waited = /for deploy in ([^;]+); do/.exec(SCRIPT)?.[1] ?? '';
    for (const name of ARMS.concat('e2e-postgres')) {
      expect(waited.split(/\s+/), `the script does not wait for ${name}`).toContain(name);
    }
    for (const name of ARMS) expect(ASSERT, name).toContain(`'${name}'`);
    expect(ASSERT).toMatch(/expect: 'waking'/);
    expect(ASSERT).toMatch(/expect: 'up'/);
    expect(ASSERT).toMatch(/Promise\.all\(/);
  });

  it('no script in the lane hardcodes the loopback port', () => {
    expect(ASSERT).not.toMatch(/\b9092\b/);
    expect(SCRIPT).not.toMatch(/\b9092\b/);
    expect(FIXTURE_TS).not.toMatch(/\b9092\b/);
  });
});

describe('deep-health e2e: the idle drop and the tracing-off source are proved, not assumed', () => {
  it('asserts the series is gone from the scraped port once the app is idle', () => {
    expect(ASSERT).toMatch(/series is DROPPED while the app is idle/);
    expect(ASSERT).toMatch(/length === 0/);
  });

  it('asserts the alert resolves, and that an idle app never goes pending on the sibling', () => {
    expect(ASSERT).toMatch(/RESOLVES once the app is idle/);
    expect(ASSERT).toMatch(/down: 'KnextDeepHealthDown'/);
    expect(ASSERT).toMatch(/idle app never makes KnextDeepHealthStuckWaking/);
  });

  it('asserts the up and waking readings, not only down', () => {
    expect(ASSERT).toMatch(/state="ok"/);
    expect(ASSERT).toMatch(/dependency="postgres",state="up"/);
    expect(ASSERT).toMatch(/dependency="overall",state="waking"/);
    expect(ASSERT).toMatch(/waking: 'KnextDeepHealthStuckWaking'/);
    expect(ASSERT).toMatch(/is FIRING/);
  });

  it('asserts the series COMES BACK when traffic resumes (the drop is not a latch)', () => {
    expect(ASSERT).toMatch(/series returns when the app is used again/);
  });

  it('reads the loopback registry from INSIDE the pod to tell the arms apart', () => {
    // With tracing on the loopback port serves the whole prom-client registry;
    // with it off it serves the deep-health family and nothing else. That is what
    // shows the off arm's series came from the lite module.
    expect(ASSERT).toMatch(/KN_CHILD_METRICS_PORT/);
    expect(ASSERT).toMatch(/knext_http_requests_total/);
  });

  it('the lane runs on PRs that touch the lite module and the instrumentation entries', () => {
    const paths = WORKFLOW.on.pull_request.paths;
    for (const needle of [
      'packages/kn-next/src/adapters/deep-health-lite.ts',
      'packages/kn-next/templates/app/src/instrumentation.ts.hbs',
      'apps/file-manager/src/instrumentation.ts',
    ]) {
      expect(paths, `the lane would not run when ${needle} changes`).toContain(needle);
    }
  });
});

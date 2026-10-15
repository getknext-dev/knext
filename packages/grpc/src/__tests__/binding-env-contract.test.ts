/**
 * The zone binding env is a contract between the operator, which RENDERS it
 * into the zone, and the zone runtime, which READS it. One shared fixture
 * (packages/kn-next-operator/internal/controller/testdata/zone-binding-env.json)
 * is asserted on both sides: the operator's Go test proves it renders exactly
 * this env from these bindings; this test proves the generated client's name
 * derivation finds every variable the operator renders, and that the wake list
 * resolves through `<NAME>_SERVICE_URL` the way the process-start primer will.
 * Changing the derivation on either side alone reds the other side's test.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { urlEnvFor } from '../config';

interface FixtureBinding {
  name: string;
  service: string;
  state: string;
  servedProtoVersion: string;
  wakeAhead: boolean;
}

interface Fixture {
  namespace: string;
  cases: { name: string; bindings: FixtureBinding[]; env: Record<string, string> }[];
}

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'kn-next-operator',
  'internal',
  'controller',
  'testdata',
  'zone-binding-env.json',
);

const WAKE_FUNCTIONS_ENV = 'KNEXT_WAKE_FUNCTIONS';

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture;

// TODO(#2050): use the exported `protoVersionEnvFor` once the gateway glue
// lands; until then the suffix is the operator's constant, spelled once here.
function protoVersionEnv(name: string): string {
  return urlEnvFor(name).replace(/_SERVICE_URL$/, '_SERVICE_PROTO_VERSION');
}

describe('zone binding env: the generated client reads what the operator renders', () => {
  it('covers several cases', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(4);
  });

  for (const c of fixture.cases) {
    it(c.name, () => {
      const accounted = new Set<string>();
      for (const b of c.bindings) {
        const url = urlEnvFor(b.name);
        if (b.state !== 'Bound') {
          // A one-sided or cross-zone entry renders nothing at all.
          expect(c.env[url]).toBeUndefined();
          continue;
        }
        expect(c.env[url]).toBe(`http://${b.service}.${fixture.namespace}.svc.cluster.local`);
        accounted.add(url);
        const version = protoVersionEnv(b.name);
        if (b.servedProtoVersion === '') {
          // Unset until the function serves: the gateway fails closed.
          expect(c.env[version]).toBeUndefined();
        } else {
          expect(c.env[version]).toBe(b.servedProtoVersion);
          accounted.add(version);
        }
      }

      // The wake list: binding names, each resolved through <NAME>_SERVICE_URL.
      // TODO(#2054): the core process-start primer asserts this same fixture.
      const wake = c.env[WAKE_FUNCTIONS_ENV];
      const wanted = c.bindings
        .filter((b) => b.state === 'Bound' && b.wakeAhead)
        .map((b) => b.name)
        .sort();
      if (wanted.length === 0) {
        expect(wake).toBeUndefined();
      } else {
        expect(wake?.split(',')).toEqual(wanted);
        for (const name of wake?.split(',') ?? []) {
          expect(c.env[urlEnvFor(name)]).toBeDefined();
        }
        accounted.add(WAKE_FUNCTIONS_ENV);
      }

      // Nothing the operator renders is unexplained by the derivation.
      expect(Object.keys(c.env).sort()).toEqual([...accounted].sort());
    });
  }
});

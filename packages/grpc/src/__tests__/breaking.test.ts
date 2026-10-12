import { afterAll, describe, expect, it } from 'bun:test';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type DeployedBaselineSource, resolveBaseline } from '../baseline';
import { runGenerate } from '../generate';
import { capture, copyFixtureZone, emptyDir, removeScratchDirs } from './helpers';

afterAll(removeScratchDirs);

/** A baseline directory: a copy of the fixture's contract as it is now. */
function baselineOf(zone: string): string {
  const base = emptyDir('baseline');
  cpSync(join(zone, 'proto'), join(base, 'proto'), { recursive: true });
  cpSync(join(zone, 'buf.yaml'), join(base, 'buf.yaml'));
  return base;
}

function removeTotalCents(zone: string): void {
  const proto = join(zone, 'proto/orders/v1/orders.proto');
  const before = readFileSync(proto, 'utf8');
  const after = before.replace('  int64 total_cents = 3;\n', '');
  expect(after).not.toBe(before);
  writeFileSync(proto, after);
}

describe('knext generate --against — buf breaking against a baseline', () => {
  it('passes when nothing breaking changed', async () => {
    const zone = copyFixtureZone('brk-same');
    const c = capture();
    expect(
      await runGenerate({ cwd: zone, check: true, against: baselineOf(zone), io: c.io }),
      c.err(),
    ).toBe(0);
  });

  it('REDS when a field is removed', async () => {
    const zone = copyFixtureZone('brk-removed');
    const baseline = baselineOf(zone);
    removeTotalCents(zone);
    // Regenerate first, so the only thing that can red is the breaking check.
    expect(await runGenerate({ cwd: zone, io: capture().io })).toBe(0);
    const c = capture();
    expect(await runGenerate({ cwd: zone, check: true, against: baseline, io: c.io })).toBe(1);
    expect(c.err()).toContain('buf breaking');
    expect(c.err()).toContain('total_cents');
  });

  it('REDS when a field is removed even without --check', async () => {
    const zone = copyFixtureZone('brk-write');
    const baseline = baselineOf(zone);
    removeTotalCents(zone);
    const c = capture();
    expect(await runGenerate({ cwd: zone, against: baseline, io: c.io })).toBe(1);
    expect(c.err()).toContain('total_cents');
  });

  it('accepts an additive change (a new field)', async () => {
    const zone = copyFixtureZone('brk-additive');
    const baseline = baselineOf(zone);
    const proto = join(zone, 'proto/orders/v1/orders.proto');
    writeFileSync(
      proto,
      readFileSync(proto, 'utf8').replace(
        '  int64 total_cents = 3;\n',
        '  int64 total_cents = 3;\n  string currency = 4;\n',
      ),
    );
    expect(await runGenerate({ cwd: zone, io: capture().io })).toBe(0);
    const c = capture();
    expect(
      await runGenerate({ cwd: zone, check: true, against: baseline, io: c.io }),
      c.err(),
    ).toBe(0);
  });
});

describe('baseline resolution — the deployed-baseline seam', () => {
  it('passes a file or git baseline through to buf unchanged', async () => {
    expect(await resolveBaseline('../baseline')).toEqual('../baseline');
    expect(await resolveBaseline('.git#branch=main,subdir=proto')).toEqual(
      '.git#branch=main,subdir=proto',
    );
  });

  it('routes deployed:<namespace>/<name> through the deployed-baseline source', async () => {
    const seen: string[] = [];
    const source: DeployedBaselineSource = {
      async resolve(ref) {
        seen.push(`${ref.namespace}/${ref.name}`);
        return '/tmp/deployed-image.binpb';
      },
    };
    expect(await resolveBaseline('deployed:shop/orders', source)).toBe('/tmp/deployed-image.binpb');
    expect(seen).toEqual(['shop/orders']);
  });

  it('without a source, a deployed baseline fails with a clear message, never a silent pass', async () => {
    await expect(resolveBaseline('deployed:shop/orders')).rejects.toThrow(
      /deployed contract .* not available yet/,
    );
    const zone = copyFixtureZone('brk-deployed');
    const c = capture();
    expect(
      await runGenerate({ cwd: zone, check: true, against: 'deployed:shop/orders', io: c.io }),
    ).toBe(1);
    expect(c.err()).toContain('not available yet');
  });

  it('rejects a malformed deployed reference', async () => {
    await expect(resolveBaseline('deployed:orders')).rejects.toThrow(
      /deployed:<namespace>\/<name>/,
    );
  });
});

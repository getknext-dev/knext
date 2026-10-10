import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PRE_MODE_TAGS, PUBLISH_LANES } from '../scripts/publish-lane-guard.mjs';

/**
 * PIN (#2038, v2 task R3a): `integration/v2` publishes in changesets PRE MODE on
 * the `next` dist-tag, over the fixed group.
 *
 * This file lands on `integration/v2` only. Pre mode on `main` would route every
 * main publish to a prerelease tag, so `main` must never carry `pre.json`; the
 * 2.0 GA merge runs `changeset pre exit` first.
 *
 * Modelled on `tests/ensure-published-group.test.ts`: the group is read from
 * `.changeset/config.json`, never re-listed beyond the one pinned expectation.
 *
 * Note for readers: changesets names pre-releases `<version>-<tag>.<n>`, so tag
 * `next` yields `2.0.0-next.N`. The rc.N names in the v2 plan are not produced by
 * pre mode; see the PR body.
 */

const ROOT = resolve(import.meta.dirname, '..');
const readJson = (rel: string) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

const pre = readJson('.changeset/pre.json');
const config = readJson('.changeset/config.json');
const fixed: string[] = (config.fixed ?? []).flat();

/** name -> {private} for every manifest under packages/ */
function workspace(): Map<string, { private: boolean }> {
  const out = new Map<string, { private: boolean }>();
  for (const d of readdirSync(join(ROOT, 'packages'), { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    let pj: { name?: string; private?: boolean };
    try {
      pj = readJson(`packages/${d.name}/package.json`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw e;
    }
    if (pj.name) out.set(pj.name, { private: pj.private === true });
  }
  return out;
}

describe('integration/v2 is in changesets pre mode on the next tag (#2038)', () => {
  it('pre.json says mode "pre" and tag "next"', () => {
    expect(pre.mode).toBe('pre');
    expect(pre.tag).toBe('next');
  });

  it('pre.json agrees with the tag the publish-lane guard requires for integration/v2', () => {
    expect(PRE_MODE_TAGS.get('refs/heads/integration/v2')).toBe(pre.tag);
    expect(PUBLISH_LANES.get('refs/heads/integration/v2')).toBe(2);
  });

  it('the fixed group is exactly the four publishable members', () => {
    expect([...fixed].sort()).toEqual(
      ['@getknext/core', '@getknext/db', '@getknext/lib', 'kn-next'].sort(),
    );
  });

  it('every fixed member resolves to a workspace package, so pre mode versions all of it', () => {
    const ws = workspace();
    for (const name of fixed) expect(ws.has(name), `${name} is not a workspace package`).toBe(true);
  });

  it('config.json still keeps the private apps out of the publish set', () => {
    expect(config.ignore).toContain('@getknext/ui');
  });

  // Dormant until @getknext/grpc lands (Z-series). The package set is
  // {core, lib, db, grpc} and grpc versions INDEPENDENTLY with a peer range on
  // core (ADR-0020 amendment, Q20): publishable, but OUTSIDE the fixed group.
  const grpc = workspace().get('@getknext/grpc');
  (grpc ? it : it.skip)(
    '@getknext/grpc, once it exists, is publishable and outside the fixed group',
    () => {
      expect(grpc?.private).toBe(false);
      expect(fixed).not.toContain('@getknext/grpc');
      expect(config.ignore ?? []).not.toContain('@getknext/grpc');
    },
  );
});

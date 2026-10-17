import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * GUARD for what we say about the zone's image pin (`backends[].image`).
 *
 * The pin binds the IMAGE CONTENT only. The BackendService's env, envFrom,
 * volumes and command/args stay with whoever can write it, so a writer who
 * keeps the pinned digest can still change what runs inside the image (a
 * `NODE_OPTIONS=--import=...` in `env` runs their code with the zone's database
 * Secret mounted). So `update` on `backendservices` stays equivalent to reading
 * the zone's database Secret, pinned or not.
 *
 * An earlier wording said the pin "closes" that exposure. It does not, and a
 * security claim that overstates its control is worse than none. This guard
 * keeps the wording honest in every place a user or an operator reads it:
 *
 *   1. no user-facing text may say the pin closes / fixes / prevents the
 *      database-Secret or token exposure (a sentence scan, with a self-test so
 *      the scanner is proved to see the old wording);
 *   2. every user-facing place must state the caveat: the pin binds the image
 *      only, and env, envFrom and volumes stay with the writer;
 *   3. the guidance to grant update/patch/create only to people who may read the
 *      Secret must say it still applies after pinning;
 *   4. the status message a refused function carries must not claim the Secret
 *      is safe.
 */

const ROOT = resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/** The comment block above `Image string` in BackendBinding, as prose. */
function goFieldDoc(): string {
  const src = read('packages/kn-next-operator/api/v1alpha1/nextapp_types.go');
  const start = src.indexOf('// Image pins the function image');
  const end = src.indexOf('Image string `json:"image,omitempty"`');
  if (start < 0 || end < 0) throw new Error('BackendBinding.Image doc not found');
  return src
    .slice(start, end)
    .split('\n')
    .map((l) => l.replace(/^\s*\/\/ ?/, ''))
    .filter((l) => !l.startsWith('+'))
    .join('\n');
}

/** The generated CRD description of the same field. */
function crdFieldDoc(): string {
  const src = read('packages/kn-next-operator/config/crd/bases/apps.kn-next.dev_nextapps.yaml');
  const start = src.indexOf('Image pins the function image');
  const end = src.indexOf('maxLength: 72', start);
  if (start < 0 || end < 0) throw new Error('CRD backends[].image description not found');
  return src.slice(start, end);
}

/** The JSDoc above `image?: string` in BackendBindingConfig. */
function configFieldDoc(): string {
  const src = read('packages/kn-next/src/config.ts');
  const start = src.indexOf('Pins the function image this app agreed to bind');
  const end = src.indexOf('image?: string;', start);
  if (start < 0 || end < 0) throw new Error('BackendBindingConfig.image doc not found');
  return src
    .slice(start, end)
    .split('\n')
    .map((l) => l.replace(/^\s*\*+\/?\s?/, ''))
    .join('\n');
}

/** The pin-mismatch message, from the Go source of imagePinMismatch. */
function statusMessage(): string {
  const src = read('packages/kn-next-operator/internal/controller/backendservice_sovereignty.go');
  const start = src.indexOf('func imagePinMismatch');
  if (start < 0) throw new Error('imagePinMismatch not found');
  return src.slice(start);
}

/** The zone-functions page, the pin section only. */
function docsPinSection(): string {
  const src = read('apps/docs/content/docs/zone-functions.mdx');
  const start = src.indexOf('### Pin the function');
  const end = src.indexOf('## What the zone receives');
  if (start < 0 || end < 0) throw new Error('pin section not found');
  return src.slice(start, end);
}

const CLOSING =
  /\b(close|closes|closed|closing|eliminates?|fixes|fixed|solves?|prevents?|removes? the (?:risk|exposure))\b/i;
const TARGET = /(database secret|db-bind|exposure|users' tokens|confused deputy|equivalent to)/i;
const NEGATED =
  /\b(not|never|cannot|can't|doesn't|does not|only|narrows?|still|neither|nor)\b|n't/i;

/** Sentences that claim the pin closes the exposure and say nothing against it. */
function overclaims(text: string): string[] {
  const flat = text.replace(/\s+/g, ' ');
  return flat
    .split(/(?<=[.!?])\s+/)
    .filter((s) => /\bpin(?:s|ned|ning)?\b/i.test(s) && CLOSING.test(s) && TARGET.test(s))
    .filter((s) => !NEGATED.test(s));
}

describe('the scanner sees the wording we removed', () => {
  const OLD = [
    "To close it, put the function's image digest in the zone's entry.",
    'Pin the image to close that.',
    'Pinning closes the exposure to the database Secret.',
    'Set it to close that: the pin fixes the db-bind confused deputy.',
    '`update` on `backendservices` is equivalent to reading the Secret, until the zone pins the image, which eliminates the exposure.',
  ];
  it('flags each old-style claim (or the claim form it takes)', () => {
    // The first two sentences name no target on their own; they are caught by
    // the paragraph they sat in. Assert on the ones that carry both halves, and
    // that the paragraph form is caught.
    expect(overclaims(OLD[2] as string)).toHaveLength(1);
    expect(overclaims(OLD[3] as string)).toHaveLength(1);
    expect(overclaims(OLD[4] as string)).toHaveLength(1);
    expect(
      overclaims(
        'Without more, anyone who may update can swap the image and read your database Secret. Pinning the image closes it.',
      ).length + overclaims('The pin closes the database Secret exposure.').length,
    ).toBeGreaterThan(0);
  });
  it('does not flag the corrected wording', () => {
    expect(
      overclaims('The pin does not close the database Secret exposure: it binds the image only.'),
    ).toEqual([]);
    expect(overclaims('Pinning the image narrows this, but does not remove it.')).toEqual([]);
  });
});

const PLACES: [string, () => string][] = [
  ['the zone-functions docs page', () => read('apps/docs/content/docs/zone-functions.mdx')],
  ['the CLI reference', () => read('apps/docs/content/docs/cli.mdx')],
  ['the operator reference', () => read('apps/docs/content/docs/operator.mdx')],
  ['the CRD field doc in the Go types', goFieldDoc],
  ['the generated CRD description', crdFieldDoc],
  ['the config.ts field doc', configFieldDoc],
  ['the changeset', () => read('.changeset/zone-function-image-pin.md')],
  ['the operator status message', statusMessage],
  ['the threat model', () => read('docs/security/threat-model.md')],
  ['ADR-0004', () => read('docs/adr/0004-backend-service-crd.md')],
];

describe('no place says the image pin closes the database-Secret exposure', () => {
  for (const [label, get] of PLACES) {
    it(label, () => {
      expect(overclaims(get())).toEqual([]);
    });
  }

  it('the old "until you pin the image" framing is gone', () => {
    const docs = read('apps/docs/content/docs/zone-functions.mdx');
    expect(docs).not.toMatch(/until (you|the zone) pins? the (function's )?image/i);
    expect(docs).not.toMatch(/To close it, put the function's image digest/);
    const tm = read('docs/security/threat-model.md');
    expect(tm).not.toMatch(/until the zone pins the\s+function's image/);
  });
});

describe('every user-facing place states the caveat', () => {
  const USER_FACING: [string, () => string][] = [
    ['the zone-functions pin section', docsPinSection],
    ['the CRD field doc in the Go types', goFieldDoc],
    ['the generated CRD description', crdFieldDoc],
    ['the config.ts field doc', configFieldDoc],
    ['the changeset', () => read('.changeset/zone-function-image-pin.md')],
  ];
  for (const [label, get] of USER_FACING) {
    it(`${label}: the pin binds the image only; env, envFrom and volumes stay with the writer`, () => {
      const text = get().replace(/\s+/g, ' ');
      expect(text).toMatch(/binds the image content(?:,)? (?:only|and nothing else)/i);
      expect(text).toMatch(/\benv\b/);
      expect(text).toMatch(/\benvFrom\b/);
      expect(text).toMatch(/volumes/);
    });
    it(`${label}: update, patch and create on backendservices only for people who may read the Secret, pinned or not`, () => {
      const text = get().replace(/\s+/g, ' ');
      expect(text).toMatch(/`?update`?, `?patch`? and `?create`? on\s+`?backendservices`?/i);
      expect(text).toMatch(/already read/i);
      expect(text).toMatch(/pinned or not|even with a pin|still applies/i);
    });
  }

  it('the docs page names the concrete env example', () => {
    expect(docsPinSection()).toContain('NODE_OPTIONS');
  });

  it('the docs page keeps no issue, PR or ADR numbers', () => {
    const docs = read('apps/docs/content/docs/zone-functions.mdx');
    expect(docs).not.toMatch(/#\d{3,}|ADR-\d+/);
  });
});

describe('the internal docs state residual (e) and cite the fix', () => {
  it('the threat model says the pin binds the image only and cites #2526', () => {
    const tm = read('docs/security/threat-model.md').replace(/\s+/g, ' ');
    expect(tm).toMatch(/pin binds the image content only/i);
    expect(tm).toContain('NODE_OPTIONS');
    expect(tm).toContain('#2526');
  });
  it('ADR-0004 Amendment 3 records residual (e)', () => {
    const adr = read('docs/adr/0004-backend-service-crd.md');
    const amendment = adr.slice(adr.indexOf('## Amendment 3'));
    expect(amendment.replace(/\s+/g, ' ')).toMatch(/\(e\) \*\*The pin binds the image only/);
    expect(amendment).toContain('#2526');
  });
});

describe('the status message of a refused function makes no safety claim about the Secret', () => {
  it('says what to do, not that the Secret is safe', () => {
    const msg = statusMessage().slice(0, statusMessage().indexOf('\n}\n'));
    expect(msg).not.toMatch(/database Secret/i);
    expect(msg).not.toMatch(/reach no image/i);
    expect(msg).toContain('backends[].image pin');
  });
});

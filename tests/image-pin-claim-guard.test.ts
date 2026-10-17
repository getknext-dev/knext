import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * GUARD for what we say about the zone's image pin (`backends[].image`).
 *
 * The pin binds the IMAGE CONTENT only. The BackendService's env, envFrom,
 * volumes stay with whoever can write it, so a writer who
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

/**
 * The claim scanner. A sentence over-claims when, in order:
 *   - it talks about the pin (pin, pins, pinned, pinning), AND
 *   - one CLAUSE of it has a verb of protection or closure (close, fix, prevent, protect,
 *     secure, safe, stop, guarantee, eliminate, "keeps ... from", "no longer"), AND
 *   - it names the thing protected (the database Secret, db-bind, the exposure,
 *     users' tokens, the confused deputy) or points at it ("that", "this", "it"),
 * UNLESS a negation or limiter (not, never, only, still, narrows, cannot) sits in
 * the SAME clause as the claim verb. A negation elsewhere in the sentence does
 * not rescue it: "Pinning protects the database Secret, and it is not slow" is a
 * claim. Clauses are cut at , ; : and at "but", "while", "although", "and".
 *
 * It is a net, not a proof: it catches the wordings this repo has had and a
 * corpus of paraphrases (below, every one asserted). The positive checks (the
 * caveat must be present in every place) are the part that cannot be reworded
 * away.
 */
const PIN_TERM = /\b(?:pin(?:s|ned|ning)?|image digest)\b/i;
const CLAIM_VERB =
  /\b(?:close[sd]?(?!\s+(?:review|meeting))|closing|eliminat\w+|fix(?:es|ed)?|solv\w+|prevent\w*|protect\w*|secur(?:e|es|ed|ing)|safe(?:ly|guard\w*)?|stop(?:s|ped)?|guarantee\w*|remov(?:e|es|ed) the (?:risk|exposure))\b|\bkeeps?\b[^,;:]*\bfrom\b|\bno longer\b/i;
const TARGET =
  /\b(?:database secret|db-bind|exposure|users' tokens|confused deputy|equivalent to|that|this|it|them)\b/i;
const LIMITER = /\b(?:not|never|cannot|can't|narrows?|neither|nor)\b|n't/i;

function claimClauses(sentence: string): string[] {
  return sentence.split(/[,;:—|]|\s(?:but|while|although)\s/i);
}

function overclaims(text: string): string[] {
  const flat = text
    .replace(/[*`]/g, '')
    .replace(/fail(?:s|ed)? closed/gi, 'fail-shut')
    .replace(/\s+/g, ' ');
  return flat.split(/(?<=[.!?])\s+/).filter((s) => {
    if (!PIN_TERM.test(s)) return false;
    // A claim verb in a clause with no limiter in that clause.
    return claimClauses(s).some((c) => CLAIM_VERB.test(c) && TARGET.test(c) && !LIMITER.test(c));
  });
}

describe('the scanner sees the wording we removed and its paraphrases', () => {
  // The sentences that were in the docs and were corrected: each must be flagged.
  const OLD = [
    "To close it, put the function's image digest in the zone's entry.",
    'Pin the image to close that.',
    'Pinning closes the exposure to the database Secret.',
    'Set it to close that: the pin fixes the db-bind confused deputy.',
    '`update` on `backendservices` is equivalent to reading the Secret, until the zone pins the image, which eliminates the exposure.',
  ];
  // Rewordings a careless edit could produce: each must be flagged too.
  const PARAPHRASES = [
    'Pinning protects the database Secret.',
    'Pinning protects the database Secret from any change.',
    'The pin secures the db-bind Secret against a bad actor.',
    'With a pin, the database Secret is safe.',
    'A pinned function keeps the database Secret safe from writers.',
    'The pin keeps writers away from the database Secret, so the exposure is gone, and it is cheap.',
    'The pin stops the exposure.',
    'Once the image is pinned the confused deputy is prevented.',
    'The pin guarantees the database Secret reaches only the agreed image.',
    "With the pin, a writer can no longer reach the users' tokens.",
    'Pinning the image fixes this.',
    'Pin it and the problem is solved.',
    'The pin prevents the exposure, which is not slow.',
  ];
  for (const sentence of [...OLD, ...PARAPHRASES]) {
    it(`flags: ${sentence}`, () => {
      expect(overclaims(sentence), sentence).toHaveLength(1);
    });
  }

  it('does not flag the corrected wording (a limiter in the same clause)', () => {
    for (const ok of [
      'The pin does not close the database Secret exposure: it binds the image only.',
      'Pinning the image narrows this, but does not remove it.',
      'A pin does not stop that.',
      "The pin protects against a swapped image, not against a writer who changes the function's settings.",
      'The pin cannot protect the database Secret from a writer of env.',
      'Pinning only stops an image swap.',
    ]) {
      expect(overclaims(ok), ok).toEqual([]);
    }
  });

  it('a limiter in ANOTHER clause does not rescue a claim', () => {
    expect(overclaims('Pinning protects the database Secret, and it is not slow.')).toHaveLength(1);
  });
});

/** Lines of `text` that mention `needle` (a table row or a paragraph of a long page). */
const linesWith = (text: string, needle: string) =>
  text
    .split('\n')
    .filter((l) => l.includes(needle))
    .join('\n');
/** From the heading that starts with `start` to the next heading of the same or higher level. */
function section(text: string, start: string): string {
  const i = text.indexOf(start);
  if (i < 0) throw new Error(`section not found: ${start}`);
  const level = start.match(/^#+/)?.[0].length ?? 2;
  const rest = text.slice(i + start.length);
  const next = rest.search(new RegExp(`^#{1,${level}} `, 'm'));
  return text.slice(i, next < 0 ? undefined : i + start.length + next);
}

// Pages that talk about other kinds of pinning (base images, revisions) are
// scanned only where the image pin is discussed, so the scan stays about the
// claim and not about the word.
const PLACES: [string, () => string][] = [
  ['the zone-functions docs page', () => read('apps/docs/content/docs/zone-functions.mdx')],
  ['the CLI reference', () => linesWith(read('apps/docs/content/docs/cli.mdx'), 'pin')],
  [
    'the operator reference',
    () => linesWith(read('apps/docs/content/docs/operator.mdx'), '`backends`'),
  ],
  [
    'the user threat model page',
    () => linesWith(read('apps/docs/content/docs/threat-model.mdx'), 'backendservices'),
  ],
  ['the CRD field doc in the Go types', goFieldDoc],
  ['the generated CRD description', crdFieldDoc],
  ['the config.ts field doc', configFieldDoc],
  ['the changeset', () => read('.changeset/zone-function-image-pin.md')],
  ['the operator status message', statusMessage],
  [
    'the threat model',
    () => section(read('docs/security/threat-model.md'), '### Zone-function binding'),
  ],
  [
    'ADR-0004 Amendment 3',
    () => section(read('docs/adr/0004-backend-service-crd.md'), '## Amendment 3'),
  ],
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
    ['the user threat model page', () => read('apps/docs/content/docs/threat-model.mdx')],
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

  it('the user threat model page links to the caveat section, and that anchor exists', () => {
    const page = read('apps/docs/content/docs/threat-model.mdx');
    expect(page).toContain('/docs/zone-functions#what-the-pin-does-not-cover');
    expect(read('apps/docs/content/docs/zone-functions.mdx')).toMatch(
      /^#{2,4} What the pin does not cover$/m,
    );
  });

  it('the threat model row ties the equivalence to "pinned or not", with no numbers', () => {
    const page = read('apps/docs/content/docs/threat-model.mdx').replace(/\s+/g, ' ');
    expect(page).toMatch(
      /equivalent to permission to read the zone's database Secret, pinned or not/,
    );
    expect(page).not.toMatch(/#2\d{3}/);
  });

  it('the deploy function hint carries the env caveat', () => {
    const src = read('packages/grpc/src/deploy-function.ts').replace(/\s+/g, ' ');
    expect(src).toMatch(/pin binds the image only/);
    expect(src).toMatch(/env, envFrom and volumes/);
  });

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

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
 * security claim that overstates its control is worse than none.
 *
 * THE SPEC PIN (`backends[].specDigest`) is different, and the docs may now say
 * so: it binds the image AND env, envFrom and volumes, so for a zone that sets
 * it the BackendService route to the database Secret IS closed. What that claim
 * may and may not say is bounded here too: a sentence about the spec pin that
 * claims protection must be scoped to the BackendService route (not "the Secret
 * is safe"), and every place that makes it must state what remains (the contents
 * of the objects the spec names, the settings outside the digest). A sentence
 * that mentions BOTH the image pin and the spec pin is still read as an
 * image-pin sentence: the image-only pin never closes anything.
 *
 * This guard keeps the wording honest in every place a user or an operator reads it:
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

/** The comment block above `SpecDigest string` in BackendBinding, as prose. */
function goSpecFieldDoc(): string {
  const src = read('packages/kn-next-operator/api/v1alpha1/nextapp_types.go');
  const start = src.indexOf('// SpecDigest pins the whole security-relevant spec');
  const end = src.indexOf('SpecDigest string `json:"specDigest,omitempty"`');
  if (start < 0 || end < 0) throw new Error('BackendBinding.SpecDigest doc not found');
  return src
    .slice(start, end)
    .split('\n')
    .map((l) => l.replace(/^\s*\/\/ ?/, ''))
    .filter((l) => !l.startsWith('+'))
    .join('\n');
}

/** The generated CRD description of the same field. */
function crdSpecFieldDoc(): string {
  const src = read('packages/kn-next-operator/config/crd/bases/apps.kn-next.dev_nextapps.yaml');
  const start = src.indexOf('SpecDigest pins the whole security-relevant spec');
  const end = src.indexOf('maxLength: 71', start);
  if (start < 0 || end < 0) throw new Error('CRD backends[].specDigest description not found');
  return src.slice(start, end);
}

/** The JSDoc above `specDigest?: string` in BackendBindingConfig. */
function configSpecFieldDoc(): string {
  const src = read('packages/kn-next/src/config.ts');
  const start = src.indexOf('Pins the whole function spec this app agreed to bind');
  const end = src.indexOf('specDigest?: string;', start);
  if (start < 0 || end < 0) throw new Error('BackendBindingConfig.specDigest doc not found');
  return src
    .slice(start, end)
    .split('\n')
    .map((l) => l.replace(/^\s*\*+\/?\s?/, ''))
    .join('\n');
}

/** The spec-pin mismatch message, from the Go source of specPinMismatch. */
function specStatusMessage(): string {
  const src = read('packages/kn-next-operator/internal/controller/backendservice_spec_pin.go');
  const start = src.indexOf('func specPinMismatch');
  if (start < 0) throw new Error('specPinMismatch not found');
  return src.slice(start);
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
  const start = src.indexOf("### Pin the function's spec");
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
 * claim. Clauses are cut at , ; : — | and at "but", "while", "although" ("and" does not cut a
 * clause: a limiter before "and" still rescues a claim after it).
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
  /\b(?:database secret|secret|db-bind|exposure|users' tokens|confused deputy|equivalent to|that|this|it|them)\b/i;
const LIMITER = /\b(?:not|never|cannot|can't|narrows?|neither|nor)\b|n't/i;

/** A sentence about the SPEC pin. The image pin never closes anything, so a sentence that also names it is not exempt. */
const SPEC_PIN_TERM =
  /\b(?:specDigest|spec pin|spec digest|whole spec|pins? the (?:function's )?spec)\b/i;
const IMAGE_PIN_TERM =
  /\bimage[- ]pin\b|\bimage-only\b|\bpins? (?:only )?the image\b|\bpinn(?:ed|ing) (?:the )?image\b|\bpinned image\b|\b(?:an|the) `?image`? pin\b/i;
/** What a protection claim about the spec pin must be scoped to: the BackendService route. */
const SPEC_SCOPE =
  /\b(?:backendservices?|route|refus\w+|mismatch\w*|can no longer make|cannot make)\b/i;

const TO_CLOSE =
  /\b(?:set|enable|use|add|put|apply|configure)\b[^.]*\bto (?:close|fix|solve|eliminate|prevent|protect against) (?:it|that|this|the (?:exposure|risk|gap|problem))\b/i;

/** The scan entry point for text that must carry content: blank input is an error, not a clean bill. */
function scanText(text: string): string[] {
  if (text.trim().length === 0) throw new Error('nothing to scan');
  return overclaims(text);
}

function claimClauses(sentence: string): string[] {
  return sentence.split(/[,;:—|]|\s(?:but|while|although)\s/i);
}

function flatten(text: string): string[] {
  // A blank line ends a sentence too: headings, table rows and code carry no full stop,
  // and without this a claim appended after one is judged with its limiters.
  return text.split(/\n\s*\n/).flatMap((para) =>
    para
      .replace(/[*`]/g, '')
      .replace(/fail(?:s|ed)? closed/gi, 'fail-shut')
      .replace(/\s+/g, ' ')
      .split(/(?<=[.!?])\s+/),
  );
}

const isSpecOnly = (s: string) => SPEC_PIN_TERM.test(s) && !IMAGE_PIN_TERM.test(s);

/**
 * A sentence about the spec pin that claims protection without scoping it to the
 * BackendService route ("the spec pin makes the Secret safe"). The claim itself
 * is allowed; an unbounded one is not.
 */
function specOverclaims(text: string): string[] {
  return flatten(text).filter(
    (s) =>
      isSpecOnly(s) &&
      claimClauses(s).some((c) => CLAIM_VERB.test(c) && TARGET.test(c) && !LIMITER.test(c)) &&
      !SPEC_SCOPE.test(s),
  );
}

function overclaims(text: string): string[] {
  return flatten(text).filter((s) => {
    // The spec pin is judged by specOverclaims, not by the image-pin rules.
    if (isSpecOnly(s)) return false;
    // The imperative form names no pin ("Set it to close that."): "it" is the pin.
    if (TO_CLOSE.test(s) && !LIMITER.test(s)) return true;
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
    'Unset keeps the name-only binding: any image is bound, which means a writer can change what runs. Set it to close that.',
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

  // The spec pin may be said to close the BackendService route, scoped to it.
  it('allows a scoped claim about the spec pin, and still sees an unscoped one', () => {
    for (const ok of [
      'With the spec pin set, a writer of the BackendService can no longer make the function run their code with the Secret mounted.',
      'The spec pin closes that route: anything a writer changes is refused before it is mounted.',
      'For a zone that sets specDigest, update on backendservices is no longer equivalent to reading the database Secret.',
    ]) {
      expect(overclaims(ok), ok).toEqual([]);
      expect(specOverclaims(ok), ok).toEqual([]);
    }
    for (const bad of [
      'The spec pin makes the database Secret safe.',
      "specDigest protects your users' tokens.",
      'Setting the spec pin closes the exposure.',
      'With the spec pin the confused deputy is eliminated.',
      // A bare "writes"/"writers"/"update" is not a scope: it names no route.
      'The spec pin makes the Secret safe from writes.',
      'The spec pin keeps the database Secret safe from writers.',
      'With specDigest set, the Secret is protected on every update.',
    ]) {
      expect(specOverclaims(bad), bad).toHaveLength(1);
    }
  });

  it('an empty page fails rather than passes', () => {
    const empty = page('apps/docs/content/docs/does-not-exist.mdx');
    expect(() => empty()).toThrow();
    expect(() => PLACES[0][1]('')).not.toThrow();
    expect(() => scanText('   ')).toThrow();
  });

  it('a sentence that also names the image pin is still an image-pin sentence', () => {
    for (const bad of [
      'The image pin closes the exposure when specDigest is set.',
      'The image pin and the spec pin protect the database Secret.',
      'Pinning the image stops that, and so does the spec pin.',
    ]) {
      expect(overclaims(bad), bad).toHaveLength(1);
    }
  });
});

/** From the heading that starts with `start` to the next heading of the same or higher level. */
function section(text: string, start: string): string {
  const i = text.indexOf(start);
  if (i < 0) throw new Error(`section not found: ${start}`);
  const level = start.match(/^#+/)?.[0].length ?? 2;
  const rest = text.slice(i + start.length);
  const next = rest.search(new RegExp(`^#{1,${level}} `, 'm'));
  return text.slice(i, next < 0 ? undefined : i + start.length + next);
}

// Whole pages are scanned, case-insensitively: the scanner already needs a pin term,
// a claim verb and a target in one sentence, so false positives stay low, and a claim
// appended anywhere on a page is seen. `extra` is text appended to the page (the
// mutation rows below use it to prove no region of a page is unscanned).
const page =
  (path: string) =>
  (extra = '') => {
    const text = read(path) + extra;
    if (text.trim().length === 0) throw new Error(`empty page: ${path}`);
    return text;
  };
const OVERCLAIM = '\n\nPinning closes the exposure to the database Secret.\n';
const PLACES: [string, (extra?: string) => string][] = [
  ['the zone-functions docs page', page('apps/docs/content/docs/zone-functions.mdx')],
  ['the CLI reference', page('apps/docs/content/docs/cli.mdx')],
  ['the operator reference', page('apps/docs/content/docs/operator.mdx')],
  ['the user threat model page', page('apps/docs/content/docs/threat-model.mdx')],
  ['the CRD field doc in the Go types', (e = '') => goFieldDoc() + e],
  ['the generated CRD description', (e = '') => crdFieldDoc() + e],
  ['the config.ts field doc', (e = '') => configFieldDoc() + e],
  ['the changeset', page('.changeset/zone-function-image-pin.md')],
  ['the spec-pin changeset', page('.changeset/zone-function-spec-pin.md')],
  ['the SpecDigest field doc in the Go types', (e = '') => goSpecFieldDoc() + e],
  ['the generated CRD specDigest description', (e = '') => crdSpecFieldDoc() + e],
  ['the config.ts specDigest field doc', (e = '') => configSpecFieldDoc() + e],
  ['the operator status message', (e = '') => statusMessage() + e],
  ['the spec-pin status message', (e = '') => specStatusMessage() + e],
  ['the threat model', page('docs/security/threat-model.md')],
  ['ADR-0004', page('docs/adr/0004-backend-service-crd.md')],
];

// Whole-page scanning meets sentences that use the word "pin" about something else
// (a base-image tag, a build manifest). Each is exempt by its EXACT text, on its own
// page only, and the exemption fails if the sentence is gone or no longer needs it,
// so the list cannot rot into a blanket skip.
const EXEMPT: Record<string, string[]> = {
  'the operator reference': [
    'Install the operator per namespace or add your own admission policy for workloads to close that path.',
  ],
  'the user threat model page': [
    'That pulls only fixes already published on the same pinned Alpine branch — it cannot move the base to a different release.',
  ],
  'the threat model': [
    'The template Dockerfile therefore fails the build when the manifest is missing, which narrows the window to an image mutated after build; closing it fully needs the manifest bound to the image digest by a signature, which is the same owed work as the closure SBOM attestation above.',
  ],
};
const unexempt = (label: string, found: string[]) =>
  found.filter((s) => !(EXEMPT[label] ?? []).includes(s));

describe('the exemptions are live', () => {
  for (const [label, sentences] of Object.entries(EXEMPT)) {
    const get = PLACES.find(([l]) => l === label)?.[1];
    for (const sentence of sentences) {
      it(`${label}: exempt sentence still present and still flagged by the scanner`, () => {
        expect(get).toBeDefined();
        expect(overclaims(get?.() ?? '')).toContain(sentence);
      });
    }
  }
});

describe('the scan covers every region of every page', () => {
  const VARIANTS: [string, string][] = [
    ['capitalised "Pinning"', OVERCLAIM],
    ['lower-case "pinning"', '\n\npinning closes the exposure to the database secret.\n'],
    ['upper-case', '\n\nPINNING CLOSES THE EXPOSURE TO THE DATABASE SECRET.\n'],
    [
      'a line without "backendservices" or "backends"',
      '\n\nThe Pin keeps your tokens safe from it.\n',
    ],
  ];
  for (const [label, get] of PLACES) {
    for (const [vlabel, v] of VARIANTS) {
      it(`${label}: an appended claim (${vlabel}) is flagged`, () => {
        expect(unexempt(label, overclaims(get(v))).length).toBeGreaterThan(0);
      });
    }
  }
  it('unparseable or empty input fails rather than passes', () => {
    expect(() => page('apps/docs/content/docs/does-not-exist.mdx')()).toThrow();
    expect(() => section('# nothing here', '## Missing')).toThrow();
    expect(() => section(read('docs/security/threat-model.md'), '### No such section')).toThrow();
  });
});

describe('no place says the image pin closes the database-Secret exposure', () => {
  for (const [label, get] of PLACES) {
    it(label, () => {
      expect(unexempt(label, overclaims(get()))).toEqual([]);
    });
    it(`${label}: any claim about the spec pin is scoped to the BackendService route`, () => {
      expect(specOverclaims(get())).toEqual([]);
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

  it('the deploy function hint offers the spec pin first and calls the image pin the weaker one', () => {
    const src = read('packages/grpc/src/deploy-function.ts').replace(/\s+/g, ' ');
    expect(src).toMatch(/specDigest/);
    expect(src).toMatch(/image, env, envFrom and volumes/);
    // The image-only entry still carries the caveat.
    expect(src).toMatch(/weaker alternative pins the image only/);
    expect(src).toMatch(/still change its env, envFrom and volumes/);
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

describe('the spec pin: every user-facing place says what it binds', () => {
  const SPEC_PLACES: [string, () => string][] = [
    ['the zone-functions pin section', docsPinSection],
    ['the SpecDigest field doc in the Go types', goSpecFieldDoc],
    ['the generated CRD specDigest description', crdSpecFieldDoc],
    ['the config.ts specDigest field doc', configSpecFieldDoc],
    ['the spec-pin changeset', () => read('.changeset/zone-function-spec-pin.md')],
    ['the user threat model page', () => read('apps/docs/content/docs/threat-model.mdx')],
  ];
  for (const [label, get] of SPEC_PLACES) {
    it(`${label}: names specDigest and binds image, env, envFrom and volumes`, () => {
      const text = get().replace(/\s+/g, ' ');
      expect(text).toMatch(/specDigest/);
      expect(text).toMatch(/\bimage\b/);
      expect(text).toMatch(/\benv\b/);
      expect(text).toMatch(/\benvFrom\b/);
      expect(text).toMatch(/volumes/);
    });
  }
});

describe('the spec pin: every place that says it closes the route also says what remains', () => {
  const RESIDUAL_PLACES: [string, () => string][] = [
    ['the zone-functions pin section', docsPinSection],
    ['the user threat model page', () => read('apps/docs/content/docs/threat-model.mdx')],
    [
      'the threat model',
      () => section(read('docs/security/threat-model.md'), '### Zone-function binding'),
    ],
    [
      'ADR-0004 Amendment 4',
      () => section(read('docs/adr/0004-backend-service-crd.md'), '## Amendment 4'),
    ],
    ['the spec-pin changeset', () => read('.changeset/zone-function-spec-pin.md')],
  ];
  for (const [label, get] of RESIDUAL_PLACES) {
    it(`${label}: contents of the named objects, and the settings outside the digest`, () => {
      const text = get().replace(/\s+/g, ' ');
      // What a spec pin cannot see: the data inside the Secrets and ConfigMaps it names.
      expect(text).toMatch(/contents of the (?:objects|Secrets and ConfigMaps)/i);
      // And the settings that are not hashed.
      expect(text).toMatch(/\bport\b/);
      expect(text).toMatch(/protoVersion/);
    });
  }

  it('the advice to restrict update/patch/create still applies without a spec pin, in the docs page and the changeset', () => {
    for (const text of [
      docsPinSection().replace(/\s+/g, ' '),
      read('.changeset/zone-function-spec-pin.md').replace(/\s+/g, ' '),
    ]) {
      expect(text).toMatch(/`?update`?, `?patch`? and `?create`? on\s+`?backendservices`?/i);
      expect(text).toMatch(/already read/i);
      expect(text).toMatch(/image pin|image-only|no pin|none/i);
    }
  });

  it('the user docs keep no issue, PR or ADR numbers for the spec pin either', () => {
    for (const p of [
      'apps/docs/content/docs/zone-functions.mdx',
      'apps/docs/content/docs/cli.mdx',
      'apps/docs/content/docs/operator.mdx',
    ]) {
      expect(read(p), p).not.toMatch(/ADR-\d+/);
    }
    expect(read('apps/docs/content/docs/zone-functions.mdx')).not.toMatch(/#\d{3,}/);
  });
});

describe('the internal docs record the spec pin and its exact residuals', () => {
  it('ADR-0004 Amendment 4 records what is closed, what remains, the canonical form and the field coverage guard', () => {
    const adr = read('docs/adr/0004-backend-service-crd.md');
    const a4 = adr.slice(adr.indexOf('## Amendment 4')).replace(/\s+/g, ' ');
    expect(a4).toContain('#2526');
    expect(a4).toContain('specDigest');
    expect(a4).toContain('BindingSpecMismatch');
    expect(a4).toMatch(/knext\/backendservice-spec\/v1/);
    expect(a4).toContain('TestEveryBackendServiceSpecFieldIsBoundOrReviewed');
    expect(a4).toMatch(/closed for the BackendService route/);
    expect(a4).toMatch(/Contents of the objects the spec names/);
    expect(a4).toMatch(/jev/);
  });

  it('the threat model keeps the image-only residual and adds the spec pin', () => {
    const tm = section(read('docs/security/threat-model.md'), '### Zone-function binding').replace(
      /\s+/g,
      ' ',
    );
    expect(tm).toMatch(/pin binds the image content only/i);
    expect(tm).toContain('specDigest');
    expect(tm).toContain('BindingSpecMismatch');
    expect(tm).toMatch(/closed for a zone that sets the spec pin/);
  });
});

describe('the status message of a spec-pin refusal makes no safety claim about the Secret', () => {
  it('says what to do, names both digests, and does not say the Secret is safe', () => {
    const msg = specStatusMessage().slice(0, specStatusMessage().indexOf('\n}\n'));
    expect(msg).not.toMatch(/database Secret/i);
    expect(msg).not.toMatch(/\bsafe\b/i);
    expect(msg).toContain('backends[].specDigest');
    expect(msg).toContain('pin');
  });
});

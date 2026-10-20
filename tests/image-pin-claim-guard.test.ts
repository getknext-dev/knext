import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
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
 * UNLESS a negation or limiter (not, never, only, narrows, cannot) sits in the SAME
 * clause, within three words BEFORE that claim verb: a limiter must negate the
 * claim, not merely appear near it. A negation elsewhere does not rescue it:
 * "Pinning protects the database Secret and it is not slow" and "Pinning closes
 * the exposure when the image is not mutable" are claims. Clauses are cut at
 * , ; : — | and at "but", "while", "although", "and". Text is NFKC-normalised
 * and stripped of zero-width characters first, and list items are separate
 * sentences. A claim about the SPEC pin must be scoped to the BackendService
 * route, and an absolute quantifier (any, every, nobody, entirely) is no scope.
 *
 * It is a net, not a proof: it catches the wordings this repo has had and a
 * corpus of paraphrases (below, every one asserted). The positive checks (the
 * caveat must be present in every place) are the part that cannot be reworded
 * away.
 */
const PIN_TERM = /\b(?:pin(?:s|ned|ning)?|image digest)\b/i;
const CLAIM_VERB =
  /\b(?:close[sd]?(?!\s+(?:review|meeting))|closing|eliminat\w+|fix(?:es|ed)?|solv\w+|prevent\w*|protect\w*|secur(?:e|es|ed|ing)|safe(?:ly|guard\w*)?|stop(?:s|ped)?|guarantee\w*|remov(?:e|es|ed) the (?:risk|exposure)|immutable|tamper-?proof|shields?|shielded|locks? down|guards?|guarded|defends?|defended|hardened against|rules? out|mitigat\w+|neutrali[sz]\w+|resolv\w+|address(?:es|ed)?|blocks?|blocked|remed(?:y|ies|ied)|ensures? only|makes? it impossible|unreachable|out of reach|moot|complete answer)\b|\bkeeps?\b[^,;:]*\bfrom\b|\bno longer\b/i;
const TARGET =
  /\b(?:database secret|secret|db-bind|exposure|(?:the )?(?:problem|gap|risk|hole|issue)|users' tokens|confused deputy|equivalent to|(?:the )?zone(?:'s)? (?:database|data)|that|this|it|them)\b/i;
const LIMITER = /\b(?:not|never|cannot|can't|narrows?|neither|nor)\b|n't/i;
/** "only" narrows a claim only when it sits right before what the claim is narrowed to ("only an image swap", "only stops an image swap"). */
const ONLY_NARROWS = /\bonly (?:(?:an? |the )?(?:image|swap)|\w+ (?:an? |the )?(?:image|swap))\b/i;
/** A negation that is itself negated ("never fails to close") is a claim, not a limiter. */
const DOUBLE_NEGATION =
  /\b(?:never|not|n't|cannot) (?:fail|fails|failed|miss|misses|neglect|neglects)(?: to)?\b|\b\w+n't (?:fail|miss|neglect)\w*(?: to)?\b/gi;
/** A condition before a negation: "no good if it does not stop" does not negate the claim. */
const CONDITION = /\b(?:if|unless|when|whenever|whether|once|where)\b/i;
/** Words that make a protection claim absolute; they are never a scope. */
const ABSOLUTE =
  /\b(?:any|every|all|always|never|nobody|no one|entirely|completely|fully|anywhere|everywhere|whatever|regardless|no matter)\b/i;
/** A clause that states the mechanism ("is refused") bounds its own "whatever". */
const MECHANISM = /\b(?:refus\w+|mismatch\w*)\b/i;
/** The mechanism bounds an absolute only in a clause that states the mechanism and nothing else: a clause that also claims protection stays absolute. */
const absoluteIn = (clause: string) =>
  ABSOLUTE.test(clause) && !(MECHANISM.test(clause) && !CLAIM_VERB.test(clause));

/** A sentence about the SPEC pin. The image pin never closes anything, so a sentence that also names it is not exempt. */
const SPEC_PIN_TERM =
  /\b(?:specDigest|spec pin|spec digest|whole spec|pins? the (?:function's )?spec)\b/i;
const IMAGE_PIN_TERM =
  /\bimage[- ]pin\b|\bimage-only\b|\bpins? (?:only )?the image\b|\bpinn(?:ed|ing) (?:the )?image\b|\bpinned image\b|\b(?:an|the) `?image`? pin\b/i;
/** What a protection claim about the spec pin must be scoped to: the BackendService route. */
const SPEC_SCOPE = /\b(?:backendservices?|route|can no longer make|cannot make)\b/i;

const TO_CLOSE =
  /\b(?:set|enable|use|add|put|apply|configure)\b[^.]*\bto (?:close|fix|solve|eliminate|prevent|protect against) (?:it|that|this|the (?:exposure|risk|gap|problem))\b/i;

/** The scan entry point for text that must carry content: blank input is an error, not a clean bill. */
function scanText(text: string): string[] {
  if (text.trim().length === 0) throw new Error('nothing to scan');
  return overclaims(text);
}

function claimClauses(sentence: string): string[] {
  return sentence.split(/[,;:—|]|\s(?:but|while|although|and)\s/i);
}

/** True when the last three words before `index` in `clause` hold a limiter: it must negate the verb at `index`. */
function limitedBefore(clause: string, index: number): boolean {
  const before = clause.slice(0, index).trim().split(/\s+/);
  const near = before.slice(-3).join(' ');
  // What follows the verb matters for "only": "only stops an image swap".
  const after = clause.slice(index, index + 50);
  if (ONLY_NARROWS.test(`${near} ${after}`)) return true;
  const cleaned = near.replace(DOUBLE_NEGATION, ' ');
  const hit = LIMITER.exec(cleaned);
  if (!hit) return false;
  // A negation under a condition (within five words before it) does not negate the claim.
  const ahead = before.slice(-8).join(' ');
  const at = ahead.search(LIMITER);
  return !(at >= 0 && CONDITION.test(ahead.slice(0, at)));
}

/** A claim verb in `clause` that no limiter negates, and a target for it. */
function claimsIn(clause: string): boolean {
  if (!TARGET.test(clause)) return false;
  const verbs = new RegExp(CLAIM_VERB.source, 'gi');
  for (let m = verbs.exec(clause); m; m = verbs.exec(clause)) {
    if (!limitedBefore(clause, m.index)) return true;
  }
  return false;
}

/** Normalise before scanning: NFKC (fullwidth letters), curly quotes, no zero-width characters. */
function normalise(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/[\u2018\u2019]/g, "'");
}

function flatten(text: string): string[] {
  // A blank line ends a sentence too: headings, table rows and code carry no full stop,
  // and without this a claim appended after one is judged with its limiters. So does a
  // list marker: each bullet or numbered item stands alone.
  return normalise(text)
    .split(/\n\s*\n/)
    .flatMap((para) => para.split(/\n\s*(?:[-*+\u2022]|\d+[.)])\s+/))
    .flatMap((item) =>
      item
        .replace(/^\s*(?:[-*+\u2022]|\d+[.)])\s+/, '')
        .replace(/[*`]/g, '')
        .replace(/fail(?:s|ed)?[ -]closed/gi, 'fail-shut')
        .replace(/\s+/g, ' ')
        .split(/(?<=[.!?])\s+/),
    );
}

const isSpecOnly = (s: string) => SPEC_PIN_TERM.test(s) && !IMAGE_PIN_TERM.test(s);

/** True when a claim verb in the sentence is not negated: used for the absolute-quantifier rule. */
function hasUnlimitedVerb(sentence: string): boolean {
  const verbs = new RegExp(CLAIM_VERB.source, 'gi');
  for (let m = verbs.exec(sentence); m; m = verbs.exec(sentence)) {
    if (!limitedBefore(sentence, m.index)) return true;
  }
  return false;
}

/**
 * A sentence about the spec pin that claims protection without scoping it to the
 * BackendService route ("the spec pin makes the Secret safe"). The claim itself
 * is allowed; an unbounded one is not. An absolute quantifier is no scope: "any
 * route", "nobody", "entirely" turn a scoped claim back into an unbounded one.
 */
function specOverclaims(text: string): string[] {
  return flatten(text).filter((s) => {
    if (!isSpecOnly(s)) return false;
    const clauses = claimClauses(s);
    if (hasUnlimitedVerb(s) && clauses.some(absoluteIn)) return true;
    // The scope must sit in the same clause as the claim.
    return clauses.some((c) => claimsIn(c) && !SPEC_SCOPE.test(c));
  });
}

function overclaims(text: string): string[] {
  return flatten(text).filter((s) => {
    // The spec pin is judged by specOverclaims, not by the image-pin rules.
    if (isSpecOnly(s)) return false;
    // The imperative form names no pin ("Set it to close that."): "it" is the pin.
    const toClose = TO_CLOSE.exec(s);
    if (toClose && !limitedBefore(s, toClose.index) && !LIMITER.test(toClose[0])) return true;
    if (!PIN_TERM.test(s)) return false;
    return claimClauses(s).some(claimsIn);
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
  // Round 2: attacks that evaded the first whole-page scanner. Each must be flagged.
  const ROUND2 = [
    // A limiter must not rescue a claim across a conjunction (no comma).
    'Pinning protects the database Secret and it is not slow.',
    'Pinning is not slow and closes the exposure.',
    'Pinning does not hurt and closes the exposure.',
    // A limiter that does not negate the claim verb must not rescue it.
    'Pinning closes the exposure when the image is not mutable.',
    'Pinning closes the exposure whenever the digest is not stale.',
    // Verbs of protection the first list missed.
    'Pinning makes the database Secret immutable.',
    'The pin is tamper-proof, so it shields the database Secret.',
    'A pinned image is tamper-proof for the database Secret.',
    'Pinning locks down the exposure.',
    'The pin guards the database Secret.',
    'The pin defends the database Secret.',
    'A pinned image is hardened against the exposure.',
    'Pinning rules out the exposure.',
    'Pinning mitigates the exposure.',
    'Pinning neutralises the exposure.',
    'Pinning neutralizes the exposure.',
    'Pinning resolves the exposure.',
    'Pinning addresses the exposure.',
    'Pinning blocks the exposure.',
    'Pinning remedies the exposure.',
    'Pinning removes the risk to the database Secret.',
    'Pinning ensures only the agreed image reaches the database Secret.',
    'Pinning makes it impossible to reach the database Secret.',
    'Pinning is the fix for the exposure.',
    // Targets the first list missed.
    "Pinning protects the zone's database.",
    "Pinning keeps the zone's data safe.",
    'Pinning protects the zone’s data.',
    // Unicode tricks: a zero-width joiner or a fullwidth letter inside the verb.
    // Round 3: "only" narrows only when it directly precedes a narrowing object.
    'Pinning only ever really protects the database Secret.',
    'Pinning is only here to stop the exposure.',
    // A negation under a condition does not negate the claim.
    'Pinning is no good if it does not stop the exposure.',
    // A double negation is a claim.
    'Pinning never fails to close the exposure.',
    'Pinning does not fail to protect the database Secret.',
    // Further wordings of the same claim.
    'Pinning makes the database Secret unreachable.',
    'With a pin the database Secret is out of reach.',
    'With a pin the exposure is moot.',
    'Pinning is the complete answer to the exposure.',
    'Pinning c\u200dloses the exposure.',
    'Pinning cl\u200bos\ufeffes the exposure.',
    'Pinning ｃｌｏｓｅｓ the exposure.',
    // A list item is its own sentence: a limiter in the next item does not rescue it.
    '- Pinning closes the exposure\n- This is not slow\n- Cheap',
    '1. Pinning closes the exposure\n2. It is not slow',
    '* Pinning closes the exposure\n* never mind',
    '- Never\n- Pinning closes the exposure',
    '1. Not\n2. Pinning closes the exposure',
  ];
  for (const sentence of [...OLD, ...PARAPHRASES, ...ROUND2]) {
    it(`flags: ${sentence}`, () => {
      expect(overclaims(sentence), sentence).toHaveLength(1);
    });
  }

  it('does not flag the corrected wording (a limiter in the same clause)', () => {
    for (const ok of [
      'Pinning does not close and does not fix the exposure.',
      'Pinning neither closes nor fixes the database Secret exposure.',
      'Pinning never fully closes the exposure.',
      'Pinning cannot close or fix the exposure.',
      'Pinning closes only an image swap.',
      'Pinning only closes the image swap exposure.',
      'Pinning closes only the image exposure.',
      'Pinning only the image does not protect the database Secret.',
      'Pinning can not close the exposure.',
      'Pinning cannot close the exposure.',
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
      // Round 2: an absolute quantifier is not a scope, and a mention of the route is not one either.
      "The spec pin makes the zone's data safe.",
      'specDigest guarantees nobody reads the Secret on any route.',
      'The spec pin protects the BackendService and the Secret entirely.',
      'The spec pin closes every route to the Secret.',
      'The spec pin closes the exposure when specDigest is not stale.',
      'The spec pin makes the Secret imm\u200dutable.',
      // Round 3: the scope must sit in the same clause as the claim verb.
      'The spec pin closes the BackendService route and the Secret is safe everywhere.',
      'specDigest closes the BackendService route to the Secret, and the Secret is safe.',
      'specDigest closes the route to the Secret, whatever the writer does.',
      // A stray "refused" is neither a scope nor a bound on an unrelated absolute.
      'The spec pin makes the Secret safe whatever the writer does when a change is refused.',
      'specDigest makes the Secret safe everywhere because every change is refused.',
      'specDigest makes the Secret safe because a change is refused.',
      'specDigest closes the route to the Secret regardless of what the writer does.',
      'specDigest closes the route to the Secret, no matter what the writer changes.',
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
// (a base-image tag, a build manifest, a test index). Each is exempt only as the WHOLE
// normalised sentence, matched exactly (a hash of it, plus its opening words so a
// reader can find it), on its own page only. Appending anything to it, or editing it,
// ends the exemption and the scanner judges it again. A test keeps each entry live.
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
type Exempt = { head: string; sha: string };
const EXEMPT: Record<string, Exempt[]> = {
  'the operator reference': [
    {
      head: 'The operator instead performs its own existence check and',
      sha: '5101043eac93247563c7313ae49db5ac0004fddff711a69b13f91ba8c351f152',
    },
    {
      head: 'Install the operator per namespace or add your own admission policy',
      sha: '44e5a9c854c034ce97182529027c80e16d60bece21cda5946018413bb5b887e7',
    },
  ],
  'the user threat model page': [
    {
      head: 'That pulls only fixes already published on the same pinned Alpine',
      sha: '6bfd5c8a268084c11d609846cb1d70557c5719f0a8d4a2a7f141592eec37884b',
    },
  ],
  'the threat model': [
    {
      head: 'The template Dockerfile therefore fails the build',
      sha: 'e4e5fde448251d14c5a83737fd2d06bdf4247a7911727a03bed51ac32cc38d2c',
    },
  ],
  'ADR-0004': [
    {
      head: 'One specDigest over image + env + envFrom + volumes',
      sha: '2ddac3643624effe53e5f0c603e00950fcf714842f1050d1e5505579ac61272e',
    },
  ],
};
const isExempt = (label: string, sentence: string) =>
  (EXEMPT[label] ?? []).some((e) => sentence.startsWith(e.head) && sha(sentence) === e.sha);
const unexempt = (label: string, found: string[]) => found.filter((s) => !isExempt(label, s));
const flaggedSentences = (text: string) => [...overclaims(text), ...specOverclaims(text)];

describe('the exemptions are live and exact', () => {
  for (const [label, entries] of Object.entries(EXEMPT)) {
    const get = PLACES.find(([l]) => l === label)?.[1] as (extra?: string) => string;
    for (const entry of entries) {
      const findIn = (text: string) =>
        flatten(text).filter((f) => f.startsWith(entry.head) && sha(f) === entry.sha);
      it(`${label}: "${entry.head}" is still on the page and still flagged by the scanner`, () => {
        const flagged = flaggedSentences(get());
        expect(findIn(get())).toHaveLength(1);
        expect(flagged.filter((f) => isExempt(label, f)).length).toBeGreaterThan(0);
      });
      for (const tail of [
        ', so pinning fully protects the database Secret.',
        ', and pinning makes the Secret safe.',
        ' Pinning closes the exposure to the database Secret.',
      ]) {
        it(`${label}: "${entry.head}" plus an appended claim (${tail.trim()}) is judged again`, () => {
          const sentence = findIn(get())[0];
          expect(sentence).toBeDefined();
          const edited = sentence.replace(/[.!?]?$/, tail);
          expect(isExempt(label, edited)).toBe(false);
          expect(flaggedSentences(edited).length).toBeGreaterThan(0);
        });
      }
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
      expect(unexempt(label, specOverclaims(get()))).toEqual([]);
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

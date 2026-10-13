import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { lineSpec } from '../scripts/compat-credential-line.mjs';
import { isRcTag, PIN_FILE } from '../scripts/compat-credential-ref.mjs';

/**
 * #2317 — main's 1.x credential lane must keep testing the 1.x Next ref.
 *
 * A v1.0 credential run checks out the pinned `rcTag` but takes
 * `.github/workflows/test-e2e-deploy.yml` from main, so that file's
 * `NEXTJS_REF` is the Next.js ref the 1.x credential cells test. A long-lived
 * branch that moves to a newer Next (integration/v2 moved both that default and
 * `credentialedNextRef` to v16.4.0, under a scoped marker of its own) would,
 * when merged into main, silently move the 1.x lane too: the lockstep test sees
 * the new value on both of its sides, and the freeze guard treats the
 * branch's marker as new.
 *
 * So, while `rcTag` is a v1.x tag, this file requires every default and every
 * fallback of `NEXTJS_REF` in `test-e2e-deploy.yml`, and the documented
 * `credentialedNextRef`, to equal the 1.x line's ref. The ANCHOR is the
 * committed v1.3 credential lane's `NEXTJS_REF`: that workflow is generated
 * from the v1.3 RC tag's own `test-e2e-deploy.yml`, so it carries the 1.x
 * ref by construction and a newer line keeps it unchanged. The legitimate way
 * past this guard is to move `rcTag` to a v2+ tag in its own reviewed PR, or
 * to keep the 1.x ref for the 1.x cells.
 *
 * This file is deliberately standalone: a branch that never touched it carries
 * it into the merged tree unmodified, where it goes red.
 */

const ROOT = resolve(import.meta.dirname, '..');
const E2E_WORKFLOW = '.github/workflows/test-e2e-deploy.yml';
const V13_WORKFLOW = `.github/workflows/${lineSpec('v1.3').workflowFile}`;
const MANIFEST = '.github/compat-credentialed-next-version.json';

const REF_RE = /^v\d+\.\d+\.\d+$/;
const REF_LITERAL_RE = /\bv\d+\.\d+\.\d+\b/g;

export type OneXInputs = {
  /** `.github/compat-credential-ref.json`, parsed. */
  pin: unknown;
  /** `test-e2e-deploy.yml` text — the 1.x credential lane main runs. */
  e2eWorkflowText: string;
  /** The committed v1.3 credential lane text (undefined = missing). */
  v13WorkflowText: string | undefined;
  /** `.github/compat-credentialed-next-version.json`, parsed. */
  manifest: unknown;
};

export type OneXVerdict = {
  /** Is a 1.x credential window live (so the 1.x ref must hold)? */
  applies: boolean;
  /** The 1.x Next ref read from the v1.3 lane, when readable. */
  anchor?: string;
  violations: string[];
};

/** The single `NEXTJS_REF: ${{ github.event.inputs.nextjsRef || 'vX' }}` literal. */
export function envFallbackLiteral(text: string): string | undefined {
  const hits = [
    ...text.matchAll(
      /^[ \t]*NEXTJS_REF:[ \t]*\$\{\{\s*github\.event\.inputs\.nextjsRef\s*\|\|\s*'([^']+)'\s*\}\}[ \t]*$/gm,
    ),
  ];
  return hits.length === 1 ? hits[0][1] : undefined;
}

/** `workflow_dispatch.inputs.nextjsRef.default`, read through a YAML parse. */
function dispatchDefault(text: string): string | undefined {
  let wf: unknown;
  try {
    wf = parse(text);
  } catch {
    return undefined;
  }
  // biome-ignore lint/suspicious/noExplicitAny: parsed YAML
  const value = (wf as any)?.on?.workflow_dispatch?.inputs?.nextjsRef?.default;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Every non-comment line that names `NEXTJS_REF`/`nextjsRef` and carries a
 * `vX.Y.Z` literal — a scan, so a fallback added anywhere (a job-level env, a
 * shell `${NEXTJS_REF:-…}`, a `$GITHUB_ENV` write) is caught without being
 * enumerated. The dispatch `default:` sits on its own line and is read above.
 */
function refLiteralsNamingNextjsRef(text: string): { line: number; ref: string }[] {
  const out: { line: number; ref: string }[] = [];
  text.split('\n').forEach((raw, i) => {
    if (/^\s*#/.test(raw)) return;
    if (!/NEXTJS_REF|nextjsRef/.test(raw)) return;
    for (const ref of raw.match(REF_LITERAL_RE) ?? []) out.push({ line: i + 1, ref });
  });
  return out;
}

export function checkOneXCredentialRef(inputs: OneXInputs): OneXVerdict {
  const rcTag =
    inputs.pin && typeof inputs.pin === 'object'
      ? (inputs.pin as { rcTag?: unknown }).rcTag
      : undefined;
  if (rcTag === null) return { applies: false, violations: [] };
  if (!isRcTag(rcTag)) {
    return {
      applies: true,
      violations: [
        `rcTag ${JSON.stringify(rcTag)} is neither null nor an RC tag (vX.Y.Z-rc.N) — failing closed`,
      ],
    };
  }
  if (!(rcTag as string).startsWith('v1.')) return { applies: false, violations: [] };

  const violations: string[] = [];

  // The anchor: the committed v1.3 lane's NEXTJS_REF, both forms, agreeing.
  const v13 = inputs.v13WorkflowText;
  const anchorEnv = v13 === undefined ? undefined : envFallbackLiteral(v13);
  const anchorDispatch = v13 === undefined ? undefined : dispatchDefault(v13);
  if (
    anchorEnv === undefined ||
    anchorDispatch === undefined ||
    !REF_RE.test(anchorEnv) ||
    anchorEnv !== anchorDispatch
  ) {
    violations.push(
      `cannot read the 1.x anchor from ${V13_WORKFLOW}: env fallback ${JSON.stringify(anchorEnv)}, dispatch default ${JSON.stringify(anchorDispatch)} (need one vX.Y.Z, equal in both) — failing closed`,
    );
    return { applies: true, violations };
  }
  const anchor = anchorEnv;

  const text = inputs.e2eWorkflowText;
  const dispatch = dispatchDefault(text);
  if (dispatch !== anchor) {
    violations.push(
      `${E2E_WORKFLOW} nextjsRef dispatch default is ${JSON.stringify(dispatch)}, but rcTag ${rcTag} is a 1.x window credentialed at ${anchor}`,
    );
  }
  const env = envFallbackLiteral(text);
  if (env !== anchor) {
    violations.push(
      `${E2E_WORKFLOW} NEXTJS_REF env fallback is ${JSON.stringify(env)} (need exactly one 'NEXTJS_REF: \${{ github.event.inputs.nextjsRef || '<ref>' }}'), but rcTag ${rcTag} is a 1.x window credentialed at ${anchor}`,
    );
  }
  for (const { line, ref } of refLiteralsNamingNextjsRef(text)) {
    if (ref !== anchor) {
      violations.push(
        `${E2E_WORKFLOW}:${line} gives NEXTJS_REF the ref ${ref}, but rcTag ${rcTag} is a 1.x window credentialed at ${anchor}`,
      );
    }
  }

  const documented =
    inputs.manifest && typeof inputs.manifest === 'object'
      ? (inputs.manifest as { credentialedNextRef?: unknown }).credentialedNextRef
      : undefined;
  if (documented !== anchor) {
    violations.push(
      `${MANIFEST} credentialedNextRef is ${JSON.stringify(documented)}, but rcTag ${rcTag} is a 1.x window credentialed at ${anchor}`,
    );
  }

  return { applies: true, anchor, violations };
}

const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const realInputs = (): OneXInputs => ({
  pin: JSON.parse(read(PIN_FILE)),
  e2eWorkflowText: read(E2E_WORKFLOW),
  v13WorkflowText: existsSync(resolve(ROOT, V13_WORKFLOW)) ? read(V13_WORKFLOW) : undefined,
  manifest: JSON.parse(read(MANIFEST)),
});

/** Replace `from` with `to`, refusing unless `from` occurs EXACTLY once. */
function replaceOnce(text: string, from: string, to: string): string {
  const count = text.split(from).length - 1;
  if (count !== 1) throw new Error(`fixture anchor ${JSON.stringify(from)} occurs ${count} times`);
  return text.replace(from, to);
}

const V1X_REF = 'v16.3.8';
const V2_REF = 'v16.4.0';
const ENV_LINE = (ref: string) => `  NEXTJS_REF: \${{ github.event.inputs.nextjsRef || '${ref}' }}`;
const DISPATCH_LINE = (ref: string) => `        default: '${ref}'`;

/** A minimal lane shaped like the real ones: dispatch default + env fallback. */
function lane(dispatchRef: string, envRef: string, extra = ''): string {
  return [
    'on:',
    '  workflow_dispatch:',
    '    inputs:',
    '      nextjsRef:',
    "        description: 'ref'",
    '        required: false',
    DISPATCH_LINE(dispatchRef),
    '      runtime:',
    "        default: 'node'",
    'env:',
    ENV_LINE(envRef),
    '  # NEXTJS_REF history: once v16.2.0, a comment, never a fallback',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo hi',
    extra,
  ].join('\n');
}

const fixture = (over: Partial<OneXInputs> = {}): OneXInputs => ({
  pin: { rcTag: 'v1.0.0-rc.6' },
  e2eWorkflowText: lane(V1X_REF, V1X_REF),
  v13WorkflowText: lane(V1X_REF, V1X_REF),
  manifest: { credentialedNextRef: V1X_REF },
  ...over,
});

describe("#2317 — while rcTag is v1.x, main's credential NEXTJS_REF stays on the 1.x ref", () => {
  it('self-test: the env-fallback reader needs exactly one trusted assignment', () => {
    expect(envFallbackLiteral(ENV_LINE('v9.9.9'))).toBe('v9.9.9');
    expect(envFallbackLiteral(`${ENV_LINE('v1.1.1')}\n${ENV_LINE('v1.1.1')}`)).toBeUndefined();
    expect(envFallbackLiteral(`# ${ENV_LINE('v1.1.1')}`)).toBeUndefined();
  });

  it('a well-formed 1.x fixture passes, and the guard APPLIES (not vacuous)', () => {
    const v = checkOneXCredentialRef(fixture());
    expect(v.applies).toBe(true);
    expect(v.anchor).toBe(V1X_REF);
    expect(v.violations).toEqual([]);
  });

  it('HAZARD (#2314 merged into main): both defaults and credentialedNextRef at v16.4.0 while rcTag is v1.x -> red on each', () => {
    const v = checkOneXCredentialRef(
      fixture({
        e2eWorkflowText: lane(V2_REF, V2_REF),
        manifest: { credentialedNextRef: V2_REF },
      }),
    );
    expect(v.applies).toBe(true);
    expect(v.violations.some((m) => m.includes('dispatch default'))).toBe(true);
    expect(v.violations.some((m) => m.includes('env fallback'))).toBe(true);
    expect(v.violations.some((m) => m.includes('credentialedNextRef'))).toBe(true);
  });

  it('only the env fallback drifted -> red', () => {
    const v = checkOneXCredentialRef(fixture({ e2eWorkflowText: lane(V1X_REF, V2_REF) }));
    expect(v.violations.some((m) => m.includes('env fallback'))).toBe(true);
  });

  it('only the dispatch default drifted -> red', () => {
    const v = checkOneXCredentialRef(fixture({ e2eWorkflowText: lane(V2_REF, V1X_REF) }));
    expect(v.violations.some((m) => m.includes('dispatch default'))).toBe(true);
  });

  it('an EXTRA fallback anywhere in the file (job env, shell default) -> red (scan, not a list)', () => {
    for (const extra of [
      '    env:\n      NEXTJS_REF: v16.4.0',
      '      - run: NEXTJS_REF="${NEXTJS_REF:-v16.4.0}" ./x.sh',
      '      - run: echo "NEXTJS_REF=v16.4.0" >> "$GITHUB_ENV"',
    ]) {
      const v = checkOneXCredentialRef(fixture({ e2eWorkflowText: lane(V1X_REF, V1X_REF, extra) }));
      expect(
        v.violations.some((m) => m.includes('v16.4.0')),
        extra,
      ).toBe(true);
    }
  });

  it('an env fallback that is not the one trusted form fails closed', () => {
    const text = replaceOnce(
      lane(V1X_REF, V1X_REF),
      ENV_LINE(V1X_REF),
      '  NEXTJS_REF: ${{ inputs.other || github.event.inputs.nextjsRef }}',
    );
    const v = checkOneXCredentialRef(fixture({ e2eWorkflowText: text }));
    expect(v.violations.some((m) => m.includes('env fallback'))).toBe(true);
  });

  it('only credentialedNextRef drifted -> red', () => {
    const v = checkOneXCredentialRef(fixture({ manifest: { credentialedNextRef: V2_REF } }));
    expect(v.violations.some((m) => m.includes('credentialedNextRef'))).toBe(true);
  });

  it('an unreadable or self-inconsistent anchor fails closed', () => {
    for (const v13 of [undefined, lane(V1X_REF, 'main'), lane(V1X_REF, V2_REF), 'on: [push]']) {
      const v = checkOneXCredentialRef(fixture({ v13WorkflowText: v13 }));
      expect(v.applies).toBe(true);
      expect(
        v.violations.some((m) => m.includes('1.x anchor')),
        String(v13),
      ).toBe(true);
    }
  });

  it('moving rcTag to a v2+ tag is the legitimate way past: no longer applies', () => {
    const v = checkOneXCredentialRef(
      fixture({
        pin: { rcTag: 'v2.0.0-rc.1' },
        e2eWorkflowText: lane(V2_REF, V2_REF),
        manifest: { credentialedNextRef: V2_REF },
      }),
    );
    expect(v.applies).toBe(false);
    expect(v.violations).toEqual([]);
  });

  it('no window (rcTag null) -> does not apply', () => {
    const v = checkOneXCredentialRef(
      fixture({ pin: { rcTag: null }, e2eWorkflowText: lane(V2_REF, V2_REF) }),
    );
    expect(v.applies).toBe(false);
    expect(v.violations).toEqual([]);
  });

  it('a malformed rcTag fails closed rather than switching the guard off', () => {
    for (const rcTag of ['latest', 'V1.0.0-rc.6', 'v1.0.0', 42, '']) {
      const v = checkOneXCredentialRef(fixture({ pin: { rcTag } }));
      expect(
        v.violations.some((m) => m.includes('rcTag')),
        String(rcTag),
      ).toBe(true);
    }
  });

  it('THE REAL TREE: the guard applies to the committed pin and passes', () => {
    const inputs = realInputs();
    const v = checkOneXCredentialRef(inputs);
    // Applies today (rcTag v1.0.0-rc.6). When rcTag moves to a v2+ tag this
    // line is the one to revisit — never silently.
    expect(v.applies).toBe(true);
    expect(v.anchor).toMatch(REF_RE);
    expect(v.violations).toEqual([]);
  });

  it('THE REAL TREE, simulated #2314 merge: test-e2e-deploy.yml + credentialedNextRef at v16.4.0 -> red', () => {
    const inputs = realInputs();
    const anchor = checkOneXCredentialRef(inputs).anchor as string;
    expect(anchor).toMatch(REF_RE);
    let text = inputs.e2eWorkflowText;
    text = replaceOnce(text, ENV_LINE(anchor), ENV_LINE(V2_REF));
    text = replaceOnce(text, DISPATCH_LINE(anchor), DISPATCH_LINE(V2_REF));
    const v = checkOneXCredentialRef({
      ...inputs,
      e2eWorkflowText: text,
      manifest: { ...(inputs.manifest as object), credentialedNextRef: V2_REF },
    });
    expect(v.violations.length).toBeGreaterThanOrEqual(3);
  });

  it('REF_LITERAL_RE sees the refs this file compares (self-test)', () => {
    expect('x v16.4.0 y'.match(REF_LITERAL_RE)).toEqual(['v16.4.0']);
    expect(isRcTag('v1.0.0-rc.6')).toBe(true);
  });
});

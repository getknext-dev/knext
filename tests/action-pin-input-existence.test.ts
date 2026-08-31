/**
 * #750 — the input-existence half of the nightly action-pin resolver.
 *
 * SHA↔tag correspondence (tests/action-pin-sha-tag-nightly.test.ts) proves the
 * pin is the commit it claims; nothing proved the `with:` keys we pass still
 * EXIST there. GitHub Actions silently ignores an unknown `with:` key, so a
 * renamed input on a major bump (changesets/action v1→v2, #747) evaporates at
 * run time with every guard green. These tests drive the check offline against
 * injected API/git doubles, exactly like the tag-resolution suite: the network
 * truth is the nightly's job, the LOGIC is this file's.
 */

import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fetchDeclaredInputs,
  formatFinding,
  gitCatFile,
  githubApi,
  parseActionInputs,
  parsePins,
  parseWorkflowCallInputs,
  verifyPinInputs,
  verifyPins,
} from '../scripts/verify-action-pins.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const base64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const contentsOk = (text: string) => ({
  status: 200,
  body: { content: base64(text), encoding: 'base64' },
});

/** Parse a single-step workflow snippet and return its one pin. */
const onePin = (snippet: string) => {
  const pins = parsePins(snippet, 'wf.yml');
  expect(pins).toHaveLength(1);
  return pins[0];
};

describe('input existence — `with:` extraction (#750)', () => {
  it('attaches the passed `with:` keys, each with its own line number', () => {
    const pin = onePin(
      [
        'jobs:',
        '  scan:',
        '    steps:',
        `      - uses: aquasecurity/trivy-action@${SHA_A} # v0.36.0`,
        '        with:',
        '          severity: HIGH,CRITICAL',
        '          exit-code: "1"',
        '',
      ].join('\n'),
    );
    expect(pin.withKeys).toEqual([
      { key: 'severity', line: 6 },
      { key: 'exit-code', line: 7 },
    ]);
    expect(pin.withUnreadable).toBeUndefined();
  });

  it('reads a `with:` that PRECEDES its `uses:` — YAML mappings are unordered', () => {
    const pin = onePin(
      [
        '      - name: scan',
        '        with:',
        '          severity: HIGH',
        `        uses: aquasecurity/trivy-action@${SHA_A} # v0.36.0`,
      ].join('\n'),
    );
    expect(pin.withKeys.map((k: { key: string }) => k.key)).toEqual(['severity']);
  });

  it("does not attribute the NEXT step's `with:` to a step that passes nothing", () => {
    const pins = parsePins(
      [
        '      - name: first',
        `        uses: actions/checkout@${SHA_A} # v7.0.1`,
        '      - name: second',
        `        uses: actions/setup-node@${SHA_B} # v5.0.0`,
        '        with:',
        '          node-version: 22',
      ].join('\n'),
      'wf.yml',
    );
    expect(pins[0].withKeys).toEqual([]);
    expect(pins[1].withKeys.map((k: { key: string }) => k.key)).toEqual(['node-version']);
  });

  it('does not misread `key:`-shaped lines INSIDE a block-scalar input value as inputs', () => {
    const pin = onePin(
      [
        `      - uses: actions/github-script@${SHA_A} # v8.0.0`,
        '        with:',
        '          script: |',
        '            const config: string = "x";',
        '            core.setOutput("done", true);',
        '          result-encoding: string',
      ].join('\n'),
    );
    expect(pin.withKeys.map((k: { key: string }) => k.key)).toEqual(['script', 'result-encoding']);
  });

  it('reads a JOB-level reusable-workflow `uses:` (no list marker) and keeps the subpath', () => {
    const pin = onePin(
      [
        'jobs:',
        '  call:',
        `    uses: octo/shared/.github/workflows/build.yml@${SHA_A} # v1.0.0`,
        '    with:',
        '      environment: prod',
      ].join('\n'),
    );
    expect(pin.subpath).toBe('.github/workflows/build.yml');
    expect(pin.withKeys.map((k: { key: string }) => k.key)).toEqual(['environment']);
  });

  it('reads a simple one-line flow mapping, and FAILS CLOSED on an anchor it cannot read', async () => {
    const flow = onePin(
      `      - uses: actions/setup-node@${SHA_A} # v5.0.0\n        with: {node-version: 22, cache: pnpm}`,
    );
    expect(flow.withKeys.map((k: { key: string }) => k.key)).toEqual(['node-version', 'cache']);

    const anchored = onePin(
      `      - uses: actions/setup-node@${SHA_A} # v5.0.0\n        with: *shared-inputs`,
    );
    expect(anchored.withUnreadable).toBe(2);
    const findings = await verifyPinInputs(anchored, () => {
      throw new Error('metadata must not be fetched for an unreadable with block');
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toBe('with-unreadable');
  });
});

describe('input existence — action metadata parsing (#750)', () => {
  it('reads declared inputs, lowercased, skipping nested description blocks', () => {
    const parsed = parseActionInputs(
      [
        'name: demo',
        'inputs:',
        '  Fail-On-Severity:',
        '    description: |',
        '      threshold: HIGH means anything at or above',
        '    default: HIGH',
        "  'quoted-input':",
        '    required: true',
        'runs:',
        '  using: node20',
      ].join('\n'),
    );
    expect(parsed).toBeDefined();
    expect([...(parsed as { inputs: Set<string> }).inputs].sort()).toEqual([
      'fail-on-severity',
      'quoted-input',
    ]);
    expect((parsed as { docker: boolean }).docker).toBe(false);
  });

  it('reads CRLF metadata — actions/checkout ships action.yml with \\r\\n (measured live)', () => {
    const parsed = parseActionInputs(
      'name: x\r\ninputs:\r\n  repository:\r\n    default: me\r\n  path:\r\nruns:\r\n  using: node20\r\n',
    );
    expect([...(parsed as { inputs: Set<string> }).inputs].sort()).toEqual(['path', 'repository']);
  });

  it('treats a missing `inputs:` key and an empty `inputs: {}` as DECLARES NOTHING (an answer)', () => {
    expect(parseActionInputs('name: x\nruns:\n  using: node20')?.inputs.size).toBe(0);
    expect(parseActionInputs('name: x\ninputs: {}\nruns:\n  using: node20')?.inputs.size).toBe(0);
  });

  it('returns UNREADABLE (undefined) for an `inputs:` value it cannot be sure about', () => {
    expect(parseActionInputs('inputs: *anchored')).toBeUndefined();
  });

  it('detects a Docker container action', () => {
    const parsed = parseActionInputs(
      'inputs:\n  arg-one:\nruns:\n  using: docker\n  image: Dockerfile',
    );
    expect(parsed?.docker).toBe(true);
  });

  it('reads reusable-workflow inputs from on.workflow_call.inputs', () => {
    const parsed = parseWorkflowCallInputs(
      [
        'on:',
        '  workflow_call:',
        '    inputs:',
        '      environment:',
        '        type: string',
        '      Dry-Run:',
        '        type: boolean',
        'jobs: {}',
      ].join('\n'),
    );
    expect([...(parsed as { inputs: Set<string> }).inputs].sort()).toEqual([
      'dry-run',
      'environment',
    ]);
  });
});

describe('input existence — the verdict (#750)', () => {
  const trivyPin = (withLines: string[]) =>
    onePin(
      [
        `      - uses: aquasecurity/trivy-action@${SHA_A} # v0.36.0`,
        '        with:',
        ...withLines.map((l) => `          ${l}`),
      ].join('\n'),
    );

  const metadata = (inputs: string[], using = 'node20') =>
    ['inputs:', ...inputs.map((name) => `  ${name}:`), 'runs:', `  using: ${using}`].join('\n');

  const apiServing = (text: string, calls?: string[]) => async (path: string) => {
    calls?.push(path);
    if (path.includes('/contents/action.yml')) return contentsOk(text);
    return { status: 404, body: {} };
  };

  it('an unknown passed key is a FAILURE naming the key, its line, and the declared set', async () => {
    const pin = trivyPin(['severity: HIGH', 'fail-on-severity: HIGH']);
    const findings = await verifyPinInputs(pin, ({ owner, repo, subpath, sha }) =>
      fetchDeclaredInputs({
        owner,
        repo,
        subpath,
        sha,
        api: apiServing(metadata(['severity', 'exit-code'])),
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toBe('unknown-input');
    expect(findings[0].inputKey).toBe('fail-on-severity');
    expect(findings[0].line).toBe(4);
    expect(findings[0].declaredInputs).toEqual(['exit-code', 'severity']);

    const rendered = formatFinding(findings[0]);
    expect(rendered).toContain('fail-on-severity');
    expect(rendered).toContain('exit-code, severity');
    expect(rendered).toContain('IGNORES');
  });

  it('matches case-insensitively, as the runner does', async () => {
    const pin = trivyPin(['Severity: HIGH']);
    const findings = await verifyPinInputs(pin, ({ owner, repo, subpath, sha }) =>
      fetchDeclaredInputs({ owner, repo, subpath, sha, api: apiServing(metadata(['severity'])) }),
    );
    expect(findings).toEqual([]);
  });

  it('accepts the runner-defined args/entrypoint for a DOCKER action only', async () => {
    const pin = trivyPin(['args: scan']);
    const forUsing = (using: string) =>
      verifyPinInputs(pin, ({ owner, repo, subpath, sha }) =>
        fetchDeclaredInputs({ owner, repo, subpath, sha, api: apiServing(metadata([], using)) }),
      );
    expect(await forUsing('docker')).toEqual([]);
    const node = await forUsing('node20');
    expect(node).toHaveLength(1);
    expect(node[0].reason).toBe('unknown-input');
  });

  it('reds when NO metadata file exists at the pinned commit — unverifiable, and not an action', async () => {
    const pin = trivyPin(['severity: HIGH']);
    const findings = await verifyPinInputs(pin, ({ owner, repo, subpath, sha }) =>
      fetchDeclaredInputs({
        owner,
        repo,
        subpath,
        sha,
        api: async () => ({ status: 404, body: {} }),
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toBe('action-metadata-missing');
    expect(findings[0].tried).toEqual(['action.yml', 'action.yaml']);
  });

  it('treats an API failure as a FAILURE, never a pass', async () => {
    const pin = trivyPin(['severity: HIGH']);
    const findings = await verifyPinInputs(pin, ({ owner, repo, subpath, sha }) =>
      fetchDeclaredInputs({
        owner,
        repo,
        subpath,
        sha,
        api: async () => ({ status: 500, body: { message: 'boom' } }),
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toBe('action-metadata-error');
    expect(findings[0].status).toBe(500);
    expect(formatFinding(findings[0])).toContain('FAILURE, not a pass');
  });

  it('reds on metadata it cannot READ, rather than treating it as declaring nothing', async () => {
    const pin = trivyPin(['severity: HIGH']);
    const findings = await verifyPinInputs(pin, ({ owner, repo, subpath, sha }) =>
      fetchDeclaredInputs({ owner, repo, subpath, sha, api: apiServing('inputs: *anchor') }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toBe('action-metadata-unreadable');
  });

  it('a 403 DIVERTS to the anonymous git route — same rule as the tag resolver (#640)', async () => {
    const pin = trivyPin(['severity: HIGH']);
    const api = async () => ({ status: 403, body: { message: 'IP allow list' } });

    const served = await verifyPinInputs(pin, ({ owner, repo, subpath, sha }) =>
      fetchDeclaredInputs({
        owner,
        repo,
        subpath,
        sha,
        api,
        catFile: ({ path }: { path: string }) =>
          path === 'action.yml'
            ? { kind: 'content', text: metadata(['severity']) }
            : { kind: 'file-missing', message: 'no such path' },
      }),
    );
    expect(served).toEqual([]);

    const blocked = await verifyPinInputs(pin, ({ owner, repo, subpath, sha }) =>
      fetchDeclaredInputs({
        owner,
        repo,
        subpath,
        sha,
        api,
        catFile: () => ({ kind: 'transport-error', message: 'throttled' }),
      }),
    );
    expect(blocked).toHaveLength(1);
    expect(blocked[0].reason).toBe('action-metadata-error');
    expect(blocked[0].status).toBe(403);
    expect(blocked[0].gitFallbackMessage).toBe('throttled');
    const rendered = formatFinding(blocked[0]);
    expect(rendered).toContain('403');
    expect(rendered).toContain('ALSO failed: throttled');
  });

  it('skips only where there is genuinely nothing to check: no with, no SHA, docker:// refs', async () => {
    const never = () => {
      throw new Error('metadata must not be fetched');
    };
    expect(
      await verifyPinInputs(onePin(`      - uses: actions/checkout@${SHA_A} # v7.0.1`), never),
    ).toEqual([]);
    expect(
      await verifyPinInputs(
        onePin('      - uses: actions/checkout@v4 # v4.0.0\n        with:\n          ref: main'),
        never,
      ),
    ).toEqual([]);
    expect(
      await verifyPinInputs(
        onePin(
          `      - uses: docker://alpine@${SHA_A} # v1.0.0\n        with:\n          args: hi`,
        ),
        never,
      ),
    ).toEqual([]);
  });
});

describe('input existence — end to end over a scratch tree (#750)', () => {
  /** A repo whose one workflow passes `bogus-input`; the api double declares only `severity`. */
  const scratchRepo = (withKey: string) => {
    const root = mkdtempSync(join(tmpdir(), 'knext-input-existence-'));
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    const workflow = [
      'jobs:',
      '  scan:',
      '    steps:',
      `      - uses: octo/scanner@${SHA_A} # v1.0.0`,
      '        with:',
      `          ${withKey}: HIGH`,
      `      - uses: octo/scanner@${SHA_A} # v1.0.0`,
      '        with:',
      '          severity: LOW',
    ].join('\n');
    writeFileSync(join(root, '.github/workflows/scan.yml'), workflow);
    writeFileSync(join(root, '.github/workflows/scan-b.yml'), workflow);
    return root;
  };

  const apiDouble = (contentsCalls: string[]) => async (path: string) => {
    if (path.startsWith('repos/octo/scanner/git/ref/tags/')) {
      return { status: 200, body: { object: { type: 'commit', sha: SHA_A } } };
    }
    if (path.includes('/contents/')) {
      contentsCalls.push(path);
      if (path.includes('action.yml')) {
        return contentsOk('inputs:\n  severity:\nruns:\n  using: node20');
      }
      return { status: 404, body: {} };
    }
    return { status: 404, body: {} };
  };

  it('MUTATION PROOF (offline): a bogus input reds, NAMING the key; the corrected key greens', async () => {
    const contentsCalls: string[] = [];
    const red = await verifyPins({
      repoRoot: scratchRepo('bogus-input'),
      api: apiDouble(contentsCalls),
      lsRemote: () => ({ kind: 'transport-error', message: 'unused' }),
    });
    // Two files × one bogus key each; the correct sibling step contributes none.
    expect(red).toHaveLength(2);
    for (const finding of red) {
      expect(finding.reason).toBe('unknown-input');
      expect(finding.inputKey).toBe('bogus-input');
    }
    // Memoised per action@sha: four pins, ONE contents fetch.
    expect(contentsCalls).toHaveLength(1);

    const green = await verifyPins({
      repoRoot: scratchRepo('severity'),
      api: apiDouble([]),
      lsRemote: () => ({ kind: 'transport-error', message: 'unused' }),
    });
    expect(green).toEqual([]);
  });
});

describe('input existence — API transport retry (#750)', () => {
  it('retries a THROWN fetch once; an HTTP status is an ANSWER and is never retried', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    try {
      // Thrown once, then answered: the retry converts a transient reset into
      // the answer — measured on this branch, one such reset fanned out into
      // 62 findings via the memoised cache.
      globalThis.fetch = (async (..._args: Parameters<typeof fetch>): Promise<Response> => {
        calls += 1;
        if (calls === 1) throw new Error('socket reset');
        return { status: 200, json: async () => ({ ok: true }) } as Response;
      }) as typeof fetch;
      expect((await githubApi('rate_limit', { sleep: () => {} })).status).toBe(200);
      expect(calls).toBe(2);

      // An HTTP failure status is an answer: exactly one request.
      calls = 0;
      globalThis.fetch = (async (..._args: Parameters<typeof fetch>): Promise<Response> => {
        calls += 1;
        return { status: 500, json: async () => ({}) } as Response;
      }) as typeof fetch;
      expect((await githubApi('rate_limit', { sleep: () => {} })).status).toBe(500);
      expect(calls).toBe(1);

      // A second thrown transport still THROWS — a retry is not a softened verdict.
      calls = 0;
      globalThis.fetch = (async (..._args: Parameters<typeof fetch>): Promise<Response> => {
        calls += 1;
        throw new Error('socket reset');
      }) as typeof fetch;
      await expect(githubApi('rate_limit', { sleep: () => {} })).rejects.toThrow('socket reset');
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('input existence — the anonymous git content route (#750)', () => {
  it('refuses unsafe owner/repo, commit, and path before anything reaches argv', () => {
    const run = () => {
      throw new Error('git must not run for an unsafe ref');
    };
    expect(gitCatFile({ owner: 'a b', repo: 'x', sha: SHA_A, path: 'action.yml', run }).kind).toBe(
      'transport-error',
    );
    expect(
      gitCatFile({ owner: 'octo', repo: 'x', sha: 'main', path: 'action.yml', run }).kind,
    ).toBe('transport-error');
    expect(
      gitCatFile({ owner: 'octo', repo: 'x', sha: SHA_A, path: '../escape.yml', run }).kind,
    ).toBe('transport-error');
    expect(
      gitCatFile({ owner: 'octo', repo: 'x', sha: SHA_A, path: '--upload-pack=evil', run }).kind,
    ).toBe('transport-error');
  });

  it('distinguishes a TRANSPORT failure (retried, then a failure) from a MISSING FILE (an answer)', () => {
    // Unique repo per scenario: the fetch cache is keyed owner/repo@sha and
    // stores failures deliberately.
    let fetches = 0;
    const failing = (args: string[]) => {
      if (args.includes('fetch')) {
        fetches += 1;
        return { status: 128, stdout: '', stderr: 'connection reset' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const transport = gitCatFile({
      owner: 'octo',
      repo: 'transport-case',
      sha: SHA_A,
      path: 'action.yml',
      run: failing,
      sleep: () => {},
    });
    expect(transport).toEqual({ kind: 'transport-error', message: 'connection reset' });
    expect(fetches).toBe(2); // retried once, like the ls-remote fallback

    const fileMissing = gitCatFile({
      owner: 'octo',
      repo: 'missing-case',
      sha: SHA_A,
      path: 'action.yml',
      run: (args: string[]) =>
        args.includes('cat-file')
          ? { status: 128, stdout: '', stderr: "fatal: path 'action.yml' does not exist" }
          : { status: 0, stdout: '', stderr: '' },
      sleep: () => {},
    });
    expect(fileMissing.kind).toBe('file-missing');
  });
});

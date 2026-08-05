/**
 * Unit coverage for the image-prewarm live-cluster harness
 * (`benchmarks/image-prewarm-oke/`).
 *
 * The harness is the instrument future benchmarks depend on — ADR-0042's Phase 1
 * cold-start A/B runs on the same cluster this one left behind. Its defects are
 * therefore not "benchmark scratch code" defects: they silently corrupt the NEXT
 * measurement, and every one covered here failed **in the direction of the
 * desired conclusion**, which is the only direction that never gets noticed.
 *
 * Each block below names the defect it pins:
 *
 *   A — the run left `imagePrewarm=true` on the CR, so the next benchmark on that
 *       cluster inherits a prewarm DaemonSet and a warm image on every node.
 *   B — a missing observation (no pod matched, or the events query failed) was
 *       counted as "no Pulling event", i.e. as evidence FOR the headline claim.
 *   C — the node-disk `ABORT` was thrown inside a replicate whose caller catches
 *       everything, so it recorded one failure and pulled another 370 MB onto a
 *       node already at the kubelet's image-GC threshold.
 *   E — "only ever touches the harness's OWN repository" was an UNANCHORED
 *       substring grep, and the eviction that follows removes by image ID.
 *   D2 — "ONE application on both arms, asserted by image DIGEST" was asserted by
 *       the file's header comment and by nothing in the file.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  assertPodFacts,
  assertSafeImageRef,
  assertSafeNodeName,
  assertSingleApplication,
  FatalError,
  imageRepo,
  isUsableRow,
  nodeEvictCmd,
  nodeProbeCmd,
  parseNodeProbe,
  repoIdSelector,
  runReplicates,
  unusableReason,
  withRestore,
} from '../benchmarks/image-prewarm-oke/lib.mjs';

const HARNESS = resolve(import.meta.dirname, '../benchmarks/image-prewarm-oke');
const read = (f: string) => readFileSync(resolve(HARNESS, f), 'utf8');

const DIGEST = `sha256:${'a'.repeat(64)}`;
const REF = `registry.example.com/knext/pw@${DIGEST}`;

// ── E: the eviction targets ONE repository, exactly ─────────────────────────
describe('node image matching is anchored to the exact repository (E)', () => {
  // Executable proof, not a text match: run the real awk selector the harness
  // ships against a real `crictl images --digests` table that contains the
  // sibling repositories an unanchored `grep <repo>` would have swallowed.
  const CRICTL_TABLE = [
    'IMAGE                                TAG      DIGEST      IMAGE ID       SIZE',
    'registry.example.com/knext/pw        <none>   aaa         id-exact       370MB',
    'registry.example.com/knext/pw-app    v1       bbb         id-sibling     120MB',
    'registry.example.com/knext/pwx       v2       ccc         id-prefix      90MB',
    'registry.example.com/other/pw        v3       ddd         id-otherns     40MB',
    '',
  ].join('\n');

  const runSelector = (repo: string) =>
    execFileSync('sh', ['-c', `cat <<'EOF' | ${repoIdSelector(repo)}\n${CRICTL_TABLE}EOF`], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter(Boolean);

  it('selects only the exact repository, never a prefix or suffix sibling', () => {
    expect(runSelector('registry.example.com/knext/pw')).toEqual(['id-exact']);
  });

  it('selects nothing for a repository that is merely a substring of a present one', () => {
    expect(runSelector('registry.example.com/knext/p')).toEqual([]);
  });

  it('emits the ID= prefix form used by the presence probe', () => {
    const out = execFileSync(
      'sh',
      [
        '-c',
        `cat <<'EOF' | ${repoIdSelector('registry.example.com/knext/pw', 'ID=')}\n${CRICTL_TABLE}EOF`,
      ],
      { encoding: 'utf8' },
    ).trim();
    expect(out).toBe('ID=id-exact');
  });

  it('neither the probe nor the evict command greps for the repository', () => {
    // Both halves: the anchored construct must be PRESENT in each command, and
    // no unanchored substring match may appear anywhere in them.
    for (const cmd of [nodeProbeCmd(REF), nodeEvictCmd(REF)]) {
      expect(cmd).toContain('$1 == repo');
      expect(cmd).not.toMatch(/grep/);
    }
  });

  it('the shipped harness sources contain no unanchored repo grep', () => {
    // Scanned, not enumerated: any future `grep ${REPO}` / `grep "$REPO"` in the
    // harness fails this regardless of which file it is added to.
    //
    // Comment lines are stripped first — every one of these files now DESCRIBES
    // the construct it removed, and a scan that cannot tell the description from
    // the thing would force the explanation out of the code. Executable lines
    // only, which is also the only place the defect could live.
    const code = (file: string) =>
      read(file)
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*|#)/.test(line))
        .join('\n');
    for (const file of ['measure.mjs', 'lib.mjs', 'nodesh.sh']) {
      expect(code(file)).not.toMatch(/grep\s+[^|\n]*\$\{?(REPO|IMAGE)\b/);
    }
  });
});

// ── E (second half): the ref is interpolated into a ROOT nsenter shell ───────
describe('image refs and node names are validated before reaching a root shell (E)', () => {
  it('accepts a digest-pinned reference', () => {
    expect(assertSafeImageRef(REF)).toBe(REF);
    expect(imageRepo(REF)).toBe('registry.example.com/knext/pw');
  });

  it.each([
    ['command substitution', `registry.example.com/knext/pw@${DIGEST}$(reboot)`],
    ['backticks', `registry.example.com/knext/\`reboot\`@${DIGEST}`],
    ['a chained command', `registry.example.com/knext/pw@${DIGEST}; rm -rf /`],
    ['a pipe', `registry.example.com/knext/pw@${DIGEST}|sh`],
    ['whitespace', `registry.example.com/knext/pw @${DIGEST}`],
    ['a newline', `registry.example.com/knext/pw@${DIGEST}\nreboot`],
    ['a single quote', `registry.example.com/kne'xt/pw@${DIGEST}`],
    ['a tag instead of a digest', 'registry.example.com/knext/pw:1.0'],
    ['a truncated digest', 'registry.example.com/knext/pw@sha256:abc'],
  ])('rejects %s', (_label, ref) => {
    expect(() => assertSafeImageRef(ref)).toThrow(FatalError);
  });

  it.each([
    ['10.0.1.253', true],
    ['node-1.subdomain.example.com', true],
    ['10.0.1.253 ; reboot', false],
    ['$(reboot)', false],
    ['node\nreboot', false],
  ])('node name %s -> valid=%s', (node, valid) => {
    if (valid) expect(assertSafeNodeName(node as string)).toBe(node);
    else expect(() => assertSafeNodeName(node as string)).toThrow(FatalError);
  });
});

// ── B: an absent observation must FAIL the replicate ────────────────────────
describe('missing observations fail the replicate, never default to favourable (B)', () => {
  const facts = {
    pod: 'pw-abc',
    node: '10.0.1.253',
    pulling: false,
    containers: [{ name: 'user-container', image: REF }],
  };

  it('accepts a complete observation', () => {
    expect(() => assertPodFacts(facts, { expectImage: REF })).not.toThrow();
  });

  it('fails when no pod matched the request window (facts null)', () => {
    expect(() => assertPodFacts(null, { expectImage: REF })).toThrow(FatalError);
  });

  it('fails when the events query failed rather than reporting "no Pulling"', () => {
    expect(() =>
      assertPodFacts({ ...facts, eventsError: 'connection refused' }, { expectImage: REF }),
    ).toThrow(/events/i);
  });

  it('fails when `pulling` is not a boolean', () => {
    expect(() => assertPodFacts({ ...facts, pulling: undefined }, { expectImage: REF })).toThrow(
      FatalError,
    );
  });

  it('fails when the measured pod did not run the image under test', () => {
    const other = {
      ...facts,
      containers: [{ name: 'user-container', image: 'other/app@sha256:b' }],
    };
    expect(() => assertPodFacts(other, { expectImage: REF })).toThrow(/digest/i);
  });

  it('analysis rejects a row with no `pulling` key instead of counting it as "no Pulling"', () => {
    const row = { mode: 'off', cold_ttfb_ms: 4200, node: '10.0.1.253' };
    expect(isUsableRow(row)).toBe(false);
    expect(unusableReason(row)).toMatch(/pulling/i);
    expect(isUsableRow({ ...row, pulling: true })).toBe(true);
  });
});

// ── D2: one application on both arms, asserted by digest ────────────────────
describe('one application on both arms, asserted by digest (D2)', () => {
  it('passes when the active revision runs exactly the image under test', () => {
    expect(() =>
      assertSingleApplication({ pwImage: REF, revisionImage: REF, revision: 'pw-00002' }),
    ).not.toThrow();
  });

  it('aborts when the revision runs a different digest of the same repository', () => {
    expect(() =>
      assertSingleApplication({
        pwImage: REF,
        revisionImage: `registry.example.com/knext/pw@sha256:${'b'.repeat(64)}`,
        revision: 'pw-00002',
      }),
    ).toThrow(FatalError);
  });

  it('aborts when the revision image cannot be read', () => {
    expect(() =>
      assertSingleApplication({ pwImage: REF, revisionImage: '', revision: 'pw-00002' }),
    ).toThrow(FatalError);
  });
});

// ── C: a fatal precondition aborts the RUN, not one replicate ───────────────
describe('fatal conditions abort the whole run (C)', () => {
  const order = ['on', 'off'];

  it('records an ordinary replicate failure and keeps going', async () => {
    const recorded: unknown[] = [];
    let calls = 0;
    await runReplicates({
      first: 1,
      pairs: 2,
      order,
      record: (r) => recorded.push(r),
      run: async () => {
        calls++;
        if (calls === 2) throw new Error('transient');
      },
    });
    expect(calls).toBe(4);
    expect(recorded).toHaveLength(1);
  });

  it('stops immediately on a FatalError and records it', async () => {
    const recorded: Array<{ failed?: string; fatal?: boolean }> = [];
    let calls = 0;
    await expect(
      runReplicates({
        first: 1,
        pairs: 2,
        order,
        record: (r) => recorded.push(r as never),
        run: async () => {
          calls++;
          if (calls === 2) throw new FatalError('node disk at 86%');
        },
      }),
    ).rejects.toThrow(/86%/);
    expect(calls).toBe(2); // it did NOT pull another image onto a full node
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.fatal).toBe(true);
  });

  it('the disk check the harness ships is a FatalError', () => {
    // Both halves: the abort must exist AND be of the aborting kind.
    const src = read('measure.mjs');
    expect(src).toMatch(/DISK_ABORT_PCT/);
    expect(src).toMatch(/throw new FatalError\([\s\S]{0,200}root disk/);
  });

  it('parseNodeProbe refuses to guess when presence is indeterminate', () => {
    // No PRESENT/ABSENT marker at all: the probe did not run, so presence is
    // unknown — and unknown must never resolve to either arm's expectation.
    expect(() => parseNodeProbe('ID=0123abcd\n41%')).toThrow(FatalError);
    expect(() => parseNodeProbe('crictl: connection refused')).toThrow(FatalError);
    expect(parseNodeProbe('PRESENT\nID=0123abcd\n41%')).toEqual({
      present: true,
      ids: ['0123abcd'],
      diskPct: 41,
    });
    expect(parseNodeProbe('ABSENT\n41%')).toEqual({ present: false, ids: [], diskPct: 41 });
  });
});

// ── A: the run restores the CR state it found ───────────────────────────────
describe('the harness restores the pre-run imagePrewarm state (A)', () => {
  it('restores after a successful run and verifies by read-back', async () => {
    let state = false;
    const log: string[] = [];
    await withRestore({
      read: () => state,
      write: (v: boolean) => {
        state = v;
      },
      log: (m: string) => log.push(m),
      body: async () => {
        state = true; // what the replicates do
      },
    });
    expect(state).toBe(false);
    expect(log.join('\n')).toMatch(/restored/i);
  });

  it('restores even when the run throws, and still surfaces the original error', async () => {
    let state = false;
    await expect(
      withRestore({
        read: () => state,
        write: (v: boolean) => {
          state = v;
        },
        body: async () => {
          state = true;
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
    expect(state).toBe(false);
  });

  it('fails loudly when the restore does not take effect (observable restore)', async () => {
    let state = false;
    await expect(
      withRestore({
        read: () => state,
        write: () => {
          /* a write that silently does nothing */
        },
        body: async () => {
          state = true;
        },
      }),
    ).rejects.toThrow(/restore/i);
  });

  it('measure.mjs wires the restore around the replicate loop', () => {
    const src = read('measure.mjs');
    expect(src).toMatch(/withRestore\(/);
    expect(src).toMatch(/runReplicates\(/);
  });
});

// ── F: the settle floor is measured from the end of the node work ───────────
describe('the settle floor is symmetric across arms (F)', () => {
  it('measure.mjs starts the floor after the precondition work, not before', () => {
    const src = read('measure.mjs');
    // The clock the floor is computed against must be established AFTER the
    // eviction/probe Jobs, and the pre-request quiet time is recorded per row.
    expect(src).toMatch(/quietFrom/);
    expect(src).toMatch(/SETTLE_FLOOR_MS - \(Date\.now\(\) - quietFrom\)/);
    expect(src).toMatch(/precondition_ms/);
  });
});

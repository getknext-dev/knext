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
 *   A2 — the restore only ran on the normal exit path, so Ctrl-C on a ~100 minute
 *       run skipped it entirely and left A behind in its original shape.
 *   B — a missing observation (no pod matched, or the events query failed) was
 *       counted as "no Pulling event", i.e. as evidence FOR the headline claim.
 *   B2 — that fix over-corrected: an absent observation aborted the RUN, throwing
 *       away hours on a shared cluster for a transient the next replicate would
 *       not have hit. `FatalError` means "continuing corrupts something"; a missed
 *       pod window does not.
 *   C — the node-disk `ABORT` was thrown inside a replicate whose caller catches
 *       everything, so it recorded one failure and pulled another 370 MB onto a
 *       node already at the kubelet's image-GC threshold.
 *   E — "only ever touches the harness's OWN repository" was an UNANCHORED
 *       substring grep, and the eviction that follows removes by image ID.
 *   D2 — "ONE application on both arms, asserted by image DIGEST" was asserted by
 *       the file's header comment and by nothing in the file.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { PodFacts } from '../benchmarks/image-prewarm-oke/lib.mjs';
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

/**
 * Every executable source in the harness TREE, harness-relative, recursively.
 *
 * The scans below are only as wide as this walk: a flat `readdirSync` made the
 * first subdirectory anyone adds invisible to them, and nothing would have said
 * so.
 */
const harnessSources = (dir: string = HARNESS, prefix = ''): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'results' || entry.name.startsWith('.')) {
        return [];
      }
      return harnessSources(join(dir, entry.name), `${prefix}${entry.name}/`);
    }
    return /\.(mjs|js|sh)$/.test(entry.name) ? [`${prefix}${entry.name}`] : [];
  });

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

  // Any grep whose PATTERN is an interpolated repo/image variable, in ANY
  // spelling. The previous form was `\$\{?(REPO|IMAGE)\b` — keyed to the
  // SHOUTING spelling only, so `grep ${repo}` (the identifier `lib.mjs` itself
  // uses) sailed through the guard meant to catch exactly it. A scan coupled to
  // one case is an enumeration wearing a regex.
  const UNANCHORED_REPO_GREP = /grep\s+[^|\n]*["']?\$\{?[A-Za-z_]*(?:repo|image)/i;

  it('the regex itself matches every spelling of the construct it bans', () => {
    // The guard's own both-halves check: a scan is only as good as what it
    // matches, so the matcher is exercised on the shapes it must catch AND on
    // the shapes it must not, before it is pointed at the tree.
    for (const bad of [
      'crictl images | grep ${REPO}',
      'crictl images | grep ${repo}',
      'crictl images | grep "$REPO"',
      'crictl images | grep "$imageRepo"',
      'crictl images | grep $IMAGE_REPO',
      "crictl images | grep '$repo'",
      'crictl images | GREP ${Repo}',
    ]) {
      expect(bad).toMatch(UNANCHORED_REPO_GREP);
    }
    for (const fine of [
      "awk -v repo='x' '$1 == repo { print $4 }'",
      'grep -c PRESENT',
      'crictl images | grep "$1"',
    ]) {
      expect(fine).not.toMatch(UNANCHORED_REPO_GREP);
    }
  });

  it('the shipped harness sources contain no unanchored repo grep', () => {
    // Scanned, not enumerated, in BOTH dimensions: every executable file in the
    // harness TREE is read from disk (a new file cannot dodge the guard by not
    // being on a list), and the pattern above is spelling-agnostic.
    //
    // RECURSIVE, which it was not: a flat `readdirSync(HARNESS)` means the first
    // subdirectory anyone adds escapes the guard silently, with only a
    // `toBeGreaterThanOrEqual(4)` floor standing in for the missing files — and
    // that floor is satisfied by the four top-level files that already exist.
    //
    // Comment lines are stripped first — every one of these files now DESCRIBES
    // the construct it removed, and a scan that cannot tell the description from
    // the thing would force the explanation out of the code. Executable lines
    // only, which is also the only place the defect could live.
    const files = harnessSources();
    expect(files.length).toBeGreaterThanOrEqual(4); // the discovery itself must work
    for (const file of files) {
      const code = read(file)
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*|#)/.test(line))
        .join('\n');
      expect(code, `${file} greps for an interpolated repository`).not.toMatch(
        UNANCHORED_REPO_GREP,
      );
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

  // B2 — the split. `FatalError` is defined as "continuing would corrupt the
  // cluster, the run, or the NEXT run", and it aborts a ~100 minute run on a
  // shared cluster. A missed pod window or a transient events hiccup corrupts
  // nothing: it fails THE REPLICATE, is recorded as failed, and the loop steps
  // over it — which is also what three doc sites always claimed it did. Only a
  // WRONG IMAGE is fatal: it means the two arms are not one application, so
  // every remaining replicate would measure something else.
  // Typed against the function's declared parameter, not `unknown` behind a
  // cast: `as never` disables checking on the very argument under test.
  const missing: Array<[string, PodFacts | null]> = [
    ['no pod matched the request window', null],
    ['the events query failed', { ...facts, eventsError: 'connection refused' }],
    ['`pulling` is not a boolean', { ...facts, pulling: undefined }],
  ];

  it.each(missing)('fails the replicate — not the run — when %s', (_label, input) => {
    // Both halves: it must THROW (never silently return a favourable default)
    // and the throw must NOT be of the run-aborting kind.
    expect(() => assertPodFacts(input, { expectImage: REF })).toThrow();
    try {
      assertPodFacts(input, { expectImage: REF });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(FatalError);
    }
  });

  it('names the events query in its failure, so the row says why', () => {
    expect(() =>
      assertPodFacts({ ...facts, eventsError: 'connection refused' }, { expectImage: REF }),
    ).toThrow(/events/i);
  });

  it('a replicate-level failure is RECORDED and the run continues', async () => {
    // The split proved end to end through the loop that consumes it, not just
    // by the class of the error object.
    const recorded: Array<{ fatal?: boolean }> = [];
    let calls = 0;
    await runReplicates({
      first: 1,
      pairs: 1,
      order: ['on', 'off'],
      record: (r) => recorded.push(r),
      run: async () => {
        calls++;
        if (calls === 1) assertPodFacts(null, { expectImage: REF });
      },
    });
    expect(calls).toBe(2);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.fatal).toBe(false);
  });

  it('ABORTS THE RUN when the measured pod did not run the image under test', () => {
    // The one genuinely fatal case: the arms are not the same application, so
    // continuing measures a different program under both labels.
    const other = {
      ...facts,
      containers: [{ name: 'user-container', image: 'other/app@sha256:b' }],
    };
    expect(() => assertPodFacts(other, { expectImage: REF })).toThrow(FatalError);
    expect(() => assertPodFacts(other, { expectImage: REF })).toThrow(/digest/i);
  });

  it('the harness prose agrees with the code about what a missing observation does', () => {
    // The defect this pins is not in the code — it is code and three doc sites
    // stating DIFFERENT things, which is how the next reader learns the wrong
    // rule. `FatalError` may not be claimed for the absent-observation path.
    const sites = [
      read('measure.mjs'),
      read('lib.mjs'),
      read('README.md'),
      readFileSync(resolve(HARNESS, '../../docs/benchmarks/image-prewarm-oke.md'), 'utf8'),
    ];
    for (const src of sites) {
      // Each site must say the replicate fails …
      expect(src).toMatch(/FAILS? the replicate|fails the replicate|failed replicate/i);
      // … and none may describe an absent observation as aborting the run.
      expect(src).not.toMatch(/absent observation[^.]{0,80}abort/i);
    }
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
        record: (r) => recorded.push(r),
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

// ── A2: Ctrl-C on a ~100 minute run must restore too ────────────────────────
describe('an INTERRUPTED run restores the pre-run imagePrewarm state (A2)', () => {
  const harness = (over: Record<string, unknown> = {}) => {
    const listeners: Record<string, () => void> = {};
    const exits: number[] = [];
    const log: string[] = [];
    const state = { value: false };
    return {
      listeners,
      exits,
      log,
      state,
      opts: {
        read: () => state.value,
        write: (v: boolean) => {
          state.value = v;
        },
        log: (m: string) => log.push(m),
        proc: {
          on: (sig: string, fn: () => void) => {
            listeners[sig] = fn;
          },
          off: (sig: string) => {
            delete listeners[sig];
          },
          exit: (code: number) => exits.push(code),
        },
        ...over,
      },
    };
  };

  it.each(['SIGINT', 'SIGTERM'])('%s mid-run restores and exits non-zero', async (signal) => {
    const h = harness();
    let released: () => void = () => {};
    const running = withRestore({
      ...h.opts,
      body: async () => {
        h.state.value = true; // what the replicates do
        await new Promise<void>((r) => {
          released = r;
        });
      },
    });
    // let the body start and set the cluster state it must not leave behind
    await new Promise((r) => setTimeout(r, 0));
    expect(h.state.value).toBe(true);
    expect(Object.keys(h.listeners)).toEqual(expect.arrayContaining(['SIGINT', 'SIGTERM']));

    h.listeners[signal]?.();

    expect(h.state.value).toBe(false); // restored, synchronously, in the handler
    expect(h.log.join('\n')).toMatch(/restored/i);
    expect(h.exits).toEqual([signal === 'SIGINT' ? 130 : 143]);
    released();
    // The promise is ASSERTED, not swallowed. `await running.catch(() => {})`
    // discards exactly the outcome the sibling test below exists to observe.
    await expect(running).resolves.toBeUndefined();
  });

  it('the signal restore is READ BACK, and a write that does nothing is loud', async () => {
    const h = harness({ write: () => {} /* a write that silently does nothing */ });
    let released: () => void = () => {};
    const running = withRestore({
      ...h.opts,
      write: () => {},
      body: async () => {
        h.state.value = true;
        await new Promise<void>((r) => {
          released = r;
        });
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    h.listeners.SIGINT?.();
    expect(h.log.join('\n')).toMatch(/RESTORE FAILED/);
    expect(h.exits).toEqual([1]); // a failed restore is not a clean interrupt
    released();
    // …and the FAILURE must leave the function, not just the log. The memo used
    // to hardcode `{ restored: true }` for the second caller, so a handler-path
    // restore that genuinely failed produced a clean resolve here. Production
    // is masked from that only by `process.exit(1)` in the handler — and moving
    // `unregister()` after the final restore makes the window live.
    await expect(running).rejects.toThrow(FatalError);
    await expect(running).rejects.toThrow(/RESTORE FAILED/);
  });

  it('removes its handlers on the normal path, and restores exactly once', async () => {
    const h = harness();
    const writes: boolean[] = [];
    await withRestore({
      ...h.opts,
      write: (v: boolean) => {
        writes.push(v);
        h.state.value = v;
      },
      body: async () => {
        h.state.value = true;
      },
    });
    expect(h.state.value).toBe(false);
    expect(writes).toEqual([false]); // the handler did not also fire
    expect(Object.keys(h.listeners)).toEqual([]); // no leaked process listeners
  });

  it('the FINAL restore runs with its signal protection still installed', async () => {
    // The single most important write in the harness used to execute with its
    // own protection deliberately removed one line earlier: `unregister()` sat
    // BEFORE the final `restore()`. That write is a slow synchronous
    // `execFileSync` kubectl patch, so a Ctrl-C landing in it — the likeliest
    // Ctrl-C moment there is, an operator waiting out the tail of a ~100 minute
    // run — hit the default disposition and killed the process mid-restore,
    // leaving `imagePrewarm=true`: exactly the state the mechanism exists to
    // prevent, and with no handler log to say so.
    //
    // Both halves: installed DURING the write, and gone once it has landed.
    const h = harness();
    let installedDuringWrite: string[] = [];
    await withRestore({
      ...h.opts,
      write: (v: boolean) => {
        installedDuringWrite = Object.keys(h.listeners);
        h.state.value = v;
      },
      body: async () => {
        h.state.value = true;
      },
    });
    expect(installedDuringWrite).toEqual(expect.arrayContaining(['SIGINT', 'SIGTERM']));
    expect(Object.keys(h.listeners)).toEqual([]);
  });

  it('a REAL SIGINT to a REAL process restores the state (signal path proved end to end)', async () => {
    // A handler that is registered but never exercised is decoration. This
    // sends the actual signal to an actual node process running the actual
    // `withRestore`, with the "cluster" being a file on disk.
    const dir = mkdtempSync(join(tmpdir(), 'prewarm-sigint-'));
    const statePath = join(dir, 'imagePrewarm');
    const readyPath = join(dir, 'ready');
    writeFileSync(statePath, 'false');
    const script = join(dir, 'run.mjs');
    writeFileSync(
      script,
      `import { readFileSync, writeFileSync } from 'node:fs';
       import { withRestore } from ${JSON.stringify(resolve(HARNESS, 'lib.mjs'))};
       await withRestore({
         read: () => readFileSync(${JSON.stringify(statePath)}, 'utf8') === 'true',
         write: (v) => writeFileSync(${JSON.stringify(statePath)}, String(v)),
         log: (m) => console.log(m),
         body: async () => {
           writeFileSync(${JSON.stringify(statePath)}, 'true');  // the arm the run leaves set
           writeFileSync(${JSON.stringify(readyPath)}, 'go');
           // A long run. The interval is what KEEPS IT RUNNING: a signal
           // listener is not a libuv handle, so without in-flight work node
           // would exit on an empty loop and prove nothing. The real harness is
           // never idle here — it is inside kubectl/fetch.
           await new Promise(() => setInterval(() => {}, 1000));
         },
       });`,
    );

    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      out += d;
    });

    const deadline = Date.now() + 15000;
    while (readFileSync(statePath, 'utf8') !== 'true') {
      if (Date.now() > deadline) throw new Error(`child never started: ${out}`);
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(readFileSync(statePath, 'utf8')).toBe('true');

    const code = await new Promise<number | null>((r) => {
      child.on('exit', (c) => r(c));
      child.kill('SIGINT');
    });

    expect(readFileSync(statePath, 'utf8')).toBe('false'); // Ctrl-C restored it
    expect(out).toMatch(/restored/i);
    expect(code).toBe(130);
  }, 20000);

  it('a REAL SIGINT DURING the final restore still lands the restore', async () => {
    // The window the unit test above pins, proved the way the reviewer proved
    // it: a real signal to a real process, arriving while the restoring write
    // is in flight. The write here is SLOW and SYNCHRONOUS on purpose — that is
    // what `execFileSync('kubectl', ['patch', …])` is.
    //
    // With `unregister()` before the restore, the SIGINT hits the default
    // disposition and kills the process mid-write: the file stays 'true' and
    // nothing is logged. With it after, the same signal is harmless.
    const dir = mkdtempSync(join(tmpdir(), 'prewarm-sigint-restore-'));
    const statePath = join(dir, 'imagePrewarm');
    const restoringPath = join(dir, 'restoring');
    writeFileSync(statePath, 'false');
    const script = join(dir, 'run.mjs');
    writeFileSync(
      script,
      `import { readFileSync, writeFileSync } from 'node:fs';
       import { withRestore } from ${JSON.stringify(resolve(HARNESS, 'lib.mjs'))};
       await withRestore({
         read: () => readFileSync(${JSON.stringify(statePath)}, 'utf8') === 'true',
         write: (v) => {
           // Announce that the restoring write has STARTED, then block for a
           // while: this is the slow synchronous kubectl patch.
           writeFileSync(${JSON.stringify(restoringPath)}, 'now');
           const until = Date.now() + 3000;
           while (Date.now() < until) {}
           writeFileSync(${JSON.stringify(statePath)}, String(v));
         },
         log: (m) => console.log(m),
         body: async () => { writeFileSync(${JSON.stringify(statePath)}, 'true'); },
       });`,
    );

    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      out += d;
    });

    const deadline = Date.now() + 15000;
    while (!existsSync(restoringPath)) {
      if (Date.now() > deadline) throw new Error(`child never reached its restore: ${out}`);
      await new Promise((r) => setTimeout(r, 10));
    }
    child.kill('SIGINT'); // squarely inside the restoring write
    await new Promise<void>((r) => child.on('exit', () => r()));

    expect(
      readFileSync(statePath, 'utf8'),
      'the process was killed mid-restore and left imagePrewarm set',
    ).toBe('false');
    expect(out).toMatch(/restored/i);
  }, 25000);
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

  it('publishes total time-at-zero per arm — the asymmetry the F fix moved (F2)', () => {
    // Equalising quiet UNEQUALISES total time at zero (the `off` arm now sits
    // ~60 s longer, because its node work is inside that window). The harness
    // records `at_zero_ms` but used to never print it, so the remaining
    // asymmetry was derivable-but-unstated. Both halves: it is recorded AND
    // reported, per arm, never pooled.
    expect(read('measure.mjs')).toMatch(/at_zero_ms/);
    const analyze = read('analyze.mjs');
    expect(analyze).toMatch(/at_zero_ms/);
    expect(analyze).toMatch(/time at zero/i);
  });

  it('analyze.mjs reports time-at-zero stratified by arm, from real rows', () => {
    // Executable, not a text match: run the shipped analyzer over a fixture in
    // which the two arms differ ONLY in time at zero, and require both figures
    // to appear in its output.
    const dir = mkdtempSync(join(tmpdir(), 'prewarm-analyze-'));
    const file = join(dir, 'results.jsonl');
    const row = (mode: string, atZero: number, idx: number) => ({
      ts: '2026-08-05T00:00:00Z',
      pair: 1,
      idx,
      mode,
      image: REF,
      endpoint: '/api/health',
      revision: 'pw-00002',
      cold_ttfb_ms: 2000 + idx,
      warm_ttfb_ms: 100,
      pulling: mode === 'off',
      node: '10.0.1.253',
      settle_ms: 150000,
      precondition_ms: mode === 'off' ? 72000 : 13000,
      at_zero_ms: atZero,
      pulledMsgs: [],
    });
    writeFileSync(
      file,
      `${[row('on', 163000, 1), row('off', 222000, 2), row('off', 224000, 3), row('on', 164000, 4)]
        .map((r) => JSON.stringify(r))
        .join('\n')}\n`,
    );
    const out = execFileSync(process.execPath, [resolve(HARNESS, 'analyze.mjs'), file], {
      encoding: 'utf8',
    });
    const section = (mode: string) => out.split(`imagePrewarm=${mode}`)[1]?.split('##')[0] ?? '';
    expect(section('true')).toMatch(/time at zero[^\n]*"median":163/i);
    expect(section('false')).toMatch(/time at zero[^\n]*"median":223/i);
  });
});

// ── E (third half): EVERY value interpolated into the privileged pod spec ───
describe('every value interpolated into the nodesh pod spec is validated (E3)', () => {
  const NODESH = resolve(HARNESS, 'nodesh.sh');
  const PINNED = `alpine:3.20@sha256:${'d'.repeat(64)}`;

  /**
   * A stub `kubectl` (captures what would be applied) and a stub `mktemp` with
   * GNU coreutils semantics, both first on PATH.
   *
   * The `mktemp` stub is not scenery. `mktemp -t nodesh` is BSD syntax: macOS
   * accepts it, GNU coreutils answers "too few X's in template" and, under
   * `set -e`, nodesh.sh dies BEFORE applying anything. Every positive-path
   * assertion below therefore passed on a developer Mac while the whole
   * no-prewarm arm (image eviction) was dead on every Linux runner and on any
   * Linux host the harness is driven from. Imposing GNU semantics here makes
   * this suite fail the same way CI does.
   */
  const stubs = () => {
    const dir = mkdtempSync(join(tmpdir(), 'nodesh-'));
    const applied = join(dir, 'applied.yaml');
    writeFileSync(
      join(dir, 'kubectl'),
      `#!/bin/sh\nfor a in "$@"; do case "$a" in *.yaml|*nodesh*) [ -f "$a" ] && cat "$a" >> ${applied};; esac; done\nexit 0\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(dir, 'mktemp'),
      [
        '#!/bin/sh',
        '# GNU coreutils semantics: the template needs at least three trailing X.',
        'tmpl=',
        'while [ $# -gt 0 ]; do',
        '  case "$1" in',
        '    -t) shift; tmpl="${TMPDIR:-/tmp}/$1" ;;',
        '    -*) ;;',
        '    *) tmpl="$1" ;;',
        '  esac',
        '  shift',
        'done',
        '[ -n "$tmpl" ] || tmpl="${TMPDIR:-/tmp}/tmp.XXXXXXXXXX"',
        'body=$tmpl; n=0',
        'while [ "${body%X}" != "$body" ]; do body="${body%X}"; n=$((n+1)); done',
        'if [ "$n" -lt 3 ]; then',
        "  echo \"mktemp: too few X's in template '${tmpl##*/}'\" >&2",
        '  exit 1',
        'fi',
        'i=0',
        'while [ -e "$body$$-$i" ]; do i=$((i+1)); done',
        'f="$body$$-$i"',
        ': > "$f"',
        'chmod 600 "$f"',
        'echo "$f"',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    return { dir, applied };
  };

  /** Run nodesh.sh against those stubs, so nothing reaches a cluster. */
  const runNodesh = (
    env: Record<string, string> = {},
    { node = 'node-1.example.com', cmd = 'echo hi' }: { node?: string; cmd?: string } = {},
  ) => {
    const { dir, applied } = stubs();
    const out = execFileSync(
      'sh',
      ['-c', `"$1" "$2" "$3" 2>&1; echo "EXIT=$?"`, 'sh', NODESH, node, cmd],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...env },
      },
    );
    let spec = '';
    try {
      spec = readFileSync(applied, 'utf8');
    } catch {
      spec = '';
    }
    return { out, spec };
  };

  interface PodSpecDoc {
    metadata: { name: string; namespace: string };
    spec: {
      template: {
        spec: {
          hostPID: boolean;
          nodeName: string;
          containers: Array<{ image: string; command: string[] }>;
        };
      };
    };
  }
  const parseSpec = (spec: string) => parseYaml(spec) as PodSpecDoc;

  it('the mktemp stub really rejects a BSD-only template (the guard is not decoration)', () => {
    // Mutation-proof of the instrument itself: a stub that quietly accepted
    // `-t nodesh` would make every assertion below prove nothing about Linux.
    const { dir } = stubs();
    const out = execFileSync('sh', ['-c', 'mktemp -t nodesh 2>&1; echo "EXIT=$?"'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    expect(out).toMatch(/too few X's in template/);
    expect(out).toMatch(/EXIT=1/);
    // …and it accepts the portable form, so a correct script is not blocked.
    const ok = execFileSync('sh', ['-c', 'mktemp "$TMPDIR/nodesh.XXXXXX" 2>&1; echo "EXIT=$?"'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TMPDIR: dir },
    });
    expect(ok).toMatch(/EXIT=0/);
  });

  it('nodesh.sh creates its spec file with a template GNU mktemp accepts', () => {
    // The whole no-prewarm arm runs through this line. `set -e` + a BSD-only
    // template means nodesh.sh exits 1 before `kubectl apply`, so the eviction
    // never happens and nothing downstream can tell.
    const { out, spec } = runNodesh({});
    expect(out).not.toMatch(/mktemp:|too few X/);
    expect(out).toMatch(/EXIT=0/);
    expect(spec, 'nothing was applied — the script died before its kubectl apply').not.toBe('');
  });

  it.each([
    ['a chained command', 'alpine:3.20@sha256:aaa"}; rm -rf /'],
    ['a YAML break-out', 'alpine\n      hostPID: false'],
    ['command substitution', 'alpine:3.20@sha256:$(reboot)'],
    ['a bare tag with no digest', 'alpine:3.20'],
    ['a truncated digest', 'alpine:3.20@sha256:abc'],
    ['an uppercase digest that is not the pinned one', `alpine:3.20@sha256:${'A'.repeat(64)}`],
    ['a digest with no tag to audit it against', `alpine@sha256:${'d'.repeat(64)}`],
  ])('refuses %s', (_label, image) => {
    // `NODESH_IMAGE` lands inside a PRIVILEGED, hostPID pod spec that nsenters
    // the host — the same reason the node name three lines above it is validated
    // and the same reason `PW_IMAGE` is. It is also an escape from the digest
    // pin: an unvalidated tag ref makes the pin advisory.
    const { out, spec } = runNodesh({ NODESH_IMAGE: image });
    expect(out).toMatch(/refusing|NODESH_IMAGE/i);
    expect(out).toMatch(/EXIT=2/);
    expect(spec).toBe(''); // nothing was applied
  });

  it('accepts a digest-pinned reference and puts exactly it in the spec', () => {
    const { out, spec } = runNodesh({ NODESH_IMAGE: PINNED });
    expect(out).toMatch(/EXIT=0/);
    expect(spec).toContain(`image: ${PINNED}`);
  });

  it('an EMPTY override falls back to the pin rather than to nothing', () => {
    // `${NODESH_IMAGE:-<pin>}` substitutes for unset *and empty*, so an empty
    // value cannot reach the spec — it degrades toward the pin, which is the
    // safe direction. Asserted so the `:-` is not silently changed to `-`.
    const { out, spec } = runNodesh({ NODESH_IMAGE: '' });
    expect(out).toMatch(/EXIT=0/);
    expect(spec).toMatch(/image: [a-z0-9./:-]+@sha256:[0-9a-f]{64}/);
  });

  it('its own default is digest-pinned and passes its own validator', () => {
    // Both halves: the shipped default must be a real digest pin, and it must
    // survive the check — a validator the default fails is one nobody can run.
    const src = read('nodesh.sh');
    expect(src).toMatch(/NODESH_IMAGE:-[a-z0-9./:-]+@sha256:[0-9a-f]{64}/);
    const { out, spec } = runNodesh({});
    expect(out).toMatch(/EXIT=0/);
    expect(spec).toMatch(/image: [a-z0-9./:-]+@sha256:[0-9a-f]{64}/);
  });

  // ── the SCAN: no interpolation may be hardened by being forgotten ──────────
  //
  // The finding this replaces was "harden NODESH_IMAGE", and it was carried out
  // exactly as written: 64 lines of validation for the second of THREE values
  // interpolated into the same privileged, hostPID, `nsenter -t 1` spec. The
  // third — `NS`, from `$NAMESPACE` — went straight into `namespace: $NS`
  // unvalidated, so `NAMESPACE=$'default\n  labels:\n    evil: yes'` injected
  // arbitrary YAML into the applied Job. The finding READ as complete while
  // being hardened at two of three points.
  //
  // So the list is not written here. It is SCANNED out of the heredoc, and a
  // variable with no guard fails — which is the half an enumeration cannot have.
  const HEREDOC = (() => {
    const src = read('nodesh.sh');
    const match = src.match(/\ncat > "\$TMP" <<YAML\n([\s\S]*?)\nYAML\n/);
    if (!match?.[1]) {
      throw new Error(
        'nodesh.sh no longer writes its pod spec with a `cat > "$TMP" <<YAML` heredoc, so this ' +
          'scan can no longer see what the spec interpolates. Update the scan WITH the script — ' +
          'do not delete it.',
      );
    }
    return match[1];
  })();

  const interpolated = [
    ...new Set(
      [...HEREDOC.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].flatMap((m) => (m[1] ? [m[1]] : [])),
    ),
  ].sort();

  /** A value that ends the current YAML line and starts a key of its own. */
  const YAML_BREAKOUT = 'x\n      hostPID: false';

  /** An executable proof, per interpolated variable, that it cannot break out. */
  const GUARDS: Record<string, () => void> = {
    NODE: () => {
      const { out, spec } = runNodesh({}, { node: YAML_BREAKOUT });
      expect(out).toMatch(/refusing node name/i);
      expect(out).toMatch(/EXIT=2/);
      expect(spec).toBe('');
    },
    NS: () => {
      const { out, spec } = runNodesh({ NAMESPACE: 'default\n  labels:\n    evil: injected' });
      expect(out).toMatch(/refusing namespace/i);
      expect(out).toMatch(/EXIT=2/);
      expect(spec).toBe('');
    },
    NODESH_IMAGE: () => {
      const { out, spec } = runNodesh({ NODESH_IMAGE: YAML_BREAKOUT });
      expect(out).toMatch(/refusing NODESH_IMAGE/i);
      expect(out).toMatch(/EXIT=2/);
      expect(spec).toBe('');
    },
    NAME: () => {
      // Derived from `$NODE` (rejected above) plus `$RANDOM`; the proof is that
      // the value that reaches the spec is inert for every ACCEPTED node name.
      const { spec } = runNodesh({}, { node: 'node-1.sub.example.com' });
      expect(parseSpec(spec).metadata.name).toMatch(/^nodesh-[a-z0-9-]+$/);
    },
    B64: () => {
      // The command is base64'd precisely so it cannot express a YAML break —
      // its alphabet has no newline. Proved with a command that contains one.
      const { out, spec } = runNodesh({}, { cmd: "echo 'a'\n      hostPID: false\n#" });
      expect(out).toMatch(/EXIT=0/);
      const doc = parseSpec(spec);
      expect(doc.spec.template.spec.hostPID).toBe(true);
      const command = doc.spec.template.spec.containers[0]?.command ?? [];
      const script = command[command.length - 1] ?? '';
      expect(script).toMatch(/^echo [A-Za-z0-9+/=]+ \| base64 -d \| sh$/);
    },
  };

  it('the scan can see the interpolations it is supposed to police', () => {
    // Both halves: a scan that finds nothing would make every check below vacuous.
    expect(interpolated.length).toBeGreaterThanOrEqual(4);
    expect(interpolated).toEqual(expect.arrayContaining(['NODE', 'NODESH_IMAGE']));
  });

  it('EVERY interpolated variable has a guard — a new one cannot be added silently', () => {
    expect(
      interpolated.filter((name) => !(name in GUARDS)),
      'these values reach the privileged pod spec with nothing proving they cannot break out of it',
    ).toEqual([]);
  });

  it('every guard names a variable the spec really interpolates — no dead entries', () => {
    // The other direction: a guard for a variable the spec stopped using reads
    // as coverage while covering nothing.
    expect(Object.keys(GUARDS).filter((name) => !interpolated.includes(name))).toEqual([]);
  });

  it.each(Object.keys(GUARDS))('%s cannot break out of the privileged pod spec', (name) => {
    GUARDS[name]?.();
  });
});

// ── the README's caveat must name only what is genuinely uncoverable ────────
describe('the uninterruptible-exit caveat is honest about which signals', () => {
  it('names SIGKILL as the only remaining gap, not SIGINT', () => {
    const readme = read('README.md');
    // Both halves: SIGKILL must be named as the residual …
    expect(readme).toMatch(/SIGKILL/);
    // … and SIGINT/SIGTERM must be documented as HANDLED, since they are.
    expect(readme).toMatch(/SIGINT/);
    expect(readme).not.toMatch(/(?:SIGINT|Ctrl-C)[^.]{0,120}(?:cannot restore|not covered)/i);
  });
});

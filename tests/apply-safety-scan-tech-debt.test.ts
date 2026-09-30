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

  it('reds a node <file>.mjs invocation whose script fetches a non-loopback literal host', () => {
    const src = 'node scripts/lib/probe.mjs 8080 /x 2xx3xx\n';
    const offenders = unsafeApplies(src, { resolveSource: () => REMOTE_JS, followScripts: true });
    expect(offenders.length).toBeGreaterThan(0);
  });

  it('reds a bun <file>.mjs invocation whose script fetches a bare non-loopback URL literal', () => {
    const src = 'bun scripts/lib/probe.mjs\n';
    const offenders = unsafeApplies(src, {
      resolveSource: () => REMOTE_URL_JS,
      followScripts: true,
    });
    expect(offenders.length).toBeGreaterThan(0);
  });

  it('fails closed on a dynamic (non-literal) fetch host', () => {
    const src = 'node scripts/lib/probe.mjs\n';
    const offenders = unsafeApplies(src, {
      resolveSource: () => DYNAMIC_HOST_JS,
      followScripts: true,
    });
    expect(offenders.length).toBeGreaterThan(0);
  });

  it('fails closed when the invoked script cannot be resolved', () => {
    const src = 'node scripts/lib/probe.mjs\n';
    const offenders = unsafeApplies(src, { resolveSource: () => null, followScripts: true });
    expect(offenders.length).toBeGreaterThan(0);
  });

  it('stays green for a node <file>.mjs script that fetches only a loopback literal host (the real e2e-probe-http.mjs shape)', () => {
    const src = 'node scripts/lib/probe.mjs 8080 /x 2xx3xx\n';
    expect(unsafeApplies(src, { resolveSource: () => LOOPBACK_JS, followScripts: true })).toEqual(
      [],
    );
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

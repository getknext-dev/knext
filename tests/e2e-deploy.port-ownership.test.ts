import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * GUARD TEST for `port_owned_by_server()` in scripts/e2e-deploy.sh (#210 —
 * the July-4 nightly regression, run 28697744187: 311/477 RED).
 *
 * #194 added a post-probe port-ownership check to close the free_port TOCTOU:
 * after the TCP probe succeeds, verify SERVER_PID actually owns the LISTEN
 * socket before advertising the URL. The check consulted `lsof` FIRST and
 * treated a bare lsof negative (exit 1) as "provably owned by someone else"
 * → refuse the deployment.
 *
 * That negative is NOT provable. Next.js retitles its standalone server
 * process (`process.title = 'next-server (v16.2.0)'`), so the kernel comm
 * becomes `next-server (v1` — an embedded space + unbalanced paren. Linux
 * lsof (4.95.0, the ubuntu-24.04 runner build) fails to parse that process's
 * /proc/<pid>/stat and reports NO sockets for it at all (verified in a
 * node:24 container: `ss` attributes the LISTEN socket to the pid, lsof
 * exits 1 even for the global `-iTCP:<port>` query). Result: every healthy
 * node-lane deploy was refused with "port answers but is NOT owned by server
 * pid … refusing to advertise it" — 477 failures. The bun lane was untouched
 * (bun keeps comm `bun`, which lsof parses fine).
 *
 * The contract this test pins down:
 *   1. `ss` (netlink sock_diag — immune to the comm-parsing bug) is consulted
 *      BEFORE lsof: positive attribution to SERVER_PID → owned (0), even when
 *      lsof is blind.
 *   2. A refusal (1) requires POSITIVE attribution of the LISTEN socket to a
 *      DIFFERENT pid — by ss, or by lsof's global port query.
 *   3. A bare negative with no attribution is INDETERMINATE (2): warn and
 *      proceed, never refuse a healthy deployment on absence of evidence.
 *
 * Hermetic: the function is extracted from the script verbatim and run under
 * a PATH containing ONLY stub `ss`/`lsof` binaries (plus a real `grep`), so
 * the test controls exactly what each tool reports on any host OS.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const DEPLOY_SH = resolve(REPO_ROOT, 'scripts/e2e-deploy.sh');

const SERVER_PID = 32917;
const OTHER_PID = 4444;
const PORT = 45383;

/** The exact ss -ltnp row shape the ubuntu runner produces for the retitled
 *  next standalone server (comm truncated by the kernel to 15 chars). */
const SS_ROW_OWNED = `LISTEN 0      511          0.0.0.0:${PORT}      0.0.0.0:*    users:(("next-server (v",pid=${SERVER_PID},fd=18))`;
const SS_ROW_OTHER = `LISTEN 0      511          0.0.0.0:${PORT}      0.0.0.0:*    users:(("node",pid=${OTHER_PID},fd=18))`;
const SS_ROW_NO_PID = `LISTEN 0      511          0.0.0.0:${PORT}      0.0.0.0:*`;
const SS_HEADER = 'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process';

/** Extract the port_owned_by_server() function verbatim from the script. */
function extractFunction(): string {
  const script = readFileSync(DEPLOY_SH, 'utf8');
  const match = script.match(/^port_owned_by_server\(\) \{$[\s\S]*?^\}$/m);
  expect(match, 'scripts/e2e-deploy.sh must define port_owned_by_server()').not.toBeNull();
  return (match as RegExpMatchArray)[0];
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

interface Stubs {
  /** stdout lines for `ss -ltnp`; undefined = no ss binary on PATH */
  ss?: string[];
  /** behavior of the lsof stub; undefined = no lsof binary on PATH */
  lsof?: {
    /** exit code for the per-pid query (`lsof … -a -p <pid> -iTCP:<port> …`) */
    pidQueryExit: number;
    /** stdout lines for the global port query (`lsof … -iTCP:<port> … -Fp`) */
    globalQueryStdout?: string[];
  };
}

/** Run the extracted function under a PATH of ONLY the stub tools + grep. */
function runOwnershipCheck(stubs: Stubs): number {
  const dir = mkdtempSync(join(tmpdir(), 'port-owned-'));
  tempDirs.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  // the function shells out to grep; everything else is a bash builtin
  symlinkSync('/usr/bin/grep', join(bin, 'grep'));

  // Stub output MUST use the printf builtin — PATH contains only the stubs
  // plus grep, so external tools like `cat` are (deliberately) unavailable.
  const printfLines = (lines: string[]) => `printf '%s\\n' ${lines.map((l) => `'${l}'`).join(' ')}`;

  if (stubs.ss) {
    const body = ['#!/bin/bash', printfLines([SS_HEADER, ...stubs.ss]), ''].join('\n');
    writeFileSync(join(bin, 'ss'), body);
    chmodSync(join(bin, 'ss'), 0o755);
  }
  if (stubs.lsof) {
    const globalLines = stubs.lsof.globalQueryStdout ?? [];
    const body = [
      '#!/bin/bash',
      '# per-pid query when invoked with -p; global port query otherwise',
      'if [[ " $* " == *" -p "* ]]; then',
      `  exit ${stubs.lsof.pidQueryExit}`,
      'fi',
      ...(globalLines.length > 0 ? [printfLines(globalLines), 'exit 0'] : ['exit 1']),
      '',
    ].join('\n');
    writeFileSync(join(bin, 'lsof'), body);
    chmodSync(join(bin, 'lsof'), 0o755);
  }

  const driver = [
    '#!/bin/bash',
    `export PATH="${bin}"`,
    `SERVER_PID=${SERVER_PID}`,
    `PORT=${PORT}`,
    extractFunction(),
    'port_owned_by_server',
    'echo "rc=$?"',
    '',
  ].join('\n');
  const driverPath = join(dir, 'driver.sh');
  writeFileSync(driverPath, driver);
  chmodSync(driverPath, 0o755);

  const out = execFileSync('/bin/bash', [driverPath], { encoding: 'utf8' });
  const rc = out.match(/^rc=(\d+)$/m);
  expect(rc, `driver must report an exit code, got: ${out}`).not.toBeNull();
  return Number((rc as RegExpMatchArray)[1]);
}

describe('port_owned_by_server (scripts/e2e-deploy.sh, #210 regression)', () => {
  it('trusts ss ownership even when lsof is blind to the pid (the nightly-red scenario)', () => {
    // run 28697744187: healthy next-server owns the port per ss, but lsof
    // cannot parse the retitled comm and exits 1. MUST be owned (0) — the old
    // lsof-first order returned 1 and refused all 477 node-lane deployments.
    const rc = runOwnershipCheck({
      ss: [SS_ROW_OWNED],
      lsof: { pidQueryExit: 1 },
    });
    expect(rc).toBe(0);
  });

  it('refuses when ss attributes the port to a DIFFERENT pid (the real TOCTOU)', () => {
    const rc = runOwnershipCheck({
      ss: [SS_ROW_OTHER],
      lsof: { pidQueryExit: 1 },
    });
    expect(rc).toBe(1);
  });

  it('is indeterminate (2) when ss sees the listener but cannot attribute a pid', () => {
    // ss -p prints no process column without permission — absence of evidence.
    const rc = runOwnershipCheck({ ss: [SS_ROW_NO_PID] });
    expect(rc).toBe(2);
  });

  it('is indeterminate (2) when ss shows no listener row at all', () => {
    // the TCP probe already accepted, so an empty ss snapshot is a race —
    // never proof of foreign ownership.
    const rc = runOwnershipCheck({ ss: [] });
    expect(rc).toBe(2);
  });

  it('accepts a positive lsof ownership when ss is unavailable (macOS dev path)', () => {
    const rc = runOwnershipCheck({ lsof: { pidQueryExit: 0 } });
    expect(rc).toBe(0);
  });

  it('treats a bare lsof negative as indeterminate, never as foreign ownership', () => {
    // no ss; lsof per-pid query exits 1 AND the global port query sees
    // nothing (lsof blind to the process class) — must be 2, not 1.
    const rc = runOwnershipCheck({ lsof: { pidQueryExit: 1 } });
    expect(rc).toBe(2);
  });

  it('refuses when lsof positively attributes the port to a DIFFERENT pid', () => {
    const rc = runOwnershipCheck({
      lsof: { pidQueryExit: 1, globalQueryStdout: [`p${OTHER_PID}`] },
    });
    expect(rc).toBe(1);
  });

  it('is indeterminate (2) when neither ss nor lsof is available', () => {
    const rc = runOwnershipCheck({});
    expect(rc).toBe(2);
  });
});

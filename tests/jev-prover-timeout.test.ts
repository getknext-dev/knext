import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The jev-hook mutation prover (`.claude/hooks/jev-hooks-mutation-proof.py`) once died with a
 * traceback when a suite hit its timeout on macOS: `os.killpg` raised PermissionError (a process
 * group whose only member is an exited-but-unreaped leader answers EPERM on macOS, ESRCH on Linux).
 *
 * What must hold, and what this file proves:
 *  - a timed-out suite is an explicit TIMEOUT result, never a crash and NEVER a killed mutation
 *    (a suite that never finished certifies nothing);
 *  - the child is killed and reaped whichever way killpg fails, with no orphan left running;
 *  - a timeout fails the run, names the mutation, and is not folded into "suite went red".
 */
const ROOT = resolve(import.meta.dir, '..');
const PROVER = resolve(ROOT, '.claude/hooks/jev-hooks-mutation-proof.py');

function py(code: string, env: Record<string, string> = {}) {
  const r = spawnSync('python3', ['-I', '-c', code, PROVER], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 120_000,
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

// Loads the prover as a module (hyphenated name) and exposes it as `mod`.
const LOAD = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("prover", sys.argv[1])
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
`;

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'jev-prover-timeout-'));
  tempDirs.push(dir);
  return dir;
}

/** A work tree holding only the suite files the prover looks for, with the given bodies. */
function fakeWork(hooksBody: string, prRiskBody = 'exit 0') {
  const d = tmp();
  mkdirSync(join(d, 'hooks'), { recursive: true });
  mkdirSync(join(d, 'skills/jev'), { recursive: true });
  writeFileSync(join(d, 'hooks/jev-hooks.test.sh'), `${hooksBody}\n`);
  writeFileSync(join(d, 'skills/jev/pr-risk.test.sh'), `${prRiskBody}\n`);
  return d;
}

const ALIVE = `
import os
def alive(pid):
    try: os.kill(pid, 0)
    except ProcessLookupError: return False   # reaped AND gone (a zombie would still answer)
    except PermissionError: return True       # macOS answers EPERM for an unreaped zombie
    return True
`;

const SLOW = (pidfile: string) => `echo $$ > ${pidfile}; sleep 600 & echo $! >> ${pidfile}; wait`;

describe('run_suite on a suite that exceeds its timeout', () => {
  it('raises SuiteTimeout (no traceback), and kills + reaps the leader AND its child', () => {
    const w = fakeWork('');
    const pids = join(w, 'pids');
    writeFileSync(join(w, 'hooks/jev-hooks.test.sh'), `${SLOW(pids)}\n`);
    const r = py(`${LOAD}${ALIVE}
import pathlib, time
t0 = time.time()
try:
    mod.run_suite(pathlib.Path(${JSON.stringify(w)}), "hooks/jev-hooks.test.sh", timeout=1)
    print("NO-RAISE")
except mod.SuiteTimeout as e:
    print("TIMEOUT", "hooks/jev-hooks.test.sh" in str(e))
time.sleep(0.5)
leader, child = [int(x) for x in pathlib.Path(${JSON.stringify(pids)}).read_text().split()]
print("alive", alive(leader), alive(child), "fast", time.time() - t0 < 20)
`);
    rmSync(w, { recursive: true, force: true });
    expect(r.err).toBe('');
    expect(r.out.trim().split('\n')).toEqual(['TIMEOUT True', 'alive False False fast True']);
  });

  for (const exc of ['PermissionError', 'ProcessLookupError']) {
    it(`still raises SuiteTimeout and reaps the leader when killpg raises ${exc}`, () => {
      const w = fakeWork('');
      const pids = join(w, 'pids');
      writeFileSync(join(w, 'hooks/jev-hooks.test.sh'), `${SLOW(pids)}\n`);
      const r = py(`${LOAD}${ALIVE}
import os, pathlib
def boom(*a): raise ${exc}(1, "injected")
os.killpg = boom
try:
    mod.run_suite(pathlib.Path(${JSON.stringify(w)}), "hooks/jev-hooks.test.sh", timeout=1)
    print("NO-RAISE")
except mod.SuiteTimeout:
    print("TIMEOUT")
leader, child = [int(x) for x in pathlib.Path(${JSON.stringify(pids)}).read_text().split()]
print("leader-alive", alive(leader))
# the orphaned sleep is the test's own doing (killpg was sabotaged); clean it up
try: os.kill(child, 9)
except ProcessLookupError: pass
`);
      rmSync(w, { recursive: true, force: true });
      expect(r.err).toBe('');
      expect(r.out.trim().split('\n')).toEqual(['TIMEOUT', 'leader-alive False']);
    });
  }

  it('control: a suite inside its timeout returns its real exit code', () => {
    const w = fakeWork('exit 3');
    const r = py(`${LOAD}
import pathlib
print(mod.run_suite(pathlib.Path(${JSON.stringify(w)}), "hooks/jev-hooks.test.sh", timeout=30))
`);
    rmSync(w, { recursive: true, force: true });
    expect(r.out.trim()).toBe('3');
  });
});

describe('a timed-out mutation is a TIMEOUT, never a killed mutation', () => {
  const JUDGE = (w: string, which: string) => `${LOAD}
import pathlib
status, line = mod.judge("my mutation label", ${JSON.stringify(which)}, pathlib.Path(${JSON.stringify(w)}), timeout=1)
print(status); print(line)
`;

  it('judge reports TIMEOUT, names the mutation, and says it is not counted as killed', () => {
    const w = fakeWork('sleep 600');
    const r = py(JUDGE(w, 'hooks'));
    rmSync(w, { recursive: true, force: true });
    const [status, line] = r.out.trim().split('\n');
    expect(r.err).toBe('');
    expect(status).toBe('TIMEOUT');
    expect(line).toContain('my mutation label');
    expect(line).toContain('NOT counted as killed');
  });

  it('a timeout in one of the two suites is a TIMEOUT even when the other is red', () => {
    // "both" runs two suites; pr-risk is red (exit 1) but hooks hangs. Folding return codes with
    // max() would read that as RED. It must not.
    const w = fakeWork('sleep 600', 'exit 1');
    const r = py(JUDGE(w, 'both'));
    rmSync(w, { recursive: true, force: true });
    expect(r.out.trim().split('\n')[0]).toBe('TIMEOUT');
  });

  it('controls: red is RED, green is GREEN', () => {
    const red = fakeWork('exit 1');
    const green = fakeWork('exit 0');
    const a = py(JUDGE(red, 'hooks')).out.split('\n')[0];
    const b = py(JUDGE(green, 'hooks')).out.split('\n')[0];
    rmSync(red, { recursive: true, force: true });
    rmSync(green, { recursive: true, force: true });
    expect([a, b]).toEqual(['RED', 'GREEN']);
  });
});

describe('main(): a timeout fails the run and is never tallied as killed', () => {
  // Fake source tree: the hooks suite misbehaves only when the mutation landed in the screen file.
  const MAIN = (src: string) => `${LOAD}
import pathlib
src = pathlib.Path(${JSON.stringify(src)})
mod.FILES = [(src, f, "hooks/" + f) for f in ["jev-result-screen.sh", "jev-hook-lib.sh", "jev-hooks.test.sh"]] + [
    (src, "pr-risk.sh", "skills/jev/pr-risk.sh"), (src, "pr-risk.test.sh", "skills/jev/pr-risk.test.sh")]
mod.DEST = {f: d for _, f, d in mod.FILES}
mod.MUTATIONS = [("fake guard", mod.SCREEN, "ORIGINAL", "MUTANT")]
sys.argv = ["prover"]
sys.exit(mod.main())
`;
  function fakeSrc(mutantBody: string) {
    const d = tmp();
    writeFileSync(join(d, 'jev-result-screen.sh'), 'ORIGINAL\n');
    writeFileSync(join(d, 'jev-hook-lib.sh'), '\n');
    writeFileSync(join(d, 'pr-risk.sh'), '\n');
    writeFileSync(join(d, 'pr-risk.test.sh'), 'exit 0\n');
    writeFileSync(
      join(d, 'jev-hooks.test.sh'),
      `if grep -q MUTANT "$(dirname "$0")/jev-result-screen.sh"; then ${mutantBody}; fi\nexit 0\n`,
    );
    return d;
  }

  it('a mutant whose suite hangs: exit non-zero, TIMEOUT line names it, 0 killed, no traceback', () => {
    const src = fakeSrc('sleep 600');
    const r = py(MAIN(src), { JEV_PROOF_SUITE_TIMEOUT: '3' });
    rmSync(src, { recursive: true, force: true });
    expect(r.err).not.toContain('Traceback');
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('TIMEOUT');
    expect(r.out).toContain('fake guard');
    expect(r.out).toContain('0/1 mutations killed');
    expect(r.out).toMatch(/timeouts=1/);
    expect(r.out).not.toMatch(/^RED /m);
  });

  it('control: the same mutant going red is killed and the run passes', () => {
    const src = fakeSrc('exit 1');
    const r = py(MAIN(src), { JEV_PROOF_SUITE_TIMEOUT: '3' });
    rmSync(src, { recursive: true, force: true });
    expect(r.status).toBe(0);
    expect(r.out).toContain('1/1 mutations killed');
    expect(r.out).toMatch(/timeouts=0/);
  });

  it('a baseline that times out aborts with exit 2 and says so (it proves nothing)', () => {
    const src = fakeSrc('exit 0');
    writeFileSync(join(src, 'jev-hooks.test.sh'), 'sleep 600\n');
    const r = py(MAIN(src), { JEV_PROOF_SUITE_TIMEOUT: '2' });
    rmSync(src, { recursive: true, force: true });
    expect(r.err).not.toContain('Traceback');
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/ABORT.*(timed out|timeout)/i);
  });
});

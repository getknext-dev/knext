import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * scripts/e2e-native-rebuild-musl.sh (#1257 round 7, techdebt-3 fix) —
 * the non-reproducible fresh-install fallback (no committed lockfile for a
 * given name@version) must be LOUD on success (a fully green job otherwise
 * gives no signal that a rebuild was non-reproducible), and must REFUSE
 * outright in `KNEXT_COMPAT_MODE=credential` — a credential run's claim is
 * a reproducible result, so silently taking the unpinned path there would
 * make that claim about a tree whose native-addon deps were never pinned.
 *
 * These are static scans (the real docker-e2e integration lives in
 * tests/e2e-native-rebuild-musl.docker-e2e.test.ts, which needs a live
 * container this environment does not have available tonight) — proven by
 * mutation, not just presence: each assertion is checked against a
 * synthetic "before this fix" fixture string too, so a false-positive scan
 * (one that would also pass on the OLD, buggy script) is ruled out.
 */
const REPO_ROOT = resolve(import.meta.dir, '..');
const SCRIPT_PATH = resolve(REPO_ROOT, 'scripts/e2e-native-rebuild-musl.sh');
const DEPLOY_SCRIPT_PATH = resolve(REPO_ROOT, 'scripts/e2e-deploy.sh');

/** Every `if [ "${KNEXT_COMPAT_MODE:-}" = "credential" ]` CONDITION line (not every mention — the matching error message on the next line also contains the env var's name). */
function fallbackBlocks(source: string): string[] {
  const idxs: number[] = [];
  const re = /KNEXT_COMPAT_MODE:-.*=\s*"credential"/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
  while ((m = re.exec(source))) {
    idxs.push(m.index);
  }
  return idxs.map((start) => source.slice(start, start + 900));
}

describe('the unpinned fallback refuses outright in credential mode (techdebt-3)', () => {
  it('scripts/e2e-native-rebuild-musl.sh checks KNEXT_COMPAT_MODE before EVERY fallback install (both call sites)', () => {
    const source = readFileSync(SCRIPT_PATH, 'utf8');
    const blocks = fallbackBlocks(source);
    // Two call sites: musl_install_sibling() and the main NAME/VERSION loop.
    expect(blocks.length).toBe(2);
    for (const block of blocks) {
      expect(block).toMatch(/KNEXT_COMPAT_MODE:-.*=\s*"credential"/);
    }
  });

  it('a synthetic pre-fix fixture (no credential-mode check at all) is correctly NOT matched — proves the scan discriminates', () => {
    const preFixFixture =
      'elif ! (cd "${_pkg_scratch}" && run_as_builder env npm_config_build_from_source=true npm install --no-save "${_spec}" >"${_pkg_scratch}.log" 2>&1); then\n' +
      '  echo "[native-rebuild] WARNING: fresh install of ${_spec} failed"\n' +
      '  return 1\n' +
      'fi\n';
    expect(fallbackBlocks(preFixFixture).length).toBe(0);
  });
});

describe('the unpinned fallback is loud on SUCCESS, not only on failure (techdebt-3)', () => {
  it('scripts/e2e-native-rebuild-musl.sh emits a ::warning:: after each fallback install succeeds (both call sites)', () => {
    const source = readFileSync(SCRIPT_PATH, 'utf8');
    const warnings = source.match(/::warning::\[native-rebuild\][^\n]*NON-REPRODUCIBLE/g) ?? [];
    expect(warnings.length).toBe(2);
  });

  it('each ::warning:: line is OUTSIDE the failure branch — it fires only when the fallback install did NOT fail', () => {
    const source = readFileSync(SCRIPT_PATH, 'utf8');
    // The failure branch's own WARNING text is a different, adjacent
    // string ("... musl install of ... failed" / "... musl install
    // failed"); the ::warning:: line must not be inside that `if !` body.
    const lines = source.split('\n');
    const warningIdxs = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.includes('::warning::') && l.includes('NON-REPRODUCIBLE'))
      .map(({ i }) => i);
    expect(warningIdxs.length).toBe(2);
    for (const idx of warningIdxs) {
      // The nearest preceding `if ! (... npm install ...); then` / `fi`
      // pair must have already closed (a `fi` appears between the `if !`
      // and this warning line) — i.e. the warning is not inside that
      // failure body.
      let sawIfBang = false;
      let sawClosingFi = false;
      for (let j = idx - 1; j >= Math.max(0, idx - 20); j--) {
        if (/^\s*fi\s*$/.test(lines[j])) {
          sawClosingFi = true;
        }
        if (/if ! \(.*npm install/.test(lines[j])) {
          sawIfBang = true;
          break;
        }
      }
      expect(sawIfBang).toBe(true);
      expect(sawClosingFi).toBe(true);
    }
  });
});

describe('KNEXT_COMPAT_MODE is forwarded into the container that runs the rebuild script', () => {
  it('scripts/e2e-deploy.sh passes -e KNEXT_COMPAT_MODE to the docker run that invokes e2e-native-rebuild-musl.sh', () => {
    const source = readFileSync(DEPLOY_SCRIPT_PATH, 'utf8');
    const idx = source.indexOf('e2e-native-rebuild-musl.sh:/e2e-native-rebuild-musl.sh');
    expect(idx).toBeGreaterThan(-1);
    // The docker run block containing that mount must also pass the env var
    // — search backwards a short window for the -e flag (same `docker run`
    // invocation).
    const before = source.slice(Math.max(0, idx - 500), idx);
    expect(before).toMatch(/-e\s+"KNEXT_COMPAT_MODE=/);
  });
});

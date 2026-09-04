/**
 * Every knext runtime image sets `NODE_ENV=production`.
 *
 * WHY THIS IS A GUARD AND NOT A STYLE PREFERENCE.
 *
 * T6b made the published cache-handler seams refuse **unconditionally under
 * `NODE_ENV=production`**, precisely because the `KNEXT_TEST_SEAMS` flag is an
 * env var on a public subpath and anything in the app's process can set it. That
 * refusal is worth exactly as much as `NODE_ENV` being set in the image — and
 * `examples/bun-exec/Dockerfile`, the ONE image CI actually builds and boots
 * (`alpine-image.docker-e2e.test.ts`), did not set it. So the security control
 * was inert in the only place it was ever exercised, while three sibling
 * Dockerfiles set it and made the omission look deliberate.
 *
 * That is the shape this repo keeps meeting: a control that is present in source
 * and absent from the artifact. Nothing reds, because nothing compares them.
 *
 * DISCOVERED, NEVER ENUMERATED. A test naming today's four Dockerfiles is a test
 * that passes on the day someone adds a fifth. The set comes from
 * `git ls-files`, and the known members are asserted only as a FLOOR so an empty
 * scan fails instead of passing vacuously.
 */

import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');

/**
 * Dockerfiles that build a knext APP runtime — the images an app's process runs
 * in, and therefore the ones whose `NODE_ENV` the T6b refusal depends on.
 *
 * The operator image is excluded by path: it is a Go binary with no Node runtime
 * and no `NODE_ENV` to speak of. `scale-zero-pg` is a separate benchmark package,
 * not a shipped app image. Both exclusions are stated as prefixes here rather
 * than by listing what remains, so a NEW app Dockerfile is included by default —
 * the direction that fails safe.
 */
const NOT_APP_RUNTIMES = ['packages/kn-next-operator/', 'packages/scale-zero-pg/'];

function discoverAppDockerfiles(): string[] {
  return execFileSync('git', ['ls-files'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter((f) => /(^|\/)Dockerfile(\.[A-Za-z0-9]+)?$/.test(f) || f.endsWith('Dockerfile.hbs'))
    .filter((f) => !NOT_APP_RUNTIMES.some((prefix) => f.startsWith(prefix)))
    .sort();
}

describe('every knext app runtime image sets NODE_ENV=production', () => {
  it('the scan finds the app Dockerfiles it is supposed to guard', () => {
    const found = discoverAppDockerfiles();
    for (const known of [
      'apps/docs/Dockerfile',
      'apps/file-manager/Dockerfile',
      // The one CI builds and boots — the reason this guard exists.
      'examples/bun-exec/Dockerfile',
      // The template: every scaffolded app inherits whatever this says.
      'packages/kn-next/templates/app/Dockerfile.hbs',
    ]) {
      expect(found, `the scan missed ${known}`).toContain(known);
    }
  });

  it('sets NODE_ENV=production in each of them', () => {
    const offenders = discoverAppDockerfiles().filter((f) => {
      const text = readFileSync(resolve(REPO_ROOT, f), 'utf8');
      // Matches both `ENV NODE_ENV=production` and the multi-line
      // `ENV A=b \` … `NODE_ENV=production` continuation form all four use.
      return !/\bNODE_ENV\s*=\s*production\b/.test(text);
    });
    expect(
      offenders,
      'these app runtime images do not set NODE_ENV=production, so every control that keys on ' +
        'it — notably the T6b published-seam refusal — is INERT in them:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('the check can actually fail — a Dockerfile without it is detected', () => {
    // Anti-vacuity for the regex itself. A pattern that matched everything would
    // report zero offenders above and read as a pass forever.
    expect(/\bNODE_ENV\s*=\s*production\b/.test('FROM scratch\nCMD ["/app/server"]\n')).toBe(false);
    expect(/\bNODE_ENV\s*=\s*production\b/.test('ENV NODE_ENV=production\n')).toBe(true);
    // ...and it must not be satisfied by a DIFFERENT value.
    expect(/\bNODE_ENV\s*=\s*production\b/.test('ENV NODE_ENV=development\n')).toBe(false);
  });
});

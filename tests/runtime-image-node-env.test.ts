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

/**
 * Does this Dockerfile actually SET `NODE_ENV=production` **in the image that
 * ships**?
 *
 * Two narrowings, each closing a way this could pass while the artifact is
 * wrong:
 *
 *   1. COMMENTS ARE STRIPPED. Every one of these Dockerfiles carries a comment
 *      explaining why the variable is load-bearing, so a matcher over raw text
 *      reads its own explanation back and stays green after the real `ENV` is
 *      deleted. The mutation prover caught exactly that — M1 survived the first
 *      run of this guard.
 *   2. ONLY THE FINAL STAGE COUNTS. `ENV` does not cross a `FROM`: a builder
 *      stage setting `NODE_ENV=production` contributes nothing to the runtime
 *      image, and three of these files are multi-stage. Checking "anywhere in
 *      the file" would accept a build-only `ENV` as if it configured the
 *      running container.
 *
 * Measured when this narrowed: all six app Dockerfiles already set it in their
 * final stage, so this closes a hole rather than papering over a break.
 */
function finalStage(dockerfile: string): string {
  const code = dockerfile
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  // Stages are delimited by `FROM` at the start of a line. The last chunk is
  // the stage that becomes the image.
  return code.split(/^FROM /m).at(-1) ?? '';
}

function setsNodeEnvProduction(dockerfile: string): boolean {
  return /\bNODE_ENV\s*=\s*production\b/.test(finalStage(dockerfile));
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
    const offenders = discoverAppDockerfiles().filter(
      (f) => !setsNodeEnvProduction(readFileSync(resolve(REPO_ROOT, f), 'utf8')),
    );
    expect(
      offenders,
      'these app runtime images do not set NODE_ENV=production, so every control that keys on ' +
        'it — notably the T6b published-seam refusal — is INERT in them:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('reads the ENV INSTRUCTION, not a comment that merely mentions it', () => {
    // The defect the prover found: the first version of this matched anywhere in
    // the file, and every one of these Dockerfiles carries a COMMENT explaining
    // why `NODE_ENV=production` is load-bearing. So deleting the actual `ENV`
    // left the guard green — it was reading its own explanation back.
    expect(
      setsNodeEnvProduction(
        '# NODE_ENV=production is load-bearing here, not cosmetic.\nENV PORT=3000\n',
      ),
      'a comment mentioning it must NOT satisfy the check',
    ).toBe(false);
    expect(setsNodeEnvProduction('ENV NODE_ENV=production\n')).toBe(true);
  });

  it('reads the FINAL stage — a builder-stage ENV does not reach the image', () => {
    // `ENV` does not cross a `FROM`. A build stage setting it configures the
    // build, not the running container, so accepting it here would certify an
    // image whose T6b refusal is inert — the exact defect this guard exists for,
    // wearing a different disguise.
    const builderOnly = [
      'FROM node:22 AS builder',
      'ENV NODE_ENV=production',
      'RUN npm run build',
      '',
      'FROM gcr.io/distroless/nodejs22',
      'COPY --from=builder /app /app',
      'CMD ["server.js"]',
    ].join('\n');
    expect(
      setsNodeEnvProduction(builderOnly),
      'a builder-stage ENV must NOT satisfy the check',
    ).toBe(false);

    // ...and the same file with the ENV in the final stage passes, so this is a
    // narrowing rather than a blanket refusal of multi-stage builds.
    const finalStageSet = builderOnly.replace(
      'COPY --from=builder /app /app',
      'COPY --from=builder /app /app\nENV NODE_ENV=production',
    );
    expect(setsNodeEnvProduction(finalStageSet)).toBe(true);
  });

  it('the check can actually fail — a Dockerfile without it is detected', () => {
    // Anti-vacuity for the matcher itself. One that matched everything would
    // report zero offenders above and read as a pass forever.
    expect(setsNodeEnvProduction('FROM scratch\nCMD ["/app/server"]\n')).toBe(false);
    // The multi-line continuation form all four images actually use.
    expect(
      setsNodeEnvProduction(
        'ENV PORT=3000 \\\n    METRICS_PORT=9091 \\\n    NODE_ENV=production\n',
      ),
    ).toBe(true);
    // ...and it must not be satisfied by a DIFFERENT value.
    expect(setsNodeEnvProduction('ENV NODE_ENV=development\n')).toBe(false);
  });
});

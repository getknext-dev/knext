#!/usr/bin/env node
/**
 * docker-hub-mirror-guard.mjs — #2106.
 *
 * Anonymous Docker Hub pulls from shared GitHub runners hit the unauthenticated
 * rate limit (`toomanyrequests`), which reds jobs unrelated to the PR under test.
 * The fix needs no secret: route Docker Hub through `mirror.gcr.io`, a
 * pull-through mirror that serves the SAME digests, so every `@sha256` pin stays
 * valid (verified against the pinned oven/bun, node, alpine and redis digests).
 *
 * Mechanism (jev pick 0.94 over rewriting every ref 0.06 / per-job secret 0.00):
 * the composite action `.github/actions/docker-hub-mirror` sets the docker
 * daemon's `registry-mirrors` and writes a buildkitd config for the buildx
 * `docker-container` driver (which ignores daemon mirrors). A job that pulls must
 * run that step BEFORE its first pulling step. `services:` / `container:`
 * images are pulled by the runner before any step, so they cannot use a step:
 * their image must carry the `mirror.gcr.io/` prefix (or another registry host).
 *
 * This scanner FAILS CLOSED the same way `workflow-script-install-guard.mjs`
 * does: a job that pulls and does not mirror is a violation; there is no skip.
 *
 * DEFERRED (frozen) workflows: `test-e2e-deploy.yml` and `compat-vinext.yml` are
 * in the v1.0 credential fingerprint set; editing them moves the fingerprints.
 * They are listed in DEFERRED_FROZEN and skipped, and the test asserts each is
 * STILL frozen, so the deferral cannot outlive the credential window silently.
 * TODO(#2106): apply the mirror to them once the credential window closes (the
 * compat shards' Docker Hub pulls live in the frozen scripts/e2e-deploy*.sh).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MIRROR_HOST = 'mirror.gcr.io';
export const MIRROR_ACTION = './.github/actions/docker-hub-mirror';

/**
 * Derived copy of the frozen `test-e2e-deploy.yml` (its header declares it equals
 * derive(test-e2e-deploy.yml) plus declared substitutions, and a test enforces
 * that), whose pulls happen inside the frozen `scripts/e2e-deploy*.sh`. Editing it
 * alone would break the derivation. TODO(#2106): apply with the frozen pair.
 */
export const DEFERRED_DERIVED = Object.freeze(['.github/workflows/compat-credential-v1.3.yml']);

/**
 * `bun-base-build.yml` pins an EXACT reviewed step order/run text for its
 * submit/download/verify/sign chain (`tests/bun-base-supply-chain.test.ts`); adding
 * a step is a signing-chain change that needs its own review. Its one pull is
 * `docker run alpine` in the verify step. TODO(#2106): mirror it under that review.
 */
export const DEFERRED_PINNED = Object.freeze(['.github/workflows/bun-base-build.yml']);

/**
 * `anonymous-install-nightly.yml` is audited to hold NO credential and NO extra action or
 * step (`auditAnonymousWorkflowJob` allowlists exactly checkout + one run command), so a
 * mirror step cannot be added without weakening that audit. It does not need one: its
 * script talks to registries over `fetch` and never invokes docker (the only
 * `docker pull` text in it is a doc comment). A test asserts the script imports no
 * `child_process`, so this exemption cannot outlive that fact.
 */
export const EXEMPT_NO_DOCKER_PULL = Object.freeze([
  '.github/workflows/anonymous-install-nightly.yml',
]);

export const DEFERRED_FROZEN = Object.freeze([
  '.github/workflows/test-e2e-deploy.yml',
  '.github/workflows/compat-vinext.yml',
]);

/** A `mirror.gcr.io/<repo>[:tag][@sha256:...]` token inside shell text. */
const MIRROR_REF_IN_TEXT = /mirror\.gcr\.io\/[\w./-]+(?::[\w.-]+)?(?:@sha256:[0-9a-f]{64})?/g;

/** A command/action that makes the runner or buildkit pull from a registry. */
const PULLING =
  /\bdocker\s+(?:build|buildx|pull|run|compose|load)\b|\bkind\s+create\b|docker\/build-push-action|docker\/setup-buildx-action|helm\/kind-action/;
/** A script a job runs that itself pulls. */
const PULLING_SCRIPT = /\bdocker\s+(?:build|buildx|pull|run|compose)\b|\bkind\s+create\b/;
const SCRIPT_REF = /(?:^|[\s"'`(])((?:\.\/)?scripts\/[\w./-]+\.(?:sh|mjs|js|ts))/g;

function stepText(step) {
  return `${step.run ?? ''}\n${step.uses ?? ''}\n${JSON.stringify(step.with ?? {})}`;
}

function scriptPulls(text, repoRoot) {
  for (const m of text.matchAll(SCRIPT_REF)) {
    const p = join(repoRoot, m[1].replace(/^\.\//, ''));
    if (existsSync(p) && PULLING_SCRIPT.test(readFileSync(p, 'utf8'))) return true;
  }
  return false;
}

function isMirrorStep(step) {
  if (step.uses === MIRROR_ACTION) return true;
  // Inline form, for jobs that run before any checkout (a local action needs one).
  return (
    typeof step.run === 'string' &&
    step.run.includes(MIRROR_HOST) &&
    /registry-mirrors/.test(step.run)
  );
}

/** Index of the first step that pulls images, or -1. */
export function firstPullIndex(steps, repoRoot = REPO_ROOT) {
  return steps.findIndex((s) => {
    const t = stepText(s);
    return PULLING.test(t) || scriptPulls(t, repoRoot);
  });
}

/** Is a `services:`/`container:` image ref safe? mirror prefix, or a non-Docker-Hub registry host. */
export function imageRefOk(ref) {
  if (typeof ref !== 'string') return true; // expression-only refs are judged by the author
  if (ref.startsWith('${{')) return true;
  const first = ref.split('/')[0];
  // The mirror serves the same digests, so a mirrored ref keeps the digest pin: a bare tag
  // through the mirror is still a mutable pull (security.md: pin images by digest).
  if (ref.startsWith(`${MIRROR_HOST}/`)) return /@sha256:[0-9a-f]{64}$/.test(ref);
  // A registry host has a dot or colon, or is localhost. Otherwise it is Docker Hub.
  return ref.includes('/') && (/[.:]/.test(first) || first === 'localhost');
}

/**
 * @param {string} repoRoot
 * @param {{ deferred?: readonly string[] }} [opts]
 * @returns {{ file: string, job: string, reason: string }[]}
 */
export function findViolations(
  repoRoot = REPO_ROOT,
  {
    deferred = [
      ...DEFERRED_FROZEN,
      ...DEFERRED_DERIVED,
      ...DEFERRED_PINNED,
      ...EXEMPT_NO_DOCKER_PULL,
    ],
  } = {},
) {
  const dir = join(repoRoot, '.github', 'workflows');
  const out = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.yml') && !f.endsWith('.yaml')) continue;
    const rel = `.github/workflows/${f}`;
    if (deferred.includes(rel)) continue;
    const doc = parse(readFileSync(join(dir, f), 'utf8'));
    for (const [id, job] of Object.entries(doc?.jobs ?? {})) {
      if (!job || job.uses) continue; // reusable-workflow call: judged in the callee
      const containers = [];
      if (job.container) containers.push(job.container.image ?? job.container);
      for (const svc of Object.values(job.services ?? {})) containers.push(svc?.image);
      for (const img of containers) {
        if (!imageRefOk(img)) {
          out.push({
            file: rel,
            job: id,
            reason: `container/service image "${img}" is an anonymous Docker Hub pull; prefix it with ${MIRROR_HOST}/ (digest unchanged)`,
          });
        }
      }
      const steps = Array.isArray(job.steps) ? job.steps : [];
      // A mirrored image named in a run step (`docker run mirror.gcr.io/...`) keeps its pin.
      for (const st of steps) {
        for (const m of String(st.run ?? '').matchAll(MIRROR_REF_IN_TEXT)) {
          if (!/@sha256:[0-9a-f]{64}$/.test(m[0])) {
            out.push({
              file: rel,
              job: id,
              reason: `mirrored image "${m[0]}" in a step has no @sha256 pin`,
            });
          }
        }
      }
      const first = firstPullIndex(steps, repoRoot);
      if (first < 0) continue;
      // The buildx docker-container driver ignores the daemon mirror: its setup
      // step must be handed the buildkitd config (or use the docker driver).
      for (const st of steps) {
        if (!/^docker\/setup-buildx-action@/.test(st.uses ?? '')) continue;
        const w = st.with ?? {};
        if (!w['buildkitd-config'] && !w['buildkitd-config-inline'] && w.driver !== 'docker') {
          out.push({
            file: rel,
            job: id,
            reason:
              'setup-buildx-action has no buildkitd-config (its docker-container driver ignores the daemon mirror)',
          });
        }
      }
      const mirrored = steps.findIndex(isMirrorStep);
      if (mirrored < 0 || mirrored > first) {
        out.push({
          file: rel,
          job: id,
          reason: `pulls images (step ${first + 1}) without a preceding ${MIRROR_ACTION} step`,
        });
      }
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const v = findViolations();
  for (const x of v) console.error(`::error file=${x.file}::${x.job}: ${x.reason}`);
  process.exit(v.length === 0 ? 0 : 1);
}

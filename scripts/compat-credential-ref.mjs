#!/usr/bin/env node
/**
 * compat-credential-ref — resolve the knext ref a compat night runs against
 * (#850, ADR-0056).
 *
 * WHY. ADR-0039 freezes the harness AND every packed @getknext/* tarball in
 * full, so on `main` every merge that touches shipped bytes restarts the
 * 14-night window. `docs/compat/window-node-lane.md` measured it: 10 moves in 27
 * nights, longest streak 7, zero nights lost to a test failure. Narrowing the
 * fingerprint is ruled out (ADR-0039 records that it "was wrong"). So the
 * credential is earned against a FROZEN release-candidate tag instead, and a
 * restart becomes a deliberate RC cut rather than any merge.
 *
 * TWO MODES, chosen by the cron literal that fired (KNEXT_COMPAT_MODE in
 * test-e2e-deploy.yml) and never by a dispatch input:
 *
 *   credential     — read the pin file on `main`
 *                    (`.github/compat-credential-ref.json`), require an RC tag
 *                    (`vX.Y.Z-rc.N`), resolve it with `git ls-remote` to its
 *                    PEELED commit, and hand that SHA to every checkout. Any
 *                    failure REFUSES the run. There is no fallback to `main`:
 *                    a credential lane that quietly tested `main` would bank a
 *                    night against a ref nobody froze, which is the exact
 *                    failure this exists to prevent.
 *   early-warning  — the executing `main` commit. Never credentialing; the
 *                    audit excludes these nights from every credential window.
 *
 * A refusal writes `state=<reason>` to GITHUB_OUTPUT and NO checkout target, so
 * no downstream step can check out anything in its place, then exits 1. The
 * `not-cut` state (the pin declares `rcTag: null`) is the reviewed "no RC yet"
 * declaration; the workflow still refuses on it, but does not open a red-alert
 * issue for it.
 *
 * Usage:
 *   node scripts/compat-credential-ref.mjs --mode credential \
 *     --pin knext/.github/compat-credential-ref.json --remote-dir knext
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The pin file, relative to the repo root. It is read from `main`. */
export const PIN_FILE = '.github/compat-credential-ref.json';

/** The two run modes. Anything else is refused. */
export const COMPAT_MODES = Object.freeze(['credential', 'early-warning']);

const NUM = '(?:0|[1-9]\\d*)';
const RC_TAG = new RegExp(`^v${NUM}\\.${NUM}\\.${NUM}-rc\\.${NUM}$`);

/** Is `tag` a release-candidate tag name (`v1.0.0-rc.1`)? */
export function isRcTag(tag) {
  return typeof tag === 'string' && RC_TAG.test(tag);
}

/**
 * Is `ref` a fully-qualified release-candidate TAG ref? A branch that happens
 * to be named like an RC is not one — branches move.
 */
export function isRcRef(ref) {
  return (
    typeof ref === 'string' &&
    ref.startsWith('refs/tags/') &&
    isRcTag(ref.slice('refs/tags/'.length))
  );
}

const SHA = /^[0-9a-f]{40}$/;

/**
 * Resolve a tag on the remote to its PEELED commit sha with `git ls-remote`.
 * An annotated tag lists both the tag object and `^{}` (the commit); the commit
 * is what gets checked out, so it is preferred.
 *
 * @param {string} tag
 * @param {{ remoteDir?: string, remote?: string }} [opts]
 * @returns {{ sha: string | null }}
 */
export function gitLsRemote(tag, opts = {}) {
  const r = spawnSync(
    'git',
    ['ls-remote', '--tags', opts.remote ?? 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
    { cwd: opts.remoteDir ?? process.cwd(), encoding: 'utf8' },
  );
  if (r.status !== 0) {
    throw new Error(`git ls-remote failed (${r.status}): ${String(r.stderr).slice(0, 300)}`);
  }
  /** @type {Record<string, string>} */
  const byRef = {};
  for (const lineText of String(r.stdout).split('\n')) {
    const [sha, ref] = lineText.trim().split(/\s+/);
    if (sha && ref && SHA.test(sha)) byRef[ref] = sha;
  }
  return { sha: byRef[`refs/tags/${tag}^{}`] ?? byRef[`refs/tags/${tag}`] ?? null };
}

/**
 * @typedef {object} Resolution
 * @property {boolean} ok            true only for `resolved` and `early-warning`
 * @property {string} state          resolved | early-warning | a refusal reason
 * @property {boolean} credential
 * @property {string|null} checkoutRef
 * @property {string|null} checkoutSha
 * @property {string|null} tag
 * @property {string} [message]
 */

/** A refusal: carries NO checkout target, by construction. */
function refuse(state, message, credential = true) {
  return { ok: false, state, credential, checkoutRef: null, checkoutSha: null, tag: null, message };
}

/**
 * Decide which knext commit this night runs against.
 *
 * @param {object} input
 * @param {string} input.mode                    KNEXT_COMPAT_MODE
 * @param {string|null} input.pinText            the pin file's text, or null when absent
 * @param {(tag: string) => {sha: string|null}} input.lsRemote
 * @param {string} [input.githubSha]             the executing commit (early-warning only)
 * @param {string} [input.githubRef]
 * @returns {Resolution}
 */
export function resolveCredentialRef({ mode, pinText, lsRemote, githubSha, githubRef }) {
  if (mode === 'early-warning') {
    if (typeof githubSha !== 'string' || !SHA.test(githubSha)) {
      return refuse('no-github-sha', 'early-warning mode needs the executing GITHUB_SHA', false);
    }
    return {
      ok: true,
      state: 'early-warning',
      credential: false,
      checkoutRef: githubRef ?? null,
      checkoutSha: githubSha,
      tag: null,
    };
  }
  if (mode !== 'credential') {
    // An unknown mode is REFUSED. Treating it as early-warning would be safe for
    // the count but would hide a broken cron↔mode mapping; treating it as
    // credential without the pin would be the fallback this file forbids.
    return refuse('mode-unknown', `unknown KNEXT_COMPAT_MODE ${JSON.stringify(mode)}`);
  }

  if (pinText === null || pinText === undefined) {
    return refuse(
      'pin-missing',
      `${PIN_FILE} is missing — the credential lane will not guess a ref`,
    );
  }
  let pin;
  try {
    pin = JSON.parse(pinText);
  } catch (err) {
    return refuse('pin-unreadable', `${PIN_FILE} is not JSON: ${err.message}`);
  }
  if (!pin || typeof pin !== 'object' || !('rcTag' in pin)) {
    return refuse('pin-unreadable', `${PIN_FILE} has no \`rcTag\` key`);
  }
  if (pin.rcTag === null) {
    return refuse(
      'not-cut',
      'no release candidate has been cut yet (rcTag: null). The credential lane refuses rather ' +
        'than testing main; cutting an RC is a founder action (ADR-0056).',
    );
  }
  if (!isRcTag(pin.rcTag)) {
    return refuse(
      'pin-malformed',
      `rcTag ${JSON.stringify(pin.rcTag)} is not a release-candidate tag (vX.Y.Z-rc.N)`,
    );
  }

  let found;
  try {
    found = lsRemote(pin.rcTag);
  } catch (err) {
    return refuse('tag-unresolvable', `could not resolve ${pin.rcTag}: ${err.message}`);
  }
  const sha = found?.sha ?? null;
  if (typeof sha !== 'string' || !SHA.test(sha)) {
    return refuse('tag-missing', `tag ${pin.rcTag} does not exist on the remote`);
  }
  return {
    ok: true,
    state: 'resolved',
    credential: true,
    checkoutRef: `refs/tags/${pin.rcTag}`,
    checkoutSha: sha,
    tag: pin.rcTag,
  };
}

/* c8 ignore start — CLI wrapper */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1];
  };
  const pinPath = arg('pin', PIN_FILE);
  const remoteDir = arg('remote-dir', process.cwd());
  const result = resolveCredentialRef({
    mode: arg('mode', process.env.KNEXT_COMPAT_MODE),
    pinText: existsSync(pinPath) ? readFileSync(pinPath, 'utf8') : null,
    lsRemote: (tag) => gitLsRemote(tag, { remoteDir }),
    githubSha: process.env.GITHUB_SHA,
    githubRef: process.env.GITHUB_REF,
  });

  // Outputs FIRST, refusal or not: the alert reads `state` to tell the declared
  // not-cut state from a broken pin. A refusal writes empty checkout fields.
  const lines = [
    `state=${result.state}`,
    `credential=${result.credential ? 'true' : 'false'}`,
    `checkout_ref=${result.checkoutRef ?? ''}`,
    `checkout_sha=${result.checkoutSha ?? ''}`,
    `tag=${result.tag ?? ''}`,
  ];
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### knext ref under test\n\n| | |\n|---|---|\n| mode | \`${result.ok ? (result.credential ? 'credential' : 'early-warning') : 'REFUSED'}\` |\n| state | \`${result.state}\` |\n| ref | \`${result.checkoutRef ?? '—'}\` |\n| sha | \`${result.checkoutSha ?? '—'}\` |\n${result.message ? `\n${result.message}\n` : ''}`,
    );
  }
  console.log(lines.join('\n'));
  if (!result.ok) {
    console.error(`::error::compat credential ref REFUSED (${result.state}): ${result.message}`);
    process.exit(1);
  }
}
/* c8 ignore stop */

#!/usr/bin/env node
/**
 * compat-credential-line — the PER-RELEASE-LINE credential registry and ref
 * resolver (founder decision 2026-10-08: run the v1.3 four-cell credential
 * window IN PARALLEL with v1.0's, not after v1.0 GA).
 *
 * WHY A SEPARATE FILE. The v1.0 credential harness — `test-e2e-deploy.yml`,
 * `.github/compat-credential-ref.json`, `scripts/compat-credential-ref.mjs`,
 * `scripts/compat-window-audit.mjs` — is the v1.0 window's FROZEN file set
 * (`frozenFileSet()` in scripts/compat-credential-freeze-guard.mjs). Editing
 * any of it restarts the v1.0 14-night windows. So a second line cannot be
 * added as a "lines map" inside those files; it lives here, in files the v1.0
 * harness never imports, and only IMPORTS (never edits) the v1.0 code it
 * reuses. `tests/compat-credential-line.test.ts` asserts that none of the
 * v1.3 lane's files is in `frozenFileSet()`.
 *
 * WHAT A LINE IS. One entry in `CREDENTIAL_LINES`: its own pin file, its own
 * derived workflow (`scripts/compat-line-workflow.mjs`), its own four
 * credential crons, its own alert title/label and its own tracker issue. A
 * line's nights live in its own workflow's runs, so the v1.0 audit (which lists
 * only `test-e2e-deploy.yml`) never sees a v1.3 night and the v1.3 audit
 * (scripts/compat-line-tracker.mjs) never sees a v1.0 night.
 *
 * THE RESOLVER is the v1.3 counterpart of `compat-credential-ref.mjs`, with
 * one extra refusal: the pinned tag must be ON THE LINE (`v1.3.N-rc.M`). A
 * v1.0 tag pinned into the v1.3 pin — or the v1.0 pin file handed to the v1.3
 * lane — REFUSES rather than running the wrong line's code under the v1.3
 * name. There is still no fallback to `main`, in either mode.
 *
 * MODES. `credential` (the line's four crons) resolves the pinned tag and
 * marks the night credential. `early-warning` is what a `workflow_dispatch` of
 * the line's workflow gets (the derived workflow keeps the source's
 * "only the credential crons map to credential" rule): it ALSO checks out the
 * pinned line tag — `main` is not the v1.3 line, so testing it under a v1.3
 * name would measure nothing — but records the night NON-credential. The audit
 * only ever grades `schedule` runs, so a dispatch can never bank a night.
 *
 * Usage (the derived workflow's credential-ref job):
 *   node scripts/compat-credential-line.mjs --line v1.3 --mode credential \
 *     --pin knext/.github/compat-credential-ref-v1.3.json --remote-dir knext
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COMPAT_MODES, gitLsRemote, isRcTag } from './compat-credential-ref.mjs';

const NUM = '(?:0|[1-9]\\d*)';

/**
 * The release lines that run a credential window OTHER than the v1.0 one.
 * v1.0 is deliberately absent: it is served, unchanged, by
 * `test-e2e-deploy.yml` + `compat-credential-ref.mjs`.
 */
export const CREDENTIAL_LINES = Object.freeze({
  'v1.3': Object.freeze({
    line: 'v1.3',
    /** The pin, read from `main` (the executing ref of a scheduled run). */
    pinFile: '.github/compat-credential-ref-v1.3.json',
    /** A tag is on this line iff it matches. */
    tagPattern: new RegExp(`^v1\\.3\\.${NUM}-rc\\.${NUM}$`),
    /** The DERIVED workflow that executes this line's nights (basename). */
    workflowFile: 'compat-credential-v1.3.yml',
    /** The tag's own workflow the derived one is generated from. */
    sourceWorkflow: '.github/workflows/test-e2e-deploy.yml',
    workflowName: 'Compat suite v1.3 credential (official Next.js deploy harness)',
    /**
     * v1.0 credential cron → this line's cron for the SAME cell. Offset from
     * v1.0's 22:17 / 23:47 / 01:17 / 05:47 UTC nights (and its 03:17 / 04:47
     * early-warning nights) so the 8 cells/night do not contend for the shared
     * runner pool: the v1.3 nights start ~5.5 h after the last v1.0 slot and
     * end before the first one, even at a 5 h run.
     */
    cronMap: Object.freeze({
      '17 1 * * *': '17 11 * * *', // node × turbopack   (lane `node`)
      '47 5 * * *': '47 12 * * *', // bun × turbopack    (lane `bun`)
      '17 22 * * *': '17 14 * * *', // node × webpack    (lane `node-webpack`)
      '47 23 * * *': '47 15 * * *', // bun × webpack     (lane `bun-webpack`)
    }),
    /** The v1.0 EARLY-WARNING crons: not scheduled on this line (credential-only). */
    unscheduledCrons: Object.freeze(['17 3 * * *', '47 4 * * *']),
    /** The four stable cells (founder decision: vinext stays Beta, uncredentialed). */
    cells: Object.freeze([
      Object.freeze({ runtime: 'node', builder: 'turbopack', lane: 'node', wired: true }),
      Object.freeze({ runtime: 'bun', builder: 'turbopack', lane: 'bun', wired: true }),
      Object.freeze({ runtime: 'node', builder: 'webpack', lane: 'node-webpack', wired: true }),
      Object.freeze({ runtime: 'bun', builder: 'webpack', lane: 'bun-webpack', wired: true }),
    ]),
    /** Per-cell red-alert issue title prefix and label — disjoint from v1.0's. */
    alertTitle: 'Compat v1.3 CREDENTIAL RED (${KNEXT_LANE}, RC tag)',
    resetLabel: 'credential-reset-v1.3',
    /** The aggregate tracker issue — unpinned (GitHub's 3-pin cap is v1.0's). */
    trackerTitle: 'Compat v1.3 credential matrix tracker',
    trackerLabel: 'credential-matrix-tracker-v1.3',
    trackerWorkflow: 'compat-credential-v1.3-tracker.yml',
  }),
});

/** @param {string} line */
export function lineSpec(line) {
  const spec = Object.hasOwn(CREDENTIAL_LINES, line) ? CREDENTIAL_LINES[line] : null;
  if (!spec) {
    throw new Error(
      `compat-credential-line: unknown line ${JSON.stringify(line)} (known: ${Object.keys(CREDENTIAL_LINES).join(', ')})`,
    );
  }
  return spec;
}

/** Is `tag` an RC tag ON `line`? */
export function isLineTag(line, tag) {
  return isRcTag(tag) && lineSpec(line).tagPattern.test(tag);
}

/** Is `ref` (`refs/tags/…`) an RC tag ref on `line`? */
export function isLineRef(line, ref) {
  return (
    typeof ref === 'string' &&
    ref.startsWith('refs/tags/') &&
    isLineTag(line, ref.slice('refs/tags/'.length))
  );
}

const SHA = /^[0-9a-f]{40}$/;

/** A refusal carries NO checkout target, by construction (same as v1.0's). */
function refuse(line, state, message, credential = true) {
  return {
    ok: false,
    line,
    state,
    credential,
    checkoutRef: null,
    checkoutSha: null,
    tag: null,
    message,
  };
}

/**
 * Decide which knext commit a night of `line` runs against.
 *
 * @param {object} input
 * @param {string} input.line
 * @param {string} input.mode                 KNEXT_COMPAT_MODE
 * @param {string|null} input.pinText         the line pin's text, or null when absent
 * @param {(tag: string) => {sha: string|null}} input.lsRemote
 */
export function resolveLineCredentialRef({ line, mode, pinText, lsRemote }) {
  if (!Object.hasOwn(CREDENTIAL_LINES, line)) {
    return refuse(line ?? null, 'line-unknown', `unknown credential line ${JSON.stringify(line)}`);
  }
  const spec = CREDENTIAL_LINES[line];
  if (!COMPAT_MODES.includes(mode)) {
    return refuse(line, 'mode-unknown', `unknown KNEXT_COMPAT_MODE ${JSON.stringify(mode)}`);
  }
  const credential = mode === 'credential';
  if (pinText === null || pinText === undefined) {
    return refuse(
      line,
      'pin-missing',
      `${spec.pinFile} is missing — the ${line} lane will not guess a ref`,
      credential,
    );
  }
  let pin;
  try {
    pin = JSON.parse(pinText);
  } catch (err) {
    return refuse(
      line,
      'pin-unreadable',
      `${spec.pinFile} is not JSON: ${err.message}`,
      credential,
    );
  }
  if (!pin || typeof pin !== 'object' || !('rcTag' in pin)) {
    return refuse(line, 'pin-unreadable', `${spec.pinFile} has no \`rcTag\` key`, credential);
  }
  // The pin must DECLARE its line. The v1.0 pin carries no `line` key, so
  // handing it to this lane (a wiring slip) refuses instead of running v1.0's
  // tag under the v1.3 name.
  if (pin.line !== line) {
    return refuse(
      line,
      'pin-line-mismatch',
      `${spec.pinFile} declares line ${JSON.stringify(pin.line ?? null)}, not ${JSON.stringify(line)}`,
      credential,
    );
  }
  if (pin.rcTag === null) {
    return refuse(
      line,
      'not-cut',
      `no ${line} release candidate is pinned (rcTag: null) — the lane refuses rather than testing main`,
      credential,
    );
  }
  if (!isRcTag(pin.rcTag)) {
    return refuse(
      line,
      'pin-malformed',
      `rcTag ${JSON.stringify(pin.rcTag)} is not a release-candidate tag (vX.Y.Z-rc.N)`,
      credential,
    );
  }
  if (!spec.tagPattern.test(pin.rcTag)) {
    return refuse(
      line,
      'tag-off-line',
      `rcTag ${pin.rcTag} is not on the ${line} line — a ${line} night never runs another line's tag`,
      credential,
    );
  }
  let found;
  try {
    found = lsRemote(pin.rcTag);
  } catch (err) {
    return refuse(
      line,
      'tag-unresolvable',
      `could not resolve ${pin.rcTag}: ${err.message}`,
      credential,
    );
  }
  const sha = found?.sha ?? null;
  if (typeof sha !== 'string' || !SHA.test(sha)) {
    return refuse(line, 'tag-missing', `tag ${pin.rcTag} does not exist on the remote`, credential);
  }
  return {
    ok: true,
    line,
    state: credential ? 'resolved' : 'early-warning',
    credential,
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
  const line = arg('line', undefined);
  const spec = Object.hasOwn(CREDENTIAL_LINES, line) ? CREDENTIAL_LINES[line] : null;
  const pinPath = arg('pin', spec?.pinFile ?? '');
  const remoteDir = arg('remote-dir', process.cwd());
  const result = resolveLineCredentialRef({
    line,
    mode: arg('mode', process.env.KNEXT_COMPAT_MODE),
    pinText: pinPath && existsSync(pinPath) ? readFileSync(pinPath, 'utf8') : null,
    lsRemote: (tag) => gitLsRemote(tag, { remoteDir }),
  });
  // Same output contract as compat-credential-ref.mjs (the derived workflow's
  // jobs read exactly these keys), plus `line`. Written FIRST, refusal or not.
  const lines = [
    `state=${result.state}`,
    `credential=${result.credential ? 'true' : 'false'}`,
    `checkout_ref=${result.checkoutRef ?? ''}`,
    `checkout_sha=${result.checkoutSha ?? ''}`,
    `tag=${result.tag ?? ''}`,
    `line=${result.line ?? ''}`,
  ];
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### knext ref under test (${result.line ?? 'unknown'} line)\n\n| | |\n|---|---|\n| mode | \`${result.ok ? (result.credential ? 'credential' : 'early-warning') : 'REFUSED'}\` |\n| state | \`${result.state}\` |\n| ref | \`${result.checkoutRef ?? '—'}\` |\n| sha | \`${result.checkoutSha ?? '—'}\` |\n${result.message ? `\n${result.message}\n` : ''}`,
    );
  }
  console.log(lines.join('\n'));
  if (!result.ok) {
    console.error(
      `::error::compat credential ref REFUSED for line ${result.line} (${result.state}): ${result.message}`,
    );
    process.exit(1);
  }
}
/* c8 ignore stop */

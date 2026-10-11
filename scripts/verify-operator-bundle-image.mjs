#!/usr/bin/env node
/**
 * Release-integrity guard: the image an `operator-vX.Y.Z` bundle pins must be the image
 * THAT release built.
 *
 * Why: the published `operator-v1.0.0` release attached an `install.yaml` pinning
 * `kn-next-operator:v0.1.0@sha256:3b35d33e…`. The tag was cut from a line that predates
 * the version stamp, so the committed `newTag: v0.1.0@…` survived and only its digest was
 * re-pinned. Nothing compared the bundle's image tag with the release tag.
 *
 * Checks (every one must hold, any doubt is a failure):
 *   - each `--install` is readable and non-empty;
 *   - `--tag` is a well-formed `operator-vX.Y.Z[-pre]`;
 *   - `--digest` is a well-formed `sha256:<64 hex>`;
 *   - the bundle has exactly one distinct `…/kn-next-operator` image reference, written
 *     `<repo>:<tag>@sha256:<64 hex>` (a bare tag, or a bare digest with no tag recorded, fails);
 *   - that tag is `vX.Y.Z` of the release tag;
 *   - that digest is the one pushed by this run.
 *
 * Usage:
 *   node scripts/verify-operator-bundle-image.mjs --tag operator-vX.Y.Z \
 *        --digest sha256:<64 hex> --install <install.yaml> [--install <more>]
 * Exit 0 = every bundle matches. Exit 1 = mismatch or anything unverifiable. Exit 2 = usage.
 *
 * Node builtins only (the publishing job has no install step).
 */

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OPERATOR_TAG = /^operator-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const IMAGE_LINE = /^\s*(?:-\s+)?image:\s*["']?([^\s"']+)["']?\s*(?:#.*)?$/;
const OPERATOR_REF = /\/kn-next-operator(?:[:@]|$)/;
const PINNED = /^(.+\/kn-next-operator):([^@:\s]+)@(sha256:[0-9a-f]{64})$/;

/** @returns {{ ok: true } | { ok: false, reason: string }} */
export function verifyBundleImage({ tag, digest, text }) {
  const t = OPERATOR_TAG.exec(tag ?? '');
  if (!t) return { ok: false, reason: `'${tag}' is not an operator-vX.Y.Z[-pre] tag` };
  if (!DIGEST.test(digest ?? '')) {
    return { ok: false, reason: `'${digest}' is not a sha256:<64 hex> digest` };
  }
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, reason: 'install.yaml is empty' };
  }
  const refs = new Set();
  for (const line of text.split('\n')) {
    const m = IMAGE_LINE.exec(line);
    if (m && OPERATOR_REF.test(m[1])) refs.add(m[1]);
  }
  if (refs.size === 0) return { ok: false, reason: 'no kn-next-operator image reference found' };
  if (refs.size > 1) {
    return { ok: false, reason: `more than one operator image: ${[...refs].join(', ')}` };
  }
  const [ref] = refs;
  const p = PINNED.exec(ref);
  if (!p) {
    return {
      ok: false,
      reason: `'${ref}' is not <repo>:<tag>@sha256:<64 hex> (tag and digest both required)`,
    };
  }
  const want = `v${t[1]}`;
  if (p[2] !== want) {
    return {
      ok: false,
      reason: `bundle pins image tag '${p[2]}' but the release is ${tag} (expected '${want}')`,
    };
  }
  if (p[3] !== digest) {
    return { ok: false, reason: `bundle pins ${p[3]} but this run built ${digest}` };
  }
  return { ok: true };
}

function readInstall(path) {
  try {
    return { text: readFileSync(path, 'utf8') };
  } catch (err) {
    return { error: `cannot read ${path}: ${err.message}` };
  }
}

export function main(argv) {
  const opts = { install: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!['--tag', '--digest', '--install'].includes(k) || v === undefined) {
      console.error(`unknown or incomplete argument: ${k}`);
      return 2;
    }
    if (k === '--install') opts.install.push(v);
    else opts[k.slice(2)] = v;
  }
  if (!opts.tag || !opts.digest || opts.install.length === 0) {
    console.error(
      'usage: --tag <operator-vX.Y.Z> --digest <sha256:…> --install <file> [--install <file>]',
    );
    return 2;
  }
  let failed = false;
  for (const file of opts.install) {
    const r = readInstall(file);
    const res = r.error
      ? { ok: false, reason: r.error }
      : verifyBundleImage({ tag: opts.tag, digest: opts.digest, text: r.text });
    if (res.ok) {
      console.log(`OK ${file}: pins ${opts.tag} image @ ${opts.digest}`);
    } else {
      console.error(`::error::${file}: ${res.reason}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

// Compare REAL paths: node resolves symlinks in import.meta.url but not in argv[1], and a
// mismatch here would skip main() and exit 0 without checking anything (fail-open).
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  process.exit(main(process.argv.slice(2)));
}

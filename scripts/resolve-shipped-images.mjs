#!/usr/bin/env node
/**
 * resolve-shipped-images — list the images we have PUBLISHED, by digest, so the
 * nightly can Trivy-scan exactly the bytes users pull.
 *
 *   - the operator: the digest-pinned image in the `install.yaml` of the
 *     `operator-latest` and `operator-edge` releases and of the newest
 *     `operator-v*` release. The bundle is what `kubectl apply` installs, so its
 *     digest is the one that matters;
 *   - the reference app (`file-manager`): the newest main commit that has a
 *     published tag. The app image is tagged with the commit SHA;
 *   - the function template images (`knext-function-go`, `knext-function-rust`),
 *     by the same commit-SHA tag convention. They are NOT published today (the
 *     template workflows build, scan and discard), so "never published" is a
 *     notice, not a failure. `tests/shipped-scan.test.ts` goes red the day a
 *     workflow starts publishing one, so this cannot silently go stale.
 *
 * FAIL LOUD. Only a positive "manifest unknown" from the registry, or a missing
 * release, counts as "not there". A registry or GitHub API that cannot be reached
 * is an error. The operator list must be non-empty: scanning nothing is not a pass.
 *
 * Output: a JSON array of `{name, ref}` to stdout, and `images=<json>` to
 * $GITHUB_OUTPUT when set.
 *
 * Usage: node scripts/resolve-shipped-images.mjs --repo owner/name [--ref <commit-ish>]
 * Needs `gh` (GH_TOKEN) and `crane` (logged in to ghcr.io) on PATH.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyRegistryError, operatorImageRefs, TEMPLATE_IMAGES } from './lib/shipped-scan.mjs';

const MAX_COMMITS = 25;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function fail(message) {
  console.error(`::error::resolve-shipped-images: ${message}`);
  process.exit(2);
}

/** `gh release download`: a missing release is not-found; anything else is an error. */
function releaseInstallYaml(repo, tag) {
  const dir = mkdtempSync(join(tmpdir(), 'rel-'));
  try {
    const res = spawnSync(
      'gh',
      ['release', 'download', tag, '-R', repo, '-p', 'install.yaml', '-D', dir],
      { encoding: 'utf8' },
    );
    if (res.status === 0) return readFileSync(join(dir, 'install.yaml'), 'utf8');
    if (/release not found|HTTP 404|no assets match/i.test(res.stderr)) return null;
    return fail(`gh release download ${tag} failed: ${res.stderr || res.error?.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function newestOperatorVersionTag(repo) {
  const res = spawnSync(
    'gh',
    ['release', 'list', '-R', repo, '--limit', '100', '--json', 'tagName,isDraft,publishedAt'],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) return fail(`gh release list failed: ${res.stderr}`);
  const releases = JSON.parse(res.stdout)
    .filter((r) => /^operator-v\d/.test(r.tagName) && !r.isDraft)
    .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
  return releases[0]?.tagName ?? null;
}

/** The digest of `image:tag`, or null when the registry positively says it is absent. */
function digestOf(image, tag) {
  const res = spawnSync('crane', ['digest', `${image}:${tag}`], { encoding: 'utf8' });
  if (res.status === 0) {
    const d = res.stdout.trim();
    if (!/^sha256:[0-9a-f]{64}$/.test(d))
      return fail(`crane returned a malformed digest for ${image}:${tag}: ${d}`);
    return d;
  }
  if (classifyRegistryError(res.stderr) === 'not-found') return null;
  return fail(
    `registry unreachable or refused ${image}:${tag}: ${res.stderr || res.error?.message}`,
  );
}

/** The newest main commit that has a published tag on `image`, or null. */
function newestPublished(image, commits) {
  for (const sha of commits) {
    const digest = digestOf(image, sha);
    if (digest) return { sha, digest };
  }
  return null;
}

function main() {
  const repo = arg('repo') ?? process.env.GITHUB_REPOSITORY;
  if (!repo) fail('--repo owner/name (or GITHUB_REPOSITORY) is required');
  const owner = repo.split('/')[0].toLowerCase();

  const images = [];
  const seen = new Set();
  const add = (name, ref) => {
    if (seen.has(ref)) {
      console.log(`  ${name}: same digest as an image already listed, skipped`);
      return;
    }
    seen.add(ref);
    images.push({ name, ref });
  };

  // ── operator ──────────────────────────────────────────────────────────────
  const tags = ['operator-latest', 'operator-edge'];
  const newest = newestOperatorVersionTag(repo);
  if (newest) tags.push(newest);
  let operatorFound = 0;
  for (const tag of tags) {
    const yaml = releaseInstallYaml(repo, tag);
    if (yaml === null) {
      console.log(`::notice::release ${tag} not found`);
      continue;
    }
    let refs;
    try {
      refs = operatorImageRefs(yaml);
    } catch (err) {
      return fail(`${tag}: ${err.message}`);
    }
    for (const ref of refs) add(`operator (${tag})`, ref);
    operatorFound += 1;
  }
  if (operatorFound === 0)
    fail('no operator release bundle could be read: refusing to scan nothing');

  // ── reference app and function templates, tagged by commit SHA ────────────
  const commits = execFileSync(
    'git',
    ['rev-list', `--max-count=${MAX_COMMITS}`, arg('ref') ?? 'HEAD'],
    {
      encoding: 'utf8',
    },
  )
    .split('\n')
    .filter(Boolean);
  if (commits.length === 0) fail('no commits to look up image tags with');

  const app = `ghcr.io/${owner}/file-manager`;
  const published = newestPublished(app, commits);
  if (!published) {
    fail(
      `no ${app} image found for the last ${commits.length} commits: is the app publish lane failing?`,
    );
  }
  add(`file-manager (${published.sha.slice(0, 12)})`, `${app}@${published.digest}`);

  for (const name of TEMPLATE_IMAGES) {
    const image = `ghcr.io/${owner}/${name}`;
    const found = newestPublished(image, commits);
    if (found) add(`${name} (${found.sha.slice(0, 12)})`, `${image}@${found.digest}`);
    else
      console.log(
        `::notice::${image} has no published image (template images are not published yet)`,
      );
  }

  console.log(images.map((i) => `${i.name}  ${i.ref}`).join('\n'));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `images=${JSON.stringify(images)}\n`);
  }
  process.stdout.write(`${JSON.stringify(images)}\n`);
}

main();

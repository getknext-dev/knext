// Compare the bytes a running server serves against every prerendered HTML file the build
// emitted. Usage: node compare-prerender.mjs <baseUrl> <prerenderDir>
//
// This script DISCOVERS its work by walking <prerenderDir> for `*.html`, rather than carrying a
// hand-written route->file list. That is deliberate and it is the point of the file: the first
// revision of this spike enumerated six pairs by hand, the build emitted seven HTML files, and
// `404.html` — the one entry that does NOT match — was silently never compared. The check
// reported success over its own contents. Walking makes a route the build emits and the check
// does not cover impossible rather than invisible (`.claude/rules/workflow.md`: prefer scanning
// to enumerating).
//
// Exit code is 1 if any discovered route differs, so this can gate rather than merely report.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const base = process.argv[2];
const dir = process.argv[3];

if (!base || !dir) {
  console.error('usage: node compare-prerender.mjs <baseUrl> <prerenderDir>');
  process.exit(2);
}

/** Every `*.html` under `root`, recursively. */
function walkHtml(root, current = root, found = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const abs = join(current, entry.name);
    if (entry.isDirectory()) walkHtml(root, abs, found);
    else if (entry.isFile() && entry.name.endsWith('.html')) found.push(abs);
  }
  return found;
}

/**
 * `<dir>/index.html` -> `/`, `<dir>/blog/alpha.html` -> `/blog/alpha`.
 * `404.html` -> `/404`, which is not a declared route in the probe app, so it exercises the
 * not-found path — the same response `/definitely-not-a-route` produced in the §2.1 table.
 */
function routeFor(root, abs) {
  const rel = relative(root, abs)
    .split(sep)
    .join('/')
    .replace(/\.html$/, '');
  if (rel === 'index') return '/';
  return `/${rel.replace(/\/index$/, '')}`;
}

const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16);

const files = walkHtml(dir).sort();
console.log(`discovered ${files.length} prerendered *.html under ${dir}`);

let differences = 0;

for (const abs of files) {
  const route = routeFor(dir, abs);
  const onDisk = readFileSync(abs);
  const res = await fetch(base + route);
  const served = Buffer.from(await res.arrayBuffer());
  const same = onDisk.equals(served);
  if (!same) differences += 1;
  // The cache header distinguishes "served from the seeded prerender cache" from "rendered by
  // some other path that happens to produce a similar page" — 404 is the case that matters.
  const cache = res.headers.get('x-vinext-cache') ?? '(none)';
  console.log(
    `${route}\t${same ? 'IDENTICAL' : 'DIFFERENT'}\tstatus=${res.status}\tx-vinext-cache=${cache}\tdisk=${onDisk.length}B/${sha(onDisk)}\tserved=${served.length}B/${sha(served)}`,
  );
}

console.log(`${files.length - differences}/${files.length} identical`);
process.exit(differences === 0 ? 0 : 1);

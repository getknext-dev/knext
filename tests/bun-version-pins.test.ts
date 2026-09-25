import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// Absolute, not CWD-relative — the repo convention (vitest.config.ts explains
// why: a run from a sub-directory must not resolve a non-existent path).
const REPO_ROOT = resolve(import.meta.dirname, '..');

/**
 * Every setup-bun step in every workflow must PIN bun (#754).
 *
 * SCAN, don't enumerate: Bun 1.4.0 shipped mid-day 2026-08-20 and changed the
 * compile-cache probe shape; the one `bun-version: latest` lane that ran after
 * the release went red while main's morning run (1.3.14) passed. A pin fixed
 * the five sites that existed — this test is what stops the SIXTH site from
 * reintroducing the drift, including the quiet form: a setup-bun step with NO
 * bun-version key at all also means latest.
 *
 * Allowed forms: an explicit x.y.z, or the #188 dispatch-knob fallback
 * `${{ github.event.inputs.bun-version || 'x.y.z' }}` — note the INPUT's
 * default must itself be a pin (workflow_dispatch materialises defaults;
 * asserted in compat-suite-workflow.test.ts), the `||` alone is not enough.
 */
const WF_DIR = join(REPO_ROOT, '.github/workflows');
const PIN_RE = /^\d+\.\d+\.\d+$/;
const FALLBACK_RE = /\$\{\{\s*github\.event\.inputs\.bun-version\s*\|\|\s*'(\d+\.\d+\.\d+)'\s*\}\}/;

type Step = { file: string; line: number; version: string | null; inputDefault: string | null };

function setupBunSteps(): Step[] {
  const out: Step[] = [];
  for (const f of readdirSync(WF_DIR)) {
    if (!/\.ya?ml$/.test(f)) continue;
    const lines = readFileSync(join(WF_DIR, f), 'utf8').split('\n');
    lines.forEach((l, i) => {
      if (!/uses:\s*\S*setup-bun/.test(l)) return;
      // find bun-version within the step's `with:` block — walk to the next
      // step boundary, NOT a fixed window: a long comment block above the key
      // (test-e2e-deploy.yml keeps 16 lines of pin rationale there) must not
      // make the scanner misread a pinned step as unpinned. Cap generously.
      let version: string | null = null;
      for (let j = i + 1; j < Math.min(i + 60, lines.length); j++) {
        if (/^\s*-\s+(name|uses):/.test(lines[j])) break;
        const m = lines[j].match(/bun-version:\s*(.+?)\s*(#.*)?$/);
        if (m) {
          version = m[1].replace(/^['"]|['"]$/g, '');
          break;
        }
      }
      out.push({ file: f, line: i + 1, version, inputDefault: inputDefaultOf(lines) });
    });
  }
  return out;
}

// For the `${{ inputs.bun-version || 'pin' }}` form the || fallback is DEAD on
// workflow_dispatch (GitHub materialises input defaults), so the guard must
// resolve the input's OWN default in the SAME file — self-contained, no
// cross-file promise to another test (review round 2, item 1: the other
// fallback site's default was asserted nowhere).
function inputDefaultOf(lines: string[]): string | null {
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*bun-version:\s*$/.test(lines[i])) continue;
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
      if (/^\s{0,6}\w[\w-]*:\s*$/.test(lines[j])) break; // next input
      const m = lines[j].match(/default:\s*(.+?)\s*(#.*)?$/);
      if (m) return m[1].replace(/^['"]|['"]$/g, '');
    }
  }
  return null;
}

describe('bun-version pins (#754) — scanned across every workflow', () => {
  const steps = setupBunSteps();

  it('finds exactly the known steps per file — a DISAPPEARING step is as loud as an unpinned one', () => {
    const byFile: Record<string, number> = {};
    for (const s of steps) byFile[s.file] = (byFile[s.file] ?? 0) + 1;
    // Counts grew when the workspace moved off pnpm: `setup-bun` now installs
    // the package manager for every lane that used to run `pnpm/action-setup`,
    // so most workflows gained one step and ci.yml gained several. The exact
    // map is the point — a step DISAPPEARING is as loud as an unpinned one,
    // which a `toBeGreaterThan` would miss.
    //
    // test-e2e-deploy.yml is deliberately NOT in this list beyond its original
    // step: its pnpm drives the next.js compat harness (next.js's own repo uses
    // pnpm), not knext's workspace, so it was left alone.
    expect(byFile).toEqual({
      // 11, was 13: two jobs (compat-smoke, compile-cache-bun-probe) each set up
      // bun TWICE — 1.4.0, then 1.3.14 underneath it — so the second step
      // silently took the first one away, and every install in those jobs ran on
      // a bun that cannot parse a lockfileVersion 3 bun.lock. The platform moved
      // to bun 1.4 (#882) and both pairs collapsed to a single step. A count
      // DROPPING is meant to be as loud as an unpinned step, so editing this
      // number is the deliberate act the comment above asks for.
      // 10, was 11: the seam-alive matrix job retired with its subject
      // (#885 — no webpack layers under the vinext single-graph build),
      // taking its setup-bun step with it. Deliberate edit, per the rule
      // above that a dropping count is a decision, not drift.
      // 11, was 10 (#1156): the standalone-drain-bun-image job builds the
      // shipped standalone-on-bun image and runs the docker e2e via
      // `bun:test`, so it needs its own pinned setup-bun — a count RISING is
      // a decision too, per the rule above.
      // 12, was 11 (#1260): the vinext-node-image job installs the workspace
      // and runs its docker e2e via `bun:test` — its own pinned setup-bun.
      'ci.yml': 12,
      // NEW (#1302): the freeze guard's frozenFileSet() computation needs the
      // workspace's bun to run scripts/compat-credential-freeze-guard.mjs — a
      // count RISING is a decision, per the rule above.
      'compat-credential-freeze-guard.yml': 1,
      'docs-closure-nightly.yml': 1,
      'file-manager-platform-e2e-nightly.yml': 1,
      'mutation-prover-nightly.yml': 1,
      'operator-e2e-nightly.yml': 3,
      'preview.yml': 2,
      'scale-zero-pg.yml': 1,
      // NEW (C1/#785): the publish lane now installs the workspace closure and
      // scans it before building the image it pushes, so it needs the same bun
      // the Dockerfile's builder stage uses. A count RISING is a decision too —
      // this one is it.
      'supply-chain.yml': 1,
      // 2, was 1: the Prepare job's knext-deps install moved from pnpm to a
      // pinned setup-bun after the bun migration merged — pnpm refuses a
      // bun-pinned workspace ("This project is configured to use bun"), which
      // would have reddened the nightly credential lane on its first
      // post-merge run. Deliberate edit per the rule above.
      // 3, was 2: cr-1179 #1 — the compat-window fingerprint used to observe the
      // WORKSPACE bun (a hardcoded build-tool pin) while the suite served on the
      // bun installed in deploy-tests from the dispatchable input, so bumping
      // the lane pin moved the Bun under test without moving the fingerprint and
      // the bun streak never restarted. build-next now installs the LANE's bun
      // (same expression, lane-gated) immediately before the fold. A count
      // RISING is a decision; this one is it.
      'test-e2e-deploy.yml': 3,
      // #608 — the vinext-axis compat lane. Its one setup-bun is UNCONDITIONAL
      // (the compiled artifact has no node arm) and carries the same
      // `inputs.bun-version || '<pin>'` fallback form, so the pin assertion
      // below covers it exactly as it covers the bun lane's.
      // Same fix as test-e2e-deploy.yml — the vinext lane's first-ever firing
      // is what exposed the pnpm/bun mismatch (run 33883692192).
      'compat-vinext.yml': 2,
      'bun-sandbox-fetch-ab.yml': 1,
      // NEW (#926): the npm publish lane installed with `pnpm install
      // --frozen-lockfile` against a repo with NO pnpm-lock.yaml, so every job
      // died at install. All three release.yml jobs and both release-ghp.yml
      // jobs now install with bun, pinned like every other lane.
      'release.yml': 3,
      'release-ghp.yml': 2,
    });
  });

  it('every setup-bun step pins bun — no latest/canary, no omitted key', () => {
    const bad = steps.filter((s) => {
      if (s.version === null) return true; // omitted = latest
      if (PIN_RE.test(s.version)) return false;
      if (!FALLBACK_RE.test(s.version)) return true;
      // fallback form: the input's default in the SAME file must be a pin —
      // dispatch materialises defaults, so the || fallback alone proves nothing
      return !(s.inputDefault !== null && PIN_RE.test(s.inputDefault));
    });
    expect(
      bad.map((s) => `${s.file}:${s.line} -> ${s.version ?? '(bun-version omitted = latest)'}`),
      'unpinned setup-bun steps — pin to x.y.z (or the #188 input||pin fallback); see #754/#807',
    ).toEqual([]);
  });
});
/**
 * Lockstep (#1310): the Bun VERSION is part of the compat credential
 * fingerprint, so a partial bump is not a smaller bump — it is two Buns under
 * one credential. Every site that SELECTS a Bun must name the same one:
 * `packageManager`, every setup-bun pin (and every dispatch-input default
 * behind a `||` fallback), the off-PATH npm install in install-smoke.yml, and
 * every `oven/bun` image in a Dockerfile / template / workflow / script — the
 * latter also pinned BY DIGEST, to the one digest for that tag.
 *
 * Bumping Bun means editing PINNED_BUN and PINNED_BUN_IMAGE_DIGEST below, on
 * purpose. The digest is the multi-arch INDEX digest (`crane digest
 * oven/bun:<v>-alpine`), not a per-platform manifest.
 *
 * Deliberately NOT scanned: prose. "Measured on bun 1.4.0" in a comment or
 * doc is history, and the Bun FLOOR (`bunMeetsFloor`, the compat-vinext.yml
 * floor check, BUN_COUNTED_BODY_FLOOR) is a minimum, not a selection.
 */
const PINNED_BUN = '1.4.2';
const PINNED_BUN_IMAGE_DIGEST =
  'sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f';

function trackedFiles(root: string): string[] {
  const r = Bun.spawnSync(['git', 'ls-files'], { cwd: root });
  if (r.exitCode !== 0) throw new Error(`git ls-files failed: ${r.stderr.toString()}`);
  return r.stdout.toString().split('\n').filter(Boolean);
}

// #1318 — the pattern-based allowlist above (Dockerfile*/.hbs/workflows/
// scripts/*.sh) only covered the file SHAPES that existed when it was
// written. A future image ref in `examples/**/*.sh`, a `.mjs`/`.ts`
// generator, or a k8s YAML manifest would never match any of those four
// patterns and would escape the scan entirely — an ENUMERATED allowlist is
// exactly the "second file gets missed" failure mode this repo's own
// workflow discipline warns about. SCAN every tracked text file instead —
// markdown prose (`.md`/`.mdx`) is still excluded WHOLESALE (never a
// selection site by construction, and prose churns too much to line-mark
// individually), but `.test.*` files are NOT excluded by extension.
//
// #1392 review — a blanket `.test.*` extension exclude hid a REAL selection
// site: `tests/e2e-native-rebuild-musl.docker-e2e.test.ts` boots the pinned
// image directly (ci.yml runs it) — bumping its constant to a stale version
// stayed green under the old blanket exclude. Test files legitimately
// contain BOTH real selections (that one) and non-selections (synthetic
// fixture data, historical prose) that must stay pinnable/scannable per
// LINE, not thrown out per FILE. `LINE_EXEMPT_MARKER` is that per-line
// escape hatch — auditable (`git grep` for the marker finds every exemption
// and its reason, right next to the line it exempts), and it cannot exempt
// a line silently: every exemption is a visible, reviewed comment in the
// diff that added it.
const LINE_EXEMPT_MARKER = 'oven-bun-pin-exempt';

/** Files that SELECT an image — markdown prose is the only wholesale exclusion; everything else is scanned and line-exemptions (LINE_EXEMPT_MARKER) carry the rest. */
function imageBearingFiles(root: string): string[] {
  return trackedFiles(root).filter((f) => !f.startsWith('.claude/') && !/\.(md|mdx)$/.test(f));
}

/**
 * #1392 round 3 — the LINE_EXEMPT_MARKER above can waive ANY line, including
 * one that genuinely SELECTS an image at build/run time. A stale `FROM
 * oven/bun:1.4.0-alpine # oven-bun-pin-exempt: ...` in a Dockerfile would
 * stay green forever — the marker was meant for prose/fixtures/comments
 * INSIDE test files, not for the file classes Docker builds, CI runs, and
 * scaffolding stamps into every generated app. Those classes REJECT the
 * marker outright: a real drift there must be fixed, never waived.
 *   - Dockerfile* (any BUILD context's FROM line)
 *   - *.hbs (a template stamps its pin into every scaffolded app)
 *   - .github/workflows/** (what CI actually executes)
 *   - scripts/*.sh (what those workflow steps shell out to)
 */
function isMarkerRejectedPath(f: string): boolean {
  const base = f.split('/').pop() ?? f;
  if (/^Dockerfile/.test(base)) return true;
  if (/\.hbs$/.test(f)) return true;
  if (f.startsWith('.github/workflows/')) return true;
  if (/^scripts\/[^/]+\.sh$/.test(f)) return true;
  return false;
}

type ScanResult = { selecting: number; exempted: number; off: string[] };

/** The scan itself — pulled out of the `it()` body so it can run against a synthetic fixture root, not just REPO_ROOT (#1392 round 3 testability). */
function scanOvenBunImageRefs(root: string, tag: string, pinned: string): ScanResult {
  let selecting = 0;
  let exempted = 0;
  const off: string[] = [];
  for (const f of imageBearingFiles(root)) {
    readFileSync(join(root, f), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (line.includes(LINE_EXEMPT_MARKER)) {
          if (isMarkerRejectedPath(f)) {
            off.push(
              `${f}:${i + 1}: LINE_EXEMPT_MARKER is not permitted in this file class (Dockerfile*/.hbs/workflows/scripts/*.sh) — fix the pin, do not exempt it`,
            );
            return;
          }
          if (/oven\/bun(?::\w(?:[\w.-]*\w)?)?(?:@sha256:[0-9a-f]+)?/.test(line)) exempted++;
          return;
        }
        const isComment = /^\s*(#|\/\/|\*)/.test(line);
        for (const m of line.matchAll(/oven\/bun(?::\w(?:[\w.-]*\w)?)?(?:@sha256:[0-9a-f]+)?/g)) {
          if (m[0] === 'oven/bun') continue;
          const ok = isComment ? m[0] === tag || m[0] === pinned : m[0] === pinned;
          if (!isComment) selecting++;
          if (!ok) off.push(`${f}:${i + 1}: ${m[0]}`);
        }
      });
  }
  return { selecting, exempted, off };
}

/**
 * A throwaway git repo fixture under the OS tmp dir, so `git ls-files`
 * behaves exactly like it does in the real scan. No commit is needed —
 * `git ls-files` reads the INDEX, populated by `git add`, so this stays
 * immune to the ambient gpg-signing config that makes an actual commit
 * fail in a sandboxed environment with no configured signing key.
 */
function makeGitFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'bun-pin-marker-fixture-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  Bun.spawnSync(['git', 'init', '-q'], { cwd: dir });
  Bun.spawnSync(['git', 'add', '-A'], { cwd: dir });
  return dir;
}

describe('LINE_EXEMPT_MARKER is rejected in image-selecting file classes (#1392 round 3)', () => {
  it.each([
    ['apps/docs/Dockerfile', true],
    ['apps/docs/Dockerfile.oke', true],
    ['packages/kn-next/templates/app/Dockerfile.hbs', true],
    ['.github/workflows/ci.yml', true],
    ['scripts/e2e-summary.sh', true],
    ['tests/bytecode-liveness.test.ts', false],
    ['packages/kn-next/src/adapters/bun-keepalive-guard.cjs', false],
    ['scripts/lib/knext-closure.mjs', false],
  ])('%s -> rejected=%s', (path, expected) => {
    expect(isMarkerRejectedPath(path)).toBe(expected);
  });

  // The fixture literals below name a fake, deliberately-stale image ref —
  // spelled `oven/bun` + `:` + digits so it does NOT match this repo's own
  // `oven/bun(?::...)?` selection regex verbatim in a way that would need
  // a marker on THIS line too: the fixture tag differs from the real
  // lockstep pin, so bun-version-pins.test.ts's own real-repo scan sees it
  // as a non-matching-but-exempt-by-marker fixture, same as the Dockerfile
  // fixture content itself.
  const fixtureTag = 'oven/bun:1.4.2-alpine'; // oven-bun-pin-exempt: test fixture argument, not a real selection
  const fixturePinned = `${fixtureTag}@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f`; // oven-bun-pin-exempt: test fixture argument, not a real selection

  it('a stale, marker-exempted pin in a Dockerfile is flagged, not silently waived', () => {
    const dir = makeGitFixture({
      'apps/docs/Dockerfile':
        'FROM oven/bun:1.4.0-alpine@sha256:0000000000000000000000000000000000000000000000000000000000000000 # oven-bun-pin-exempt: pretend this is reviewed\n',
    });
    const { off } = scanOvenBunImageRefs(dir, fixtureTag, fixturePinned);
    expect(off.some((o) => o.includes('apps/docs/Dockerfile:1'))).toBe(true);
    expect(off.some((o) => o.includes('LINE_EXEMPT_MARKER is not permitted'))).toBe(true);
  });

  it('the same marker-exempted line in a non-rejected file (e.g. a .cjs comment) is accepted as before', () => {
    const dir = makeGitFixture({
      'lib/example.cjs':
        '// historical note about oven/bun:1.4.0-alpine // oven-bun-pin-exempt: prose, not a selection\n',
    });
    const { off, exempted } = scanOvenBunImageRefs(dir, fixtureTag, fixturePinned);
    expect(off).toEqual([]);
    expect(exempted).toBe(1);
  });
});

describe(`bun lockstep (#1310) — one Bun (${PINNED_BUN}) everywhere it is selected`, () => {
  it('packageManager pins the lockstep Bun', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(pkg.packageManager).toBe(`bun@${PINNED_BUN}`);
  });

  it('every setup-bun pin, and every dispatch-input default behind a fallback, is the lockstep Bun', () => {
    const steps = setupBunSteps();
    expect(steps.length).toBeGreaterThan(0);
    const off = steps.flatMap((s) => {
      const out: string[] = [];
      const pinned =
        s.version && PIN_RE.test(s.version) ? s.version : s.version?.match(FALLBACK_RE)?.[1];
      if (pinned !== PINNED_BUN) out.push(`${s.file}:${s.line} setup-bun -> ${s.version}`);
      if (s.version && FALLBACK_RE.test(s.version) && s.inputDefault !== PINNED_BUN) {
        out.push(`${s.file} inputs.bun-version.default -> ${s.inputDefault}`);
      }
      return out;
    });
    expect(off).toEqual([]);
  });

  it('the off-PATH npm bun in install-smoke.yml is the lockstep Bun', () => {
    const text = readFileSync(join(REPO_ROOT, '.github/workflows/install-smoke.yml'), 'utf8');
    const pins = [...text.matchAll(/\bbun@(\d+\.\d+\.\d+)\b/g)].map((m) => m[1]);
    expect(pins.length).toBeGreaterThan(0);
    expect([...new Set(pins)]).toEqual([PINNED_BUN]);
  });

  it('every oven/bun image reference is the lockstep tag, pinned by the one digest', () => {
    const tag = `oven/bun:${PINNED_BUN}-alpine`;
    const pinned = `${tag}@${PINNED_BUN_IMAGE_DIGEST}`;
    const { selecting, exempted, off } = scanOvenBunImageRefs(REPO_ROOT, tag, pinned);
    expect(selecting).toBeGreaterThan(0);
    // Proves the exemption mechanism is actually exercised by the real repo
    // (not just theoretically wired) — a `LINE_EXEMPT_MARKER` with nothing
    // to exempt would be silent dead code.
    expect(exempted).toBeGreaterThan(0);
    expect(off).toEqual([]);
  });
});

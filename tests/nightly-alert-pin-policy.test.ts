import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { effectiveWorkflowText } from './helpers/publish-markers';

/**
 * #1347: ONE deterministic pin policy, enforced by a scan rather than left
 * as a convention someone has to remember. Before this, 9 nightly
 * workflows (`action-pin-resolution-nightly.yml`,
 * `anonymous-install-nightly.yml`, `compat-vinext.yml`,
 * `docs-closure-nightly.yml`, `file-manager-platform-e2e-nightly.yml`,
 * `image-pin-resolution-nightly.yml`, `mutation-prover-nightly.yml`,
 * `retracted-figure-resolution-nightly.yml`, `scaffold-install-nightly.yml`)
 * each independently called `gh issue pin` on their own alert issue, all
 * racing for GitHub's hard 3-pinned-issues-per-repo cap — with a failed pin
 * demoted to `|| echo "::warning::...(non-fatal)"`, so a red beyond the
 * third pinned issue went genuinely unseen (follow-up from #1300 review
 * round 2 finding 1).
 *
 * The fix: every one of those 9 now routes through
 * `scripts/lib/nightly-alert-issue.mjs`'s `ensureAlertIssue`, which has no
 * pin branch at all (see its own header). The ONE exception is the v1.0
 * credential-matrix tracker (#1359,
 * `scripts/compat-matrix-tracker.mjs`) — a single pinned aggregate issue,
 * kept current daily, that exists SPECIFICALLY so nothing else needs to
 * pin. This is the ALLOWLIST that makes the policy deterministic rather
 * than aspirational: exactly one file may invoke a pin operation — either
 * the `gh issue pin` CLI verb or the GraphQL `pinIssue` mutation (the
 * tracker uses the latter, having found the CLI verb has no reliable
 * "is this pinned" counterpart — see that script's own header) — and this
 * test SCANS every workflow file and every script file for both signals,
 * failing on ANY occurrence outside the allowlist.
 *
 * A SCAN, not an enumerated list of the 9 known offenders: a NEW nightly
 * workflow that copies the old inline pin-then-warn pattern trips this
 * immediately, rather than needing someone to remember to add it to a
 * "workflows I checked" list (the same shape #670c's regression guard
 * uses for the resolver, and the same shape the `crane push` marker in
 * `tests/ci-concurrency-group.test.ts` uses for the publish-marker scan).
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOWS_DIR = resolve(REPO_ROOT, '.github/workflows');
const SCRIPTS_DIR = resolve(REPO_ROOT, 'scripts');

/**
 * #1421 review round 1 (jev 0.83) — the real INVOCATION, not a mere mention.
 * A bare `.includes('nightly-alert-issue.mjs')` also matches every migrated
 * workflow's OWN comment prose (each names the helper in two comment lines
 * explaining the migration) — the reviewer deleted the real
 * `node scripts/nightly-alert-issue.mjs` line in two workflows and this
 * stayed green. A comment line's first non-whitespace character is `#`, so
 * `[^#\n]*` greedily matching everything up to (but never past) a `#`
 * cannot span one: the character immediately after `^\s*` on a comment line
 * IS `#`, so `[^#\n]*` matches zero characters there and the required
 * literal `node` never follows. The real invocation line
 * (`TITLE="${title}" BODY="${body}" node scripts/nightly-alert-issue.mjs`)
 * has no `#` before `node`, so it matches.
 */
const NIGHTLY_ALERT_INVOCATION_RE = /^\s*[^#\n]*\bnode scripts\/nightly-alert-issue\.mjs\b/m;

/**
 * The ONLY file(s) permitted to actually pin an issue. Relative to repo
 * root, matching how `git ls-files`-style enumeration elsewhere in this
 * repo names files.
 */
const PIN_ALLOWLIST = new Set(['scripts/compat-matrix-tracker.mjs']);

/**
 * Signals that PIN an issue, whichever of the four shapes this repo's `gh`
 * callables use: the shell CLI text (`gh issue pin ...`), the same CLI text
 * with FLAGS interposed before `issue pin` (`gh --repo X issue pin ...` —
 * `gh`'s own flag placement is not fixed, so a global flag can sit anywhere
 * before the subcommand; the first, literal-adjacency signal alone misses
 * this, per #1406 review round 2), the GraphQL mutation (`pinIssue(...)`,
 * the tracker's own mechanism), or an ARRAY-ARGUMENT `gh` call —
 * `gh(['issue', 'pin', ...])`, the shape `scripts/lib/nightly-alert-issue.mjs`'s
 * own `gh` callable takes (every `gh(...)` invocation in this repo's `.mjs`
 * scripts passes an args array, never a shell string) — a mutation-proved gap:
 * the first two signals alone let a hypothetical `gh(['issue', 'pin', ...])`
 * inside the shared helper pass the scan silently.
 */
const PIN_SIGNALS = [
  /\bgh issue pin\b/,
  /\bgh\b[^\n]*\bissue\s+pin\b/,
  /\bpinIssue\s*\(/,
  /['"]issue['"]\s*,\s*['"]pin['"]/,
];

function stripJsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * `effectiveWorkflowText` strips true YAML-level `#` comments via
 * parse+re-serialise, but a `run: |` block scalar is an OPAQUE STRING to the
 * YAML parser — a bash `#`-comment line INSIDE that string (e.g. prose
 * mentioning `gh issue pin` to explain why a nearby line does NOT call it,
 * as `test-e2e-deploy.yml` and `compat-matrix-tracker-nightly.yml` both do)
 * survives re-serialisation untouched and would otherwise false-positive
 * this scan. Strip FULL-LINE bash comments (a line whose first non-blank
 * character is `#`) on top — safe against bash's `#`-based parameter
 * expansion (stripping a prefix/suffix from a variable), since that syntax
 * never appears as the first character of a line.
 */
function stripBashCommentLines(text: string): string {
  return text.replace(/^\s*#.*$/gm, '');
}

function listWorkflowFiles(): string[] {
  return readdirSync(WORKFLOWS_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();
}

/**
 * `scripts/mutation-prove-*.mjs` files are excluded from the scan — same
 * precedent every mutation prover in this repo already relies on (e.g.
 * `mutation-prove-nextjs-credential-lockstep.mjs` writes the literal
 * `'v16.3.3'` string repeatedly as MUTATION PAYLOADS, which would trip the
 * guard it is proving if that guard's own scan covered `scripts/`). A
 * mutation prover's job is to plant the exact forbidden text as a labelled
 * anchor/replacement so its target spec goes red — that is evidence the
 * scan works, not a violation of the policy the scan enforces. This file's
 * own prover, `mutation-prove-nightly-alert-pin-policy.mjs`, does exactly
 * that for `gh issue pin`/`pinIssue(`.
 *
 * Anchored to the TOP-LEVEL `scripts/` directory only, mirroring
 * `tests/mutation-prover-lane.test.ts`'s own discovery glob
 * (`git ls-files scripts/mutation-prove-*.mjs`, non-recursive) — a file
 * merely named `mutation-prove-*` somewhere under `scripts/lib/` is real
 * production code, not a tracked prover, and must not get a free pass.
 */
function isMutationProver(relPath: string): boolean {
  return /^scripts\/mutation-prove-[^/]+\.mjs$/.test(relPath);
}

/**
 * #1406 review round 2 — widened from `.mjs`-only. A pin bypass planted in a
 * `.sh` helper `scripts/*.mjs` shells out to, or in a `.ts` file under
 * `scripts/lib/`, was invisible to the original scan; the extension set now
 * covers every language this repo's `scripts/` tree actually uses for CI
 * logic.
 */
const SCRIPT_EXTENSIONS = ['.mjs', '.sh', '.js', '.ts'];

function hasScannedExtension(name: string): boolean {
  return SCRIPT_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function listScriptFiles(dir: string, prefix: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...listScriptFiles(resolve(dir, entry.name), `${prefix}${entry.name}/`));
    } else if (hasScannedExtension(entry.name) && !isMutationProver(`${prefix}${entry.name}`)) {
      out.push(`${prefix}${entry.name}`);
    }
  }
  return out;
}

/**
 * `.github/actions/` — this repo's composite-action directory — is scanned
 * too (#1406 review round 2): a composite action's own `action.yml` can run
 * a pin just as a workflow step can, and it lived entirely outside the
 * original `scripts/`-only scan. Includes `.yml`/`.yaml` (composite-action
 * manifests) on top of the script extensions above. Tolerates the directory
 * not existing yet (it doesn't, today) rather than erroring — the scan must
 * still run clean on a tree with no composite actions.
 */
function listActionFiles(): string[] {
  const dir = resolve(REPO_ROOT, '.github/actions');
  const walk = (d: string, prefix: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        out.push(...walk(resolve(d, entry.name), `${prefix}${entry.name}/`));
      } else if (
        hasScannedExtension(entry.name) ||
        entry.name.endsWith('.yml') ||
        entry.name.endsWith('.yaml')
      ) {
        out.push(`${prefix}${entry.name}`);
      }
    }
    return out;
  };
  try {
    return walk(dir, '.github/actions/');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** `{ relPath, effectiveText }` for every workflow, comments stripped via re-serialisation. */
function scanWorkflows(): Array<{ relPath: string; effectiveText: string }> {
  return listWorkflowFiles().map((file) => ({
    relPath: `.github/workflows/${file}`,
    effectiveText: stripBashCommentLines(
      effectiveWorkflowText(readFileSync(resolve(WORKFLOWS_DIR, file), 'utf8')),
    ),
  }));
}

/**
 * `#`-comment stripping for `.sh` (and `.yml`/`.yaml` composite-action
 * manifests) vs `//`/`/* *\/`-comment stripping for `.mjs`/`.js`/`.ts` —
 * picked by extension so a `.sh` file's bash comments (which a JS stripper
 * cannot see) don't survive into the scan the way the YAML `run:` block
 * case above required `stripBashCommentLines` for.
 */
function stripCommentsFor(relPath: string, text: string): string {
  if (relPath.endsWith('.sh') || relPath.endsWith('.yml') || relPath.endsWith('.yaml')) {
    return stripBashCommentLines(text);
  }
  return stripJsComments(text);
}

/** Same, for every script file under scripts/ (all scanned extensions) — comments stripped. */
function scanScripts(): Array<{ relPath: string; effectiveText: string }> {
  return listScriptFiles(SCRIPTS_DIR, 'scripts/').map((relPath) => ({
    relPath,
    effectiveText: stripCommentsFor(relPath, readFileSync(resolve(REPO_ROOT, relPath), 'utf8')),
  }));
}

/** Same, for every file under `.github/actions/` — comments stripped. */
function scanActions(): Array<{ relPath: string; effectiveText: string }> {
  return listActionFiles().map((relPath) => ({
    relPath,
    effectiveText: stripCommentsFor(relPath, readFileSync(resolve(REPO_ROOT, relPath), 'utf8')),
  }));
}

describe('#1347 — exactly one file may pin an issue (scan, not an enumerated list of known offenders)', () => {
  it('non-vacuity: the scan actually finds pin-capable files today (the allowlisted tracker)', () => {
    // If this fired on NOTHING, the allowlist assertion below would pass
    // vacuously — prove the scan can see a positive before trusting a
    // negative anywhere else.
    const scripts = scanScripts();
    const hits = scripts.filter((s) => PIN_SIGNALS.some((re) => re.test(s.effectiveText)));
    expect(hits.map((h) => h.relPath)).toEqual(['scripts/compat-matrix-tracker.mjs']);
  });

  it('no workflow file calls `gh issue pin` or `pinIssue(` — every nightly alert routes through the never-pin helper', () => {
    const offenders = scanWorkflows()
      .filter((w) => PIN_SIGNALS.some((re) => re.test(w.effectiveText)))
      .map((w) => w.relPath);
    expect(
      offenders,
      `these workflow(s) still pin an issue directly, outside the allowlisted tracker: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('no script file outside the allowlist calls `gh issue pin` or `pinIssue(`', () => {
    const offenders = scanScripts()
      .filter((s) => PIN_SIGNALS.some((re) => re.test(s.effectiveText)))
      .filter((s) => !PIN_ALLOWLIST.has(s.relPath))
      .map((s) => s.relPath);
    expect(
      offenders,
      `these script(s) pin an issue outside the allowlist: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('no file under .github/actions/ calls `gh issue pin` or `pinIssue(` (#1406 review round 2)', () => {
    const offenders = scanActions()
      .filter((a) => PIN_SIGNALS.some((re) => re.test(a.effectiveText)))
      .filter((a) => !PIN_ALLOWLIST.has(a.relPath))
      .map((a) => a.relPath);
    expect(
      offenders,
      `these composite-action file(s) pin an issue outside the allowlist: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('widened signal: catches a global flag interposed before `issue pin` (#1406 review round 2)', () => {
    // The literal-adjacency signal (`\bgh issue pin\b`) alone misses this —
    // `gh`'s flags are not fixed-position, so a bypass can sit a flag
    // between the binary and the subcommand and slip the original scan.
    const bypass = 'gh --repo getknext-dev/knext issue pin 123';
    expect(PIN_SIGNALS.some((re) => re.test(bypass))).toBe(true);
  });

  it('widened extension scan: real .sh files under scripts/ are actually included (non-vacuity, #1406 review round 2)', () => {
    // Not just "the filter compiles" — prove it against the real tree: a
    // known .sh file must come back from the walk, or the widening from
    // `.mjs`-only is decoration.
    const scriptFiles = listScriptFiles(SCRIPTS_DIR, 'scripts/');
    expect(scriptFiles).toContain('scripts/e2e-logs.sh');
  });

  it('every allowlisted entry names a file that still exists AND still actually pins something (no stale entries)', () => {
    const scriptPaths = new Set(listScriptFiles(SCRIPTS_DIR, 'scripts/'));
    for (const entry of PIN_ALLOWLIST) {
      expect(scriptPaths.has(entry), `allowlisted file ${entry} no longer exists`).toBe(true);
      const text = stripJsComments(readFileSync(resolve(REPO_ROOT, entry), 'utf8'));
      expect(
        PIN_SIGNALS.some((re) => re.test(text)),
        `allowlisted file ${entry} no longer pins anything — drop the stale entry`,
      ).toBe(true);
    }
  });

  it('the 9 formerly-offending workflows now route their alert step through nightly-alert-issue.mjs', () => {
    // Positive proof, not just "no pin call": each of the 9 files #1347
    // named must actually call the shared helper, not merely have had its
    // pin line silently deleted with nothing replacing the create/comment
    // path (which would break alerting entirely, not just fix the pin
    // cap).
    const migrated = [
      'action-pin-resolution-nightly.yml',
      'anonymous-install-nightly.yml',
      'compat-vinext.yml',
      'docs-closure-nightly.yml',
      'file-manager-platform-e2e-nightly.yml',
      'image-pin-resolution-nightly.yml',
      'mutation-prover-nightly.yml',
      'retracted-figure-resolution-nightly.yml',
      'scaffold-install-nightly.yml',
    ];
    const byFile = new Map(
      listWorkflowFiles().map((f) => [f, readFileSync(resolve(WORKFLOWS_DIR, f), 'utf8')]),
    );
    for (const file of migrated) {
      const text = byFile.get(file);
      expect(text, `expected workflow ${file} not found under .github/workflows`).toBeTruthy();
      expect(
        NIGHTLY_ALERT_INVOCATION_RE.test(text as string),
        `${file} does not actually INVOKE scripts/nightly-alert-issue.mjs on a real, non-comment line — was it migrated to the shared helper, or did its invocation line get deleted while its migration COMMENTS survived?`,
      ).toBe(true);
    }
  });

  it('self-check: the JS comment stripper does not eat the code it is stripping comments FROM (non-vacuity)', () => {
    const trackerText = stripJsComments(
      readFileSync(resolve(REPO_ROOT, 'scripts/compat-matrix-tracker.mjs'), 'utf8'),
    );
    expect(trackerText).toContain('export function ensurePinned');
    // The header's prose mention of `gh issue pin` should be gone once
    // comments are stripped — otherwise this file's OWN doc comment could
    // be why it (correctly) shows up in the scan, not its real code path.
    expect(trackerText.includes('a failed `gh issue pin` call is only a')).toBe(false);
  });

  it('the mutation-prover exclusion matches ONLY prover files, never the real allowlisted tracker or the shared helper', () => {
    expect(isMutationProver('scripts/mutation-prove-crane-pin.mjs')).toBe(true);
    expect(isMutationProver('scripts/mutation-prove-nightly-alert-pin-policy.mjs')).toBe(true);
    expect(isMutationProver('scripts/compat-matrix-tracker.mjs')).toBe(false);
    expect(isMutationProver('scripts/lib/nightly-alert-issue.mjs')).toBe(false);
    expect(isMutationProver('scripts/nightly-alert-issue.mjs')).toBe(false);
    // A file that merely CONTAINS "mutation-prove" in a longer name (not the
    // exact `mutation-prove-<name>.mjs` shape) must not be excused either —
    // the exclusion is for the prover convention, not a substring escape.
    expect(isMutationProver('scripts/lib/mutation-prove-helpers.mjs')).toBe(false);
  });
});

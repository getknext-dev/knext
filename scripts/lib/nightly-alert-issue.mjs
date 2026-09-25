/**
 * Shared "create-or-update an idempotent nightly alert issue" helper
 * (#1347) — the one place every nightly workflow's alert step routes
 * through, replacing 9 near-identical inline `gh issue list`/`create`/
 * `comment`/`pin` blocks.
 *
 * THE POINT OF THIS FILE: it NEVER calls `gh issue pin`. Before #1347, each
 * of `action-pin-resolution-nightly.yml`, `anonymous-install-nightly.yml`,
 * `compat-vinext.yml`, `docs-closure-nightly.yml`,
 * `file-manager-platform-e2e-nightly.yml`, `image-pin-resolution-nightly.yml`,
 * `mutation-prover-nightly.yml`, `retracted-figure-resolution-nightly.yml`,
 * and `scaffold-install-nightly.yml` independently pinned their own alert
 * issue, all racing for GitHub's hard 3-pinned-issues-per-repo cap — with a
 * failed `gh issue pin` demoted to `|| echo "::warning::...(non-fatal)"`, so
 * a red beyond the third pinned issue went genuinely unseen (#1347, follow-up
 * from #1300 review round 2 finding 1).
 *
 * The fix is structural, not a removed call site someone could re-add: this
 * shared function is the ONLY path all 9 (now migrated) workflows use, and
 * it has no pin branch to accidentally reintroduce. The one exception —
 * `scripts/compat-matrix-tracker.mjs`'s single pinned v1.0 credential-matrix
 * tracker issue (#1359) — deliberately does NOT go through this helper; it
 * has its own `ensurePinned` with unpin-closed/fail-loud semantics that this
 * generic helper does not need. `tests/nightly-alert-pin-policy.test.ts`
 * enforces the allowlist: exactly one file may call `gh issue pin` or the
 * GraphQL `pinIssue` mutation, and it is that tracker script.
 *
 * `gh` is injected (never `execFileSync` imported here) so
 * `tests/nightly-alert-issue.test.ts` exercises every branch — including
 * "a pin call was attempted" as a THROWING double, so a regression that
 * reintroduces pinning fails the unit test, not just the policy scan.
 */

/**
 * @param {{
 *   gh: (args: string[]) => string,
 *   repo: string,
 *   title: string,
 *   body: string,
 * }} opts
 * @returns {{ number: number, created: boolean }}
 */
export function ensureAlertIssue({ gh, repo, title, body }) {
  // --limit 100 explicitly (gh defaults to 30) — the same reason every
  // per-workflow inline block already used it: the dedup lookup must not
  // fall off the first page and file a duplicate issue on a red night.
  const raw = gh([
    'issue',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--limit',
    '100',
    '--json',
    'number,title',
  ]);
  /** @type {Array<{number: number, title: string}>} */
  const issues = JSON.parse(raw);
  const existing = issues.find((i) => i.title === title);

  if (existing) {
    gh(['issue', 'comment', String(existing.number), '--repo', repo, '--body', body]);
    return { number: existing.number, created: false };
  }

  const url = gh(['issue', 'create', '--repo', repo, '--title', title, '--body', body]).trim();
  const number = Number(url.split('/').pop());
  // Deliberately no `gh issue pin` call — see the module header. Every
  // migrated workflow's alert issue is discoverable by title/search, never
  // by competing for one of GitHub's 3 pin slots.
  return { number, created: true };
}

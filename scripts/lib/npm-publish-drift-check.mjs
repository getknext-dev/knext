/**
 * npm-publish-drift-check — #1638 item 2.
 *
 * PROBLEM (from #1638): the `npm-publish` GitHub Environment has no protection
 * rules — `GET /repos/{owner}/{repo}/environments/npm-publish` answers
 * `"protection_rules":[]` — so a scheduled `release.yml` run on `main`
 * publishes to npm with NO reviewer click. There is also no ruleset protecting
 * `v*` tags. Item 1 (adding the reviewer + the ruleset) is founder-only
 * (repo settings); this module is the DETECTOR for item 2: read both settings
 * back through the GitHub API and say, precisely, which is missing.
 *
 * SHAPE, deliberately split in two:
 *   - PURE decision functions (`evaluateReviewerProtection`,
 *     `matchesVStarGlob`, `tagRulesetCoversVStar`, `evaluateTagRulesetProtection`)
 *     take already-parsed API response bodies and return a verdict. No network,
 *     no `fetch`, no `process.env` — every branch is exercised offline by
 *     `tests/npm-publish-drift-check.test.ts` and mutation-proved by
 *     `scripts/mutation-prove-npm-publish-drift-check.mjs`.
 *   - The FETCH layer (`fetchReviewerProtection`, `fetchTagRulesetProtection`,
 *     `runDriftCheck`) takes an injected `api` function — the same shape as
 *     `scripts/verify-action-pins.mjs`'s `githubApi` — so the same fixture
 *     style (a fake `api: path => ({status, body})`) drives the tests without
 *     touching the network.
 *
 * TOKEN PERMISSIONS — the finding this module exists to surface honestly, and
 * MEASURED rather than assumed wherever it could be:
 *
 *   - `actionlint` rejects `environments:` as a `permissions:` key outright
 *     ("unknown permission scope 'environments'", checked against
 *     actionlint's own enumerated scope list) — there is no such GITHUB_TOKEN
 *     grant to make. `GET .../environments/{name}` instead rides on the
 *     token's ordinary repo-read access (`contents: read`, which every job
 *     here already declares).
 *   - `GET .../rulesets` and `GET .../rulesets/{id}` — GitHub's REST docs list
 *     these under the "Administration" repository permission, which also has
 *     no dedicated GITHUB_TOKEN `permissions:` key. LIVE-TESTED against this
 *     PUBLIC repo, unauthenticated (`node scripts/check-npm-publish-drift.mjs`
 *     with no `GITHUB_TOKEN` set at all): both endpoints answered 200, not
 *     403/404 — an anonymous request already sees enough to read a public
 *     repo's environment protection rules and rulesets, and `GITHUB_TOKEN` in
 *     Actions presents at least that much access. So on the first scheduled
 *     run this is expected to resolve cleanly without any extra token. This
 *     module still treats a 403/404 as `permission-error` rather than
 *     `missing` regardless (never assume "empty" from an unreadable
 *     response), and the fallback if that measurement turns out not to hold
 *     on the Actions runner specifically is a fine-grained PAT with
 *     "Administration: Read-only", stored as a repo secret. See
 *     `docs/security/npm-publish-drift-check.md`.
 *
 * The two failure kinds are NEVER conflated in the alert text: "we could not
 * verify" (wrong/missing token scope — tell the founder which scope to add)
 * reads differently from "we verified and it is genuinely empty" (real drift,
 * points at #1638 item 1).
 */

const GITHUB_API_BASE = 'https://api.github.com/';

/** Every API status this module treats as "could not read this, not 'it's empty'". */
const PERMISSION_ERROR_STATUSES = new Set([403, 404]);

// ── Pure decision: the npm-publish environment's required-reviewers rule ────

/**
 * @param {unknown} protectionRules the environment API's `protection_rules` array
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function evaluateReviewerProtection(protectionRules) {
  if (!Array.isArray(protectionRules)) {
    return { ok: false, reason: 'protection_rules was not an array' };
  }
  const rule = protectionRules.find((r) => r && r.type === 'required_reviewers');
  if (!rule) {
    return { ok: false, reason: 'no required_reviewers protection rule is configured' };
  }
  const reviewers = Array.isArray(rule.reviewers) ? rule.reviewers : [];
  if (reviewers.length === 0) {
    return {
      ok: false,
      reason: 'a required_reviewers rule exists but names zero reviewers',
    };
  }
  return { ok: true };
}

// ── Pure decision: a ruleset covering v*-style tags ─────────────────────────

/** Representative tag name a covering pattern must match. */
const SAMPLE_V_TAG = 'v1.0.0';

/**
 * Does one `conditions.ref_name.include` glob cover `v*`-style tags?
 * GitHub's ref_name globs use `*` as the only wildcard and an optional
 * `refs/tags/` (or `refs/heads/`) prefix; `~ALL` is GitHub's own "every ref of
 * this target type" literal. Anything else is matched by converting the glob
 * to an anchored regex and testing it against a representative tag — the same
 * approach the ruleset UI itself takes, without needing a real tag list.
 *
 * @param {unknown} pattern
 * @returns {boolean}
 */
export function matchesVStarGlob(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) return false;
  if (pattern === '~ALL') return true;
  const stripped = pattern.replace(/^refs\/(tags|heads)\//, '');
  if (stripped.length === 0) return false;
  const escaped = stripped.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(SAMPLE_V_TAG);
}

/**
 * Does one ruleset ACTUALLY protect v*-style tags — both halves of #1650
 * round 2 finding 3 (previously only `include` was checked):
 *
 *   - `conditions.ref_name.exclude` can carve v* back OUT of an `include` that
 *     otherwise covers it — a plausible "protect all tags except prereleases"
 *     config (e.g. `include: ['*']`, `exclude: ['v*-rc*']` would still cover
 *     `v1.0.0`, but `exclude: ['v*']` would not). Checking `include` alone was
 *     a false PASS on exactly the axis this module exists to verify.
 *   - `enforcement` must be `'active'`. GitHub's other two values are
 *     `'disabled'` (already filtered out by the caller's candidate list
 *     before this function ever sees it) and `'evaluate'` — a real,
 *     non-hypothetical dry-run mode that logs would-be violations but blocks
 *     nothing. An evaluate-only ruleset gives the exact false confidence
 *     #1638 exists to catch: something targeting v* tags EXISTS, but a
 *     force-push or tag deletion is not actually stopped.
 *
 * @param {{ enforcement?: unknown, conditions?: { ref_name?: { include?: unknown, exclude?: unknown } } }} ruleset
 *   one ruleset's FULL detail (`GET rulesets/{id}`), not the summary from the list
 * @returns {boolean}
 */
export function tagRulesetCoversVStar(ruleset) {
  if (ruleset?.enforcement !== 'active') return false;
  const includes = ruleset?.conditions?.ref_name?.include;
  if (!Array.isArray(includes)) return false;
  if (!includes.some((pattern) => matchesVStarGlob(pattern))) return false;
  const excludes = ruleset?.conditions?.ref_name?.exclude;
  if (Array.isArray(excludes) && excludes.some((pattern) => matchesVStarGlob(pattern))) {
    return false;
  }
  return true;
}

/**
 * @param {unknown} rulesetDetails array of FULL ruleset details (already
 *   filtered to `target === 'tag' && enforcement !== 'disabled'` by the caller
 *   — this function does not re-filter, so a fixture can exercise "zero
 *   candidates" vs "candidates that don't cover v*" independently)
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function evaluateTagRulesetProtection(rulesetDetails) {
  if (!Array.isArray(rulesetDetails)) {
    return { ok: false, reason: 'ruleset list was not an array' };
  }
  if (rulesetDetails.length === 0) {
    return { ok: false, reason: 'no enabled ruleset targets tags' };
  }
  const covering = rulesetDetails.filter((r) => tagRulesetCoversVStar(r));
  if (covering.length === 0) {
    return {
      ok: false,
      reason: 'a tag ruleset exists but none of its ref_name.include patterns cover v*-style tags',
    };
  }
  return { ok: true };
}

// ── Fetch layer ──────────────────────────────────────────────────────────────

/**
 * Default API transport, deliberately the same shape as
 * `scripts/verify-action-pins.mjs`'s `githubApi`: `{status, body}`, injectable,
 * authenticated with `GITHUB_TOKEN` when present.
 *
 * @param {string} path
 * @returns {Promise<{ status: number, body: unknown }>}
 */
export async function githubApi(path) {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'knext-check-npm-publish-drift',
    'x-github-api-version': '2022-11-28',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${GITHUB_API_BASE}${path}`, { headers });
  let body;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
}

/**
 * @param {{ owner: string, repo: string, environment: string, api: (path: string) => Promise<{status: number, body: unknown}> }} args
 * @returns {Promise<
 *   | { kind: 'ok' }
 *   | { kind: 'missing', reason: string }
 *   | { kind: 'permission-error', status: number, message: string }
 *   | { kind: 'api-error', status: number, message: string }
 * >}
 */
export async function fetchReviewerProtection({ owner, repo, environment, api }) {
  let res;
  try {
    res = await api(`repos/${owner}/${repo}/environments/${encodeURIComponent(environment)}`);
  } catch (error) {
    return {
      kind: 'api-error',
      status: 0,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (PERMISSION_ERROR_STATUSES.has(res.status)) {
    return {
      kind: 'permission-error',
      status: res.status,
      message:
        `GET environments/${environment} returned ${res.status}. This means EITHER the token ` +
        'lacks permission to read the environment (grant a fine-grained PAT/App the ' +
        '"Environments" repository permission, read-only, or verify the workflow\'s ' +
        '`environments: read` GITHUB_TOKEN permission actually covers this GET) OR the ' +
        'environment was renamed/deleted. Do NOT read this as "protection is empty" — it is not ' +
        'a verified answer either way.',
    };
  }
  if (res.status !== 200) {
    return {
      kind: 'api-error',
      status: res.status,
      message:
        typeof res.body === 'object' && res.body && 'message' in res.body
          ? String(/** @type {{message: unknown}} */ (res.body).message)
          : `unexpected status ${res.status}`,
    };
  }
  const evaluated = evaluateReviewerProtection(
    /** @type {{protection_rules?: unknown}} */ (res.body)?.protection_rules,
  );
  return evaluated.ok ? { kind: 'ok' } : { kind: 'missing', reason: evaluated.reason };
}

/**
 * @param {{ owner: string, repo: string, api: (path: string) => Promise<{status: number, body: unknown}> }} args
 * @returns {Promise<
 *   | { kind: 'ok' }
 *   | { kind: 'missing', reason: string }
 *   | { kind: 'permission-error', status: number, message: string }
 *   | { kind: 'api-error', status: number, message: string }
 * >}
 */
export async function fetchTagRulesetProtection({ owner, repo, api }) {
  let listRes;
  try {
    listRes = await api(`repos/${owner}/${repo}/rulesets`);
  } catch (error) {
    return {
      kind: 'api-error',
      status: 0,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (PERMISSION_ERROR_STATUSES.has(listRes.status)) {
    return {
      kind: 'permission-error',
      status: listRes.status,
      message:
        `GET rulesets returned ${listRes.status}. Repository rulesets need the "Administration" ` +
        'repository permission (read-only) — the default GITHUB_TOKEN has no dedicated ' +
        'permissions: key for this endpoint. If this fires on a real nightly run, add a ' +
        'fine-grained PAT with "Administration: Read-only" as a repo secret and wire it into ' +
        'this workflow in place of GITHUB_TOKEN. Do NOT read this as "no ruleset exists" — it is ' +
        'not a verified answer either way.',
    };
  }
  if (listRes.status !== 200) {
    return {
      kind: 'api-error',
      status: listRes.status,
      message:
        typeof listRes.body === 'object' && listRes.body && 'message' in listRes.body
          ? String(/** @type {{message: unknown}} */ (listRes.body).message)
          : `unexpected status ${listRes.status}`,
    };
  }

  const summaries = Array.isArray(listRes.body) ? listRes.body : [];
  const candidates = summaries.filter(
    (r) => r && r.target === 'tag' && r.enforcement !== 'disabled',
  );
  if (candidates.length === 0) {
    return { kind: 'missing', reason: 'no enabled ruleset targets tags' };
  }

  const details = [];
  for (const candidate of candidates) {
    let detailRes;
    try {
      detailRes = await api(`repos/${owner}/${repo}/rulesets/${candidate.id}`);
    } catch (error) {
      return {
        kind: 'api-error',
        status: 0,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (PERMISSION_ERROR_STATUSES.has(detailRes.status)) {
      return {
        kind: 'permission-error',
        status: detailRes.status,
        message:
          `GET rulesets/${candidate.id} returned ${detailRes.status} — cannot read this ` +
          "ruleset's conditions. See the rulesets-list permission note above; same fix applies.",
      };
    }
    if (detailRes.status !== 200) {
      return {
        kind: 'api-error',
        status: detailRes.status,
        message:
          typeof detailRes.body === 'object' && detailRes.body && 'message' in detailRes.body
            ? String(/** @type {{message: unknown}} */ (detailRes.body).message)
            : `unexpected status ${detailRes.status}`,
      };
    }
    details.push(detailRes.body);
  }

  const evaluated = evaluateTagRulesetProtection(details);
  return evaluated.ok ? { kind: 'ok' } : { kind: 'missing', reason: evaluated.reason };
}

/**
 * One human-readable finding for a setting that is not verified `ok`. Keeps
 * "could not verify" and "verified empty" in visibly different sentences —
 * the whole point of separating `permission-error` from `missing` above.
 */
function describeFinding(setting, result) {
  if (result.kind === 'missing') {
    return {
      setting,
      kind: 'missing',
      message: `${setting} is MISSING: ${result.reason}. This is real drift — see #1638 item 1 (founder-only repo settings change).`,
    };
  }
  if (result.kind === 'permission-error') {
    return {
      setting,
      kind: 'permission-error',
      message: `${setting}: UNVERIFIED (insufficient token permission) — ${result.message}`,
    };
  }
  return {
    setting,
    kind: 'api-error',
    message: `${setting}: UNVERIFIED (API error, status ${result.status}) — ${result.message}`,
  };
}

/**
 * @param {{ owner: string, repo: string, environment: string, api: (path: string) => Promise<{status: number, body: unknown}> }} args
 * @returns {Promise<{ ok: boolean, findings: Array<{setting: string, kind: string, message: string}>, reviewer: unknown, tagRuleset: unknown }>}
 */
export async function runDriftCheck({ owner, repo, environment, api }) {
  const [reviewer, tagRuleset] = await Promise.all([
    fetchReviewerProtection({ owner, repo, environment, api }),
    fetchTagRulesetProtection({ owner, repo, api }),
  ]);

  const findings = [];
  if (reviewer.kind !== 'ok') {
    findings.push(describeFinding(`npm-publish environment required reviewer`, reviewer));
  }
  if (tagRuleset.kind !== 'ok') {
    findings.push(describeFinding('v*-covering tag ruleset', tagRuleset));
  }

  return { ok: findings.length === 0, findings, reviewer, tagRuleset };
}

/**
 * Which workflow jobs can a pull request (or the merge queue) run, and do any of
 * them hold a registry-write, OIDC or attestation credential?
 *
 * Pure functions over a parsed workflow document, shared by
 * `tests/workflow-pr-token-scope.test.ts` and its mutation prover.
 *
 * CONSERVATIVE BY CONSTRUCTION. A job is treated as unreachable from a PR only
 * when its `if:` provably cannot be true on a PR event. Every expression shape
 * this model does not understand counts as REACHABLE, so a condition the model
 * cannot read produces a finding rather than a pass.
 */

/** Permission scopes that must never be writable on a PR-reachable job. */
export const FORBIDDEN_PR_GRANTS = ['packages', 'id-token', 'attestations'];

/** Events a pull request, or the merge queue acting for one, can raise. */
const PR_EVENTS = ['pull_request', 'pull_request_target', 'merge_group'];

/** A reusable workflow runs under whichever workflow calls it, which may be a PR one. */
const REACHABLE_TRIGGERS = [...PR_EVENTS, 'workflow_call'];

/**
 * The trigger names a workflow declares, from any of the three YAML spellings
 * (`on: x`, `on: [x, y]`, `on: {x: …}`). Throws when there is no `on:` block:
 * a workflow whose triggers cannot be read cannot be certified.
 *
 * @param {{on?: unknown, true?: unknown}} doc
 * @returns {string[]}
 */
export function triggersOf(doc) {
  // YAML 1.1 reads the bare key `on` as boolean `true`.
  const on = doc.on ?? doc.true;
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.map(String);
  if (on && typeof on === 'object') return Object.keys(on);
  throw new Error('workflow has no readable `on:` block');
}

/** @param {{on?: unknown}} doc */
export function isPullRequestReachable(doc) {
  return triggersOf(doc).some((t) => REACHABLE_TRIGGERS.includes(t));
}

/**
 * Split `expr` on a top-level operator, ignoring anything inside parentheses or
 * single-quoted strings.
 *
 * @param {string} expr
 * @param {'||'|'&&'} op
 * @returns {string[]}
 */
function splitTop(expr, op) {
  const parts = [];
  let depth = 0;
  let quote = false;
  let start = 0;
  for (let i = 0; i < expr.length; i += 1) {
    const c = expr[i];
    if (c === "'") quote = !quote;
    if (quote) continue;
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (depth === 0 && expr.startsWith(op, i)) {
      parts.push(expr.slice(start, i));
      start = i + op.length;
      i += op.length - 1;
    }
  }
  parts.push(expr.slice(start));
  return parts.map((p) => p.trim());
}

/** Strip a fully enclosing pair of parentheses, repeatedly. */
function unwrap(expr) {
  let e = expr.trim();
  while (e.startsWith('(') && e.endsWith(')')) {
    let depth = 0;
    let encloses = true;
    let quote = false;
    for (let i = 0; i < e.length; i += 1) {
      if (e[i] === "'") quote = !quote;
      if (quote) continue;
      if (e[i] === '(') depth += 1;
      else if (e[i] === ')') {
        depth -= 1;
        if (depth === 0 && i < e.length - 1) {
          encloses = false;
          break;
        }
      }
    }
    if (!encloses) break;
    e = e.slice(1, -1).trim();
  }
  return e;
}

const EVENT_EQ = /^github\.event_name\s*==\s*'([^']+)'$/;
const REF_EQ = /^github\.ref\s*==\s*'(refs\/(?:heads|tags)\/[^']+)'$/;

/**
 * An atom excludes PR events when it can only be true on some other event.
 * `github.event_name != 'pull_request'` is NOT such an atom: it admits
 * `merge_group`. `startsWith(github.ref, 'refs/heads/')` is not one either, the
 * merge queue's ref starts with it.
 */
function atomExcludesPr(atom) {
  const event = atom.match(EVENT_EQ);
  if (event) return !PR_EVENTS.includes(event[1]);
  const ref = atom.match(REF_EQ);
  // The merge queue's ref is `refs/heads/gh-readonly-queue/...`, so a literal
  // branch that is not under that prefix cannot equal it; a PR ref is
  // `refs/pull/N/merge`, which no branch or tag literal equals.
  if (ref) return !ref[1].startsWith('refs/heads/gh-readonly-queue/');
  return false;
}

/**
 * Does `expr` provably evaluate false on every PR and merge-queue event?
 * AND needs one excluding conjunct; OR needs every disjunct to exclude.
 *
 * @param {string | undefined} expr a job's `if:` (with or without `${{ }}`)
 * @returns {boolean}
 */
export function ifExcludesPullRequests(expr) {
  if (typeof expr !== 'string') return false;
  let e = expr.trim();
  const wrapped = e.match(/^\$\{\{([\s\S]*)\}\}$/);
  if (wrapped) e = wrapped[1].trim();
  if (!e) return false;
  return excludes(e);
}

function excludes(expr) {
  const e = unwrap(expr);
  const ors = splitTop(e, '||');
  if (ors.length > 1) return ors.every(excludes);
  const ands = splitTop(e, '&&');
  if (ands.length > 1) return ands.some(excludes);
  return atomExcludesPr(e);
}

/**
 * The forbidden write grants a `permissions:` value carries, as `scope: write`
 * strings, or `['write-all']`. An absent block grants none here: it inherits,
 * and the caller resolves inheritance.
 *
 * @param {unknown} permissions
 * @returns {string[]}
 */
export function grantsOf(permissions) {
  if (permissions === 'write-all') return ['write-all'];
  if (!permissions || typeof permissions !== 'object') return [];
  const map = /** @type {Record<string, unknown>} */ (permissions);
  return FORBIDDEN_PR_GRANTS.filter((scope) => map[scope] === 'write').map(
    (scope) => `${scope}: write`,
  );
}

/**
 * Every job a PR can run that holds a forbidden grant. A job-level
 * `permissions:` REPLACES the workflow-level block; absent, it inherits it.
 *
 * @param {{on?: unknown, permissions?: unknown, jobs?: Record<string, Record<string, unknown>>}} doc
 * @returns {Array<{job: string, grants: string[]}>}
 */
export function findPrReachableWriteGrants(doc) {
  if (!isPullRequestReachable(doc)) return [];
  const hits = [];
  for (const [job, def] of Object.entries(doc.jobs ?? {})) {
    if (ifExcludesPullRequests(/** @type {string | undefined} */ (def.if))) continue;
    const effective = def.permissions !== undefined ? def.permissions : doc.permissions;
    const grants = grantsOf(effective);
    if (grants.length > 0) hits.push({ job, grants });
  }
  return hits;
}

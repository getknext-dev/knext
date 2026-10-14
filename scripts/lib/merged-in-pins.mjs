/**
 * Merged-in markers (#2342) — the shared half of the rule #2325 added to the
 * credential freeze guard: a reviewed bump marker that reaches a PR through a
 * MERGED-IN branch is not that PR's own, and exempts nothing.
 *
 * WHY. Both freeze guards honour a marker only when the PR introduced it, and
 * both measured "introduced" against the merge base alone (#1635). A merge PR
 * (integration/v2 -> main, or a feature branch that merged integration/v2) has
 * a merge base older than the other branch's marker, so that marker read as
 * introduced and exempted the PR on a branch it was never reviewed for.
 *
 * WHAT. `collectMergedInPins` reads the pin at every MERGED-IN parent — each
 * non-first parent of each merge commit in merge-base..head — and returns the
 * distinct markers found under `field`. `markerArrivedViaMerge` says whether
 * a head marker matches one of them by `date` + `reason`, the identity #1635
 * already uses against the merge base (`expires`/`paths` changes are not a new
 * authorization). The caller decides what an inherited marker means.
 *
 * merge_group: the queue's own merge commits sit on HEAD's first-parent chain
 * back to BASE, and their second parents ARE the queued PR heads — the commits
 * under test, not a merged-in branch — so they are skipped. Merges inside each
 * queued PR are still read. A squash or rebase queue leaves no merge commit,
 * so the merge-base rule alone applies there; the `pull_request` run on the PR
 * itself already applied this one.
 *
 * Limit, stated: only markers that reached the merged-in branch THROUGH A
 * MERGE COMMIT are seen. One that landed on it by squash, rebase or direct
 * push is part of that branch's first-parent history and still reads as
 * introduced by a PR that merges the branch.
 *
 * Dependency-free (node builtins only) on purpose: the published-bytes check
 * keeps its decision path free of the credential guard's heavy import chain
 * (see `scripts/lib/published-bytes-freeze-check.mjs`'s header), and this
 * module must not add one. The credential freeze guard still carries its own
 * inline copy of the collection in its workflow (#2325); moving it here is
 * tracked in #2370 rather than done in the same change.
 */

/**
 * @param {unknown} pin
 * @param {string} field
 * @returns {Record<string, unknown> | undefined} the marker object, if any
 */
export function markerAt(pin, field) {
  const m = pin && typeof pin === 'object' ? /** @type {any} */ (pin)[field] : undefined;
  return m && typeof m === 'object' && !Array.isArray(m) ? m : undefined;
}

/**
 * Are two markers the same reviewed authorization? Same `date` and `reason`;
 * `expires` and `paths` do not change who authorized what (#1635).
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function sameAuthorization(a, b) {
  if (!a || typeof a !== 'object' || !b || typeof b !== 'object') return false;
  const x = /** @type {any} */ (a);
  const y = /** @type {any} */ (b);
  return x.date === y.date && x.reason === y.reason;
}

/**
 * Did the head pin's `field` marker arrive through a merged-in branch? True
 * when any pin in `inheritedPins` carries the same authorization under the
 * same `field`.
 *
 * @param {unknown} headPin
 * @param {readonly unknown[]} inheritedPins
 * @param {string} field
 * @returns {boolean}
 */
export function markerArrivedViaMerge(headPin, inheritedPins, field) {
  const head = markerAt(headPin, field);
  if (!head) return false;
  return inheritedPins.some((pin) => sameAuthorization(markerAt(pin, field), head));
}

/**
 * The distinct `field` markers at every merged-in parent in the PR's range,
 * each wrapped as `{ [field]: marker }` (the shape of a pin). Any git failure
 * other than "no pin at that parent" throws, so a caller fails closed.
 *
 * `git` is injected (`scripts/collect-merged-in-pins.mjs` supplies the real
 * one): helpers under `scripts/lib/` spawn nothing themselves.
 *
 * @param {object} opts
 * @param {(...args: string[]) => string} opts.git runs `git <args>` in the
 *   repository and returns stdout; throws on a non-zero exit
 * @param {string} opts.baseSha the PR base (or the merge group's base)
 * @param {string} opts.headSha the PR head (or the merge group's head)
 * @param {string} [opts.eventName] `merge_group` skips the queue's own merges
 * @param {string} opts.pinFile the pin file path read at each parent
 * @param {string} opts.field the marker field to collect
 * @param {(msg: string) => void} [opts.log]
 * @returns {Array<Record<string, unknown>>}
 */
export function collectMergedInPins({
  git,
  baseSha,
  headSha,
  eventName,
  pinFile,
  field,
  log = console.log,
}) {
  const lines = (s) => s.split('\n').filter(Boolean);
  const mergeBase = git('merge-base', baseSha, headSha).trim();
  const queueMerges = new Set(
    eventName === 'merge_group'
      ? lines(git('rev-list', '--first-parent', '--merges', `${baseSha}..${headSha}`))
      : [],
  );
  const seen = new Set();
  const pins = [];
  for (const line of lines(git('rev-list', '--merges', '--parents', `${mergeBase}..${headSha}`))) {
    const [merge, , ...mergedIn] = line.split(' ');
    if (queueMerges.has(merge)) continue;
    for (const parent of mergedIn) {
      // No pin at that parent = nothing to inherit.
      if (git('ls-tree', '--name-only', parent, '--', pinFile).trim() !== pinFile) continue;
      const text = git('show', `${parent}:${pinFile}`);
      let pin;
      try {
        pin = JSON.parse(text);
      } catch {
        log(`unparsable pin at merged-in parent ${parent} - no marker read from it`);
        continue;
      }
      const marker = markerAt(pin, field);
      if (!marker) continue;
      const key = JSON.stringify(marker);
      if (seen.has(key)) continue;
      seen.add(key);
      pins.push({ [field]: marker });
      log(`merged-in parent ${parent} (merge ${merge}) carries a ${field}`);
    }
  }
  return pins;
}

/**
 * Pure core for the retracted-figure boundary check (#545, #710).
 *
 * WHY THIS EXISTS
 * ---------------
 * Over three review rounds, the same defect reproduced FOUR times: a figure is
 * corrected in one place and the correction does not reach the other copies.
 * Rounds 1 and 2 chased it inside the repo. Round 3 found it had reproduced one
 * hop outside — four retracted figures still live on the GitHub issues the
 * release documents point readers to, while those documents assert the issues
 * "carry the corrected findings".
 *
 * Four instances of one shape is not four mistakes; it is evidence that a
 * per-instance fix is the wrong shape. This is the gate.
 *
 * WHAT IS AND IS NOT TRACTABLE — measured, not assumed
 * ----------------------------------------------------
 * Round 3 measured the general form and it does NOT work: a fuzzy referee that
 * asks "do these two prose sources state the same number about the same
 * subject" never exceeded ~50% precision at any subject-overlap threshold,
 * because the corpus legitimately states different numbers about
 * vocabulary-adjacent subjects (778 node vs 775 bun; 16 shards vs 08-03's 15).
 * A gate with that false-positive rate gets edited to green, which
 * `security.md` names as the failure mode where editing the guard becomes the
 * routine way to pass. That check is correctly NOT built.
 *
 * This is the narrow, exact-match subset, and it is a different question:
 * **does a figure this repo has already RETRACTED still stand uncorrected on an
 * issue the docs cite?** That has a crisp answer, no similarity threshold, and
 * no judgement. It is the question the defect class actually poses.
 *
 * NOT A HAND-MAINTAINED LIST IN THE CHECK
 * ---------------------------------------
 * `.claude/rules/workflow.md`: "Prefer scanning to enumerating. An enumerated
 * list of call sites is how the second one gets missed." So:
 *   - the ISSUES are discovered by scanning the cited documents, never listed;
 *   - the RETRACTIONS live in a ledger file that is part of making a retraction,
 *     mirroring the `$knextQuarantines` pattern this repo already uses.
 * The residual — a retraction whose author never adds a ledger entry — is real
 * and is stated in the ledger's own README field rather than hidden.
 *
 * THE SELF-REFERENCE TRAP
 * -----------------------
 * A comment that CORRECTS a retracted figure must quote it to be intelligible.
 * A naive scan flags those correcting comments as offenders — the same trap the
 * transform-cache guard solves by assembling its marker at runtime. Here the
 * rule is explicit: a source carrying the correction marker is a CORRECTION and
 * may quote freely; it is also what discharges the figure it quotes.
 */

/**
 * Normalise text for exact matching.
 *
 * Markdown emphasis is noise here: the same claim appears as
 * `778/0 on **28 of 28** ledgered nights` on one issue and
 * `28 of 28 ledgered nights at 778/0/0` on another. Stripping emphasis and
 * collapsing whitespace makes one pattern match both without loosening the
 * match into a fuzzy one.
 *
 * BLOCKQUOTE AND LIST MARKERS ARE STRIPPED TOO, and that is not cosmetic — it
 * was a real false negative. A correcting comment quotes the wrong figure in a
 * `>` blockquote, and GitHub wraps long quoted lines, so the quoted sentence
 * arrives as `at exactly\n>    timeoutMs: 60000`. Collapsing whitespace alone
 * leaves `at exactly > timeoutms: 60000`, the pattern misses, and the gate
 * reports a figure as uncorrected when the correction is sitting right there.
 * Found by running this check against the real issues, not by inspection.
 */
export function normalize(text) {
  return (
    String(text ?? '')
      .replace(/^[ \t]*(?:>[ \t]*)+/gm, '') // blockquote markers, possibly nested
      .replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/gm, '') // list markers
      // HTML tags and entities. GitHub RENDERS HTML in issue bodies, so
      // `churn was <b>9</b> restarts` and `9&nbsp;restarts` read identically to
      // the plain form on screen while evading a text match. That makes this a
      // CARELESSNESS path, not only an adversarial one — anyone pasting
      // HTML-formatted content republishes the figure invisibly.
      .replace(/<[^>\n]{0,200}>/g, '')
      .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
      .replace(/&amp;/gi, '&')
      // Zero-width characters are not in JS `\s`, so they survive whitespace
      // collapsing and split a pattern invisibly.
      .replace(/[​-‍﻿]/g, '')
      // Compatibility fold: NFKC maps fullwidth digits (９ → 9) and other
      // presentation forms onto their plain equivalents. Non-breaking spaces
      // become ordinary ones here too, before whitespace collapsing.
      .normalize('NFKC')
      .replace(/[*_`~]/g, '')
      .replace(/\s+/g, ' ')
      .toLowerCase()
      .trim()
  );
}

/**
 * Every issue cited by a document — SCANNED, never enumerated.
 *
 * Returns `{owner, repo, number}`, with `owner`/`repo` **null** meaning "the
 * default repository". Carrying the owner and repo is not decoration: an
 * earlier version captured only the NUMBER out of a
 * `github.com/OWNER/REPO/issues/N` URL and threw the rest away, so the resolver
 * fetched `repos/<default>/issues/N` — checking an **unrelated same-repo issue**
 * that happens to share a number, while the real target was never scanned. That
 * is worse than not supporting cross-repo citations at all, because it reports
 * a confident verdict about the wrong subject.
 *
 * Three citation forms, because all three appear in practice:
 *   - `#123`                     → default repo
 *   - `owner/repo#123`           → that repo (the standard GitHub shorthand,
 *                                  which the bare `#` lookbehind excluded)
 *   - `github.com/owner/repo/issues/123` (or `/pull/123`) → that repo
 */
export function citedIssues(docText) {
  const text = String(docText ?? '');
  const byKey = new Map();
  const add = (owner, repo, number) => {
    const key = `${owner ?? ''}/${repo ?? ''}#${number}`;
    if (!byKey.has(key)) byKey.set(key, { owner: owner ?? null, repo: repo ?? null, number });
  };

  // Full URLs first: most specific, and they must not be re-matched as bare
  // `#N` later (they contain no `#`, so that is automatic, but order documents
  // the intent).
  for (const m of text.matchAll(/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d{1,6})/g)) {
    add(m[1], m[2], Number(m[3]));
  }
  // `owner/repo#N` shorthand.
  for (const m of text.matchAll(/(?<![\w/.-])([\w.-]+)\/([\w.-]+)#(\d{1,6})\b/g)) {
    add(m[1], m[2], Number(m[3]));
  }
  // Bare `#N`, default repo. The lookbehind keeps it off `owner/repo#N` (handled
  // above) and off colour literals like `#fff`.
  for (const m of text.matchAll(/(?<![\w/.-])#(\d{1,6})\b/g)) add(null, null, Number(m[1]));

  return [...byKey.values()].sort(
    (a, b) =>
      String(a.owner ?? '').localeCompare(String(b.owner ?? '')) ||
      String(a.repo ?? '').localeCompare(String(b.repo ?? '')) ||
      a.number - b.number,
  );
}

/**
 * Assemble every scannable source for one citation from already-fetched payloads.
 *
 * Pure on purpose. The fetching lives in `verify-retracted-figures.mjs`, but the
 * DECISION about which surfaces count belongs here, where it can be unit-tested
 * offline and mutated. An earlier version assembled sources inline in the
 * resolver, which made the pull-request branch untestable — and untestable
 * branches are exactly what rots without anyone noticing.
 *
 * A cited PULL REQUEST carries two surfaces `issues/N/comments` does not: review
 * bodies and inline review comments. #846 — the PR this work posted a correction
 * on — is that shape, so a retracted figure in a review body on a cited PR would
 * have gone unseen, and nothing said so.
 *
 * @param {string} label human-readable citation label, e.g. `#846`
 * @param {{body?: string, pull_request?: unknown}} issue
 * @param {Array<{id: number|string, body?: string}>} comments
 * @param {Array<{id: number|string, body?: string}>} [reviews]
 * @param {Array<{id: number|string, body?: string}>} [reviewComments]
 */
export function assembleSources(label, issue, comments, reviews = [], reviewComments = []) {
  const sources = [
    { ref: `${label} body`, body: issue?.body ?? '' },
    ...comments.map((c) => ({ ref: `${label} comment ${c.id}`, body: c.body ?? '' })),
  ];
  if (issue?.pull_request) {
    sources.push(
      ...reviews.map((r) => ({ ref: `${label} review ${r.id}`, body: r.body ?? '' })),
      ...reviewComments.map((c) => ({
        ref: `${label} review comment ${c.id}`,
        body: c.body ?? '',
      })),
    );
  }
  return sources;
}

/**
 * Does this source CORRECT the given figure?
 *
 * A correction quotes the wrong value **and** states the right one. Both halves
 * are required, and requiring both is what makes this rule principled rather
 * than tunable:
 *
 *   - quoting alone is just republishing the error;
 *   - asserting the right value alone does not reach a reader who lands on the
 *     comment carrying the wrong one — which is exactly how #545 came to have a
 *     correct comment 6 sitting under an uncorrected comment 5.
 *
 * An earlier version of this function keyed off a heading marker (`## Correction`)
 * instead. It was wrong in both directions when run against the real issues: it
 * would have exempted any source that merely wore the heading, and it flagged
 * #850's body — which reconciles "a prior analysis put this at 9 restarts" with
 * its own 10 in plain prose — as an offender. Keying off the CLAIM rather than a
 * label fixes both, and cannot be satisfied by relabelling.
 */
export function correctsFigure(sourceBody, figure) {
  if (matchesFigure(sourceBody, figure).length === 0) return false;
  const hay = normalize(sourceBody);
  return hay.includes(normalize(figure.correctionSignature));
}

/**
 * Which of a figure's surface forms appear in this text?
 *
 * A figure carries several `patterns` because one claim gets written several
 * ways. Any one matching is the figure appearing.
 */
export function matchesFigure(text, figure) {
  const hay = normalize(text);
  return figure.patterns.filter((p) => hay.includes(normalize(p)));
}

/**
 * The core verdict.
 *
 * @param {Array<{ref: string, body: string, createdAt?: string}>} sources
 *   Every source attached to one issue — its body plus every comment.
 * @param {Array<{id: string, patterns: string[], correctionSignature: string, correct?: string}>} ledger
 *   `correct` is prose for the CLI's failure report and is deliberately OPTIONAL
 *   here: the decision logic must not depend on it, so that a ledger entry with
 *   a missing description still gets checked rather than silently skipped.
 * @returns {Array<{figure: string, ref: string, matched: string}>} offences
 *
 * A figure is an OFFENCE when it appears in a non-correction source and NO
 * correction source on the same issue quotes it. Quoting it in a correction is
 * precisely how a correction discharges it, so the two halves are the same
 * mechanism seen from both sides.
 */
export function findUncorrected(sources, ledger) {
  const offences = [];
  for (const figure of ledger) {
    // Discharged anywhere on this issue discharges it for the issue: a reader
    // who lands on the wrong comment can follow the thread to the correction.
    if (sources.some((s) => correctsFigure(s.body, figure))) continue;
    for (const s of sources) {
      const matched = matchesFigure(s.body, figure);
      if (matched.length > 0) {
        offences.push({ figure: figure.id, ref: s.ref, matched: matched[0] });
      }
    }
  }
  return offences;
}

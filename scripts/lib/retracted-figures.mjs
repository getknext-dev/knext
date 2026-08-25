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
  return String(text ?? '')
    .replace(/^[ \t]*(?:>[ \t]*)+/gm, '') // blockquote markers, possibly nested
    .replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/gm, '') // list markers
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

/**
 * Every issue number cited by a document — SCANNED, never enumerated.
 *
 * Matches both `#123` and full GitHub issue/PR URLs, so a document that links
 * rather than hash-references is still covered.
 */
export function citedIssues(docText) {
  const found = new Set();
  const text = String(docText ?? '');
  for (const m of text.matchAll(/(?<![\w/])#(\d{1,6})\b/g)) found.add(Number(m[1]));
  for (const m of text.matchAll(/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/(\d{1,6})/g)) {
    found.add(Number(m[1]));
  }
  return [...found].sort((a, b) => a - b);
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

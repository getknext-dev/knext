/**
 * Where a shell COMMAND can begin — the single source of truth (#700 round 9).
 *
 * WHY THIS IS A MODULE AND NOT A REGEX LITERAL
 * --------------------------------------------
 * The compat fail-on-red gate's escape scan tells a shell `exit` from
 * `process.exit(1)` by POSITION: the latter is preceded by a `.`, which is not a
 * command position. That rule is what makes the scan independent of quoting.
 *
 * It is also the third thing on this axis to regress. The escape scan has now
 * been wrong three times in three consecutive rounds, and the last one was a
 * character class that happened to list `(` but not `)` or `{`:
 *
 *     case "${KNEXT_RUNTIME}" in bun) exit 0 ;; esac      invisible
 *     [ … ] && { exit 0; }                                invisible
 *     skip() { exit 0; }                                  invisible
 *     [ … ] && { echo skip; exit 0; }                     CAUGHT (the `;` did it)
 *
 * All three were caught by BOTH predecessors, so the head commit was a net
 * coverage loss — and the fourth line is the tell that the gap was accidental
 * rather than scoped.
 *
 * A 53-row mutation table ran green through all of it, because every `ESCAPE —`
 * row enumerated a spelling from ONE syntactic family (`if`, one-line `if`,
 * bare `exit`, `elif`). `.claude/rules/workflow.md`: *prefer scanning to
 * enumerating; an enumerated list of call sites is how the second one gets
 * missed.* That rule is usually applied to call sites. Here it applies to the
 * MUTATION TABLE, which is the thing that was supposed to be catching this.
 *
 * So the tokens and the hatch shapes that exercise them live together, in one
 * place, and `tests/compat-suite-workflow.test.ts` asserts every token is either
 * exercised by a shape or carries a written reason why it cannot be. Adding a
 * token without a hatch now REDS instead of silently widening the match.
 */

/**
 * Characters after which a command can begin.
 *
 * `}` and `(` are listed but deliberately unexercised — see UNEXERCISED_TOKENS.
 * Over-matching here is fail-closed (a spurious finding a human resolves);
 * under-matching is fail-open and silent, which is what kept happening.
 */
export const COMMAND_POSITION_CHARS = Object.freeze([';', '&', '|', '(', ')', '{', '}']);

/** Keywords after which a command can begin. */
export const COMMAND_POSITION_KEYWORDS = Object.freeze(['then', 'else', 'do']);

/**
 * Tokens with no hatch shape, and why. An entry here is a written exemption, not
 * an oversight — the coverage guard reds on any token that is in neither list.
 */
export const UNEXERCISED_TOKENS = Object.freeze({
  '(': 'a command immediately after `(` runs in a SUBSHELL, so an `exit` there terminates the subshell rather than the step — it is real command position but no hatch built on it actually disarms the gate. Kept as match surface because over-matching is fail-closed.',
  '}': 'no valid POSIX shell places a command immediately after `}` without an intervening separator, so there is no hatch to write. Kept for the same fail-closed reason.',
});

const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

/** The `(?:…)\s*` prefix that anchors a match to a command position. */
export function commandPositionPrefix() {
  const chars = COMMAND_POSITION_CHARS.map((c) => c.replace(ESCAPE_RE, '\\$&')).join('');
  const words = COMMAND_POSITION_KEYWORDS.map((w) => `\\b${w}\\b`).join('|');
  return `(?:^|[${chars}]|${words})\\s*`;
}

/** The lane condition every hatch is gated on — the live disarm, not a fiction. */
const LANE = '[ "${KNEXT_RUNTIME:-node}" = "bun" ]';

/**
 * One hatch shape per command-position token: real shell that skips the gate on
 * the Bun lane, with `exit` sitting in exactly that position.
 *
 * `token` is what ties a shape to the regex. The prover turns each entry into a
 * mutation row, so a shape added here is proved without anyone writing a row,
 * and a token added to the class without a shape reds the coverage guard.
 */
export const HATCH_SHAPES = Object.freeze([
  {
    token: '^',
    label: 'a multi-line `if` — `exit 0` at line start',
    snippet: `          if ${LANE}; then\n            exit 0\n          fi\n`,
  },
  {
    token: '^',
    label: 'a BARE `exit` (no status argument at all)',
    snippet: `          if ${LANE}; then\n            exit\n          fi\n`,
  },
  {
    token: 'then',
    label: 'a one-line `if …; then exit 0; fi`',
    snippet: `          if ${LANE}; then exit 0; fi\n`,
  },
  {
    token: ';',
    label: 'a `;`-separated group — `{ echo skip; exit 0; }`',
    snippet: `          ${LANE} && { echo skip; exit 0; }\n`,
  },
  {
    token: '&',
    label: 'an `&&` short-circuit',
    snippet: `          ${LANE} && exit 0\n`,
  },
  {
    token: '|',
    label: 'an `||` short-circuit on the negated test',
    snippet: `          [ "\${KNEXT_RUNTIME:-node}" != "bun" ] || exit 0\n`,
  },
  {
    token: ')',
    label: 'a `case` arm — the shape a lane switch is most naturally written as',
    snippet: `          case "\${KNEXT_RUNTIME:-node}" in bun) exit 0 ;; esac\n`,
  },
  {
    token: '{',
    label: 'a brace GROUP with no other separator — `&& { exit 0; }`',
    snippet: `          ${LANE} && { exit 0; }\n`,
  },
  {
    token: '{',
    label: 'a FUNCTION body — `skip() { exit 0; }`',
    snippet: `          skip() { exit 0; }\n          ${LANE} && skip\n`,
  },
  {
    token: 'else',
    label: 'the ELSE arm of a negated lane test',
    snippet: `          if [ "\${KNEXT_RUNTIME:-node}" != "bun" ]; then :; else exit 0; fi\n`,
  },
  {
    token: 'do',
    label: 'a `for … do` body',
    snippet: `          if ${LANE}; then\n            for _ in 1; do exit 0; done\n          fi\n`,
  },
]);

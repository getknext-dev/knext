/**
 * `scripts/bun-test.mjs --no-skip`: why a file must FAIL because a test in it
 * did not run, or null if it may pass.
 *
 * `bun test` exits 0 when a test is `it.todo`, `it.skip`, `it.skipIf(true)` or
 * `it.if(false)` — the file reads "ok" while the test it names never ran. For a
 * suite whose every test is load-bearing (the docker e2e gates, where one
 * disabled leg is the whole proof gone) that is a silent pass. Measured on bun
 * 1.4.2: a file with one `it.todo` and one `it.if(false)` prints `1 skip` /
 * `1 todo` / `0 fail` and exits 0.
 *
 * So this reads bun's own summary lines (` 3 pass`, ` 1 skip`, ` 1 todo`,
 * ` 0 fail`) and reports a non-zero skip or todo count — and ALSO a missing
 * `N pass` line, because "could not tell" is not evidence that nothing was
 * skipped.
 *
 * @param {string} output the child's combined stdout + stderr
 * @returns {string | null}
 */
export function skipViolation(output) {
  const counts = {};
  for (const m of output.matchAll(/^\s*(\d+) (pass|fail|skip|todo)\b/gm)) {
    counts[m[2]] = (counts[m[2]] ?? 0) + Number(m[1]);
  }
  if (counts.pass === undefined) {
    return '--no-skip: no `N pass` summary line in the bun output, so it cannot be shown that nothing was skipped';
  }
  const skipped = (counts.skip ?? 0) + (counts.todo ?? 0);
  if (skipped > 0) {
    return `--no-skip: ${counts.skip ?? 0} skipped + ${counts.todo ?? 0} todo test(s) — every test in this file must run`;
  }
  return null;
}

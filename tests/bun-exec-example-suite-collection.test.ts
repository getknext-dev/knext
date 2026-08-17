import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `tests/bun-exec-hardcap-ci.test.ts:55` proves the CI job RUNS `bun run test`
 * in `examples/bun-exec`. On its own that is half a scan — the other half is
 * whether the suite that command runs still COLLECTS the guards inside it.
 *
 * The realistic regression is not deleting a test; it is adding one line to
 * `vitest.config.ts`'s `exclude`. `bun run test` keeps exiting 0, the CI guard
 * keeps passing, and the excluded guard silently stops guarding — which is the
 * failure mode `.claude/rules/workflow.md` calls decoration. It has a live
 * precedent in this very config: `*.docker-e2e.test.ts` is excluded here for a
 * good reason (it builds a ~100 MB binary), and that legitimate exclusion is
 * exactly the shape an illegitimate one would take.
 *
 * So this ALLOWLISTS the excludes rather than enumerating the test files. A new
 * guard added to `examples/bun-exec/test/` is covered the moment it exists, with
 * no edit here; a new exclusion cannot land without justifying itself.
 */

const CONFIG = resolve(
  import.meta.dirname ?? new URL('.', import.meta.url).pathname,
  '../examples/bun-exec/vitest.config.ts',
);

// Every exclusion that may legitimately hide a file from `bun run test`, each
// with the reason it is allowed. Anything else reds, deliberately.
const ALLOWED_EXCLUDES = new Map([
  [
    '**/*.docker-e2e.test.ts',
    'compiles a ~100 MB binary and builds a container; has its own CI job (bun-exec-alpine-image), ' +
      'whose existence is asserted by tests/bun-exec-alpine-image-ci.test.ts',
  ],
  ['**/node_modules/**', 'dependencies are not this suite'],
]);

function parseArray(source: string, key: 'include' | 'exclude'): string[] {
  // The config is hand-written and tiny, so a literal read is honest here — and
  // importing it would execute a vitest config inside vitest.
  const m = source.match(new RegExp(`${key}\\s*:\\s*\\[([\\s\\S]*?)\\]`));
  expect(
    m,
    `vitest.config.ts has no \`${key}\` array — this guard cannot evaluate its subject`,
  ).not.toBeNull();
  return [...(m as RegExpMatchArray)[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
}

describe("examples/bun-exec's fast suite still collects its guards", () => {
  it('excludes nothing beyond the justified allowlist', () => {
    const source = readFileSync(CONFIG, 'utf8');
    for (const pattern of parseArray(source, 'exclude')) {
      expect(
        ALLOWED_EXCLUDES.has(pattern),
        `\`${pattern}\` is excluded from examples/bun-exec's \`bun run test\` and is NOT in this ` +
          "guard's allowlist. `bun run test` will still exit 0 and the CI job guard will still " +
          'pass, so nothing else notices that whatever it matches stopped running. If the ' +
          'exclusion is legitimate, add it to ALLOWED_EXCLUDES here WITH its reason and give it ' +
          'its own CI job — that is what *.docker-e2e.test.ts did.',
      ).toBe(true);
    }
  });

  it('includes the whole test directory, so a new guard needs no edit here', () => {
    const source = readFileSync(CONFIG, 'utf8');
    const include = parseArray(source, 'include');
    // Narrowing `include` is the other way to orphan a guard, and it leaves the
    // exclude list untouched — so the assertion above cannot see it.
    expect(
      include,
      'the fast suite no longer includes all of `test/**/*.test.ts`. Narrowing `include` orphans ' +
        'guards just as effectively as excluding them, and leaves the exclude allowlist clean.',
    ).toContain('test/**/*.test.ts');
  });
});

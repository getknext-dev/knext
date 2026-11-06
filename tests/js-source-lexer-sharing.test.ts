/**
 * The source-text guards share ONE comment/string lexer
 * (`packages/kn-next/src/adapters/js-source-lexer.mjs`).
 *
 * Six guards used to carry their own lexer and they disagreed on what a template
 * body, an escaped quote, or a comment gap looks like. This pins the migration: each
 * migrated call site imports the shared lexer and does not grow a hand-rolled
 * comment scanner back. A hand-rolled scanner is recognised by its hallmarks (a
 * `function stripComments` / `maskStringLiterals` definition, or a search for the
 * block-comment terminator), so the check SCANS the source instead of listing
 * call sites by hand.
 *
 * Documented exceptions (not JS lexers, so they do not use this module):
 *   - scripts/lib/crane-pin.mjs `stripFullLineComments`: strips bash `#` comment
 *     lines inside a workflow `run:` block (a shell/YAML concern, not JS).
 *   - scripts/adapter-import-closure.mjs: a tokenizer that needs tokens, not a
 *     stripped string.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const LEXER = 'packages/kn-next/src/adapters/js-source-lexer.mjs';

const MIGRATED = [
  'scripts/check-escalation-triggers.mjs',
  'scripts/workflow-script-install-guard.mjs',
  'scripts/lib/prover-anchor-scan.mjs',
  'packages/kn-next/src/adapters/computed-require-scan.mjs',
  'packages/kn-next/src/cli/static-export-guard.ts',
  'packages/kn-next/src/cli/doctor/checks/use-cache.ts',
  'packages/kn-next/src/cli/tracing-root.ts',
  'packages/kn-next/src/__tests__/boot-trace-wiring.test.ts',
  'packages/kn-next/src/__tests__/cr-apply-strict-validation.test.ts',
  'packages/kn-next/src/__tests__/kube-context-scan.test.ts',
  'packages/kn-next/src/__tests__/node-server-log-after-spawn.test.ts',
  'packages/kn-next/src/__tests__/visibility-guard-coverage-scan.test.ts',
  'tests/e2e-ephemeral-ports.test.ts',
];

const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

/** Block-comment terminator search: the hallmark of a hand-rolled comment scanner. */
const HAND_ROLLED_COMMENT_SCAN = /indexOf\(\s*(['"])\*\/\1/;
const OWN_STRIP_DEFINITION = /function\s+stripComments\s*\(/;
/**
 * A regex-literal comment stripper: a `replace`/`match`/`split` call whose regex
 * literal is comment-shaped, i.e. either
 *   - block form: `\/\*` followed later by `\*\/`, or by the classic
 *     `\*+ ... \/` tail (`/\/\*[^*]*\*+([^/*][^*]*\*+)*\//g`); or
 *   - line form: `\/\/` (optionally `\s*`, optionally a capture group) followed by
 *     `.*` / `.+` / `.*?` anchored to the end of the regex (or `$`, or `\n`), or by
 *     a negated class excluding `\n`/`\r` (`[^\n]*`, `[^\r\n]*`).
 * A `\/\/` followed by more pattern is a URL/path, not a comment:
 * `/https?:\/\//`, `/^\/\/cdn/`, `/https:\/\/.*\.example/`, `/\/\/.+\.com/`.
 * The `indexOf('*\/')` hallmark above cannot see these.
 *
 * Not covered (known evasions of this tripwire): `new RegExp('...')` built from
 * strings, a regex held in a const and passed by name, and character-class
 * spellings such as `/[/][*]/`. The real-tree scan below covers only the MIGRATED
 * files; the shared-lexer import test is the real gate.
 */
const RE_BODY = String.raw`(?:[^/\n\\\[]|\\.|\[(?:[^\]\\\n]|\\.)*\])`;
const RE_BLOCK = String.raw`\\\/\\\*${RE_BODY}*?\\\*(?:\\\/|\+${RE_BODY}*?\\\/)`;
const RE_ANY = String.raw`\.[*+]\??`;
const RE_NEG_NL = String.raw`\[\^(?:[^\]\\\n]|\\.)*\\[nr](?:[^\]\\\n]|\\.)*\]\*`;
const RE_LINE = String.raw`\\\/\\\/(?:\\s\*)?\(?(?:${RE_ANY}(?=\)?(?:\$|\\n)?\/)|${RE_NEG_NL})`;
const REGEX_COMMENT_STRIPPER = new RegExp(
  String.raw`\.(?:replace(?:All)?|match(?:All)?|split)\(\s*\/${RE_BODY}*?(?:${RE_BLOCK}|${RE_LINE})`,
);
const SHARED_IMPORT =
  /import\s*\{[^}]*\bstripComments\b[^}]*\}\s*from\s*(['"])[^'"]*js-source-lexer\.mjs\1/;

describe('shared js-source-lexer: call-site migration', () => {
  it('the lexer module itself exists and owns the comment scanner', () => {
    expect(read(LEXER)).toMatch(HAND_ROLLED_COMMENT_SCAN);
  });

  for (const rel of MIGRATED) {
    it(`${rel} imports the shared lexer`, () => {
      expect(read(rel)).toMatch(SHARED_IMPORT);
    });

    it(`${rel} has no hand-rolled comment scanner of its own`, () => {
      const src = read(rel);
      expect(src).not.toMatch(HAND_ROLLED_COMMENT_SCAN);
      expect(src).not.toMatch(OWN_STRIP_DEFINITION);
    });

    it(`${rel} has no regex-literal comment stripper`, () => {
      expect(read(rel)).not.toMatch(REGEX_COMMENT_STRIPPER);
    });
  }
});

describe('regex comment stripper detector (both halves)', () => {
  const bad = [
    'const t = s.replace(/\\/\\*[\\s\\S]*?\\*\\//g, "");',
    'const t = s.replace(/\\/\\/.*$/gm, "");',
    'const t = s.split(/\\/\\/.*\\n/);',
    'const m = s.match(/\\/\\*.*?\\*\\//gs);',
    'const t = s.replace(/\\/\\/[^\\r\\n]*/g, "");',
    'const t = s.replace(/\\/\\/[^\\n\\r]*/g, "");',
    'const t = s.replace(/\\/\\/(.*)$/gm, "");',
    'const t = s.replace(/\\/\\/\\s*.*$/gm, "");',
    'const t = s.replace(/\\/\\/.*?$/gm, "");',
    'const t = s.replace(/\\/\\*[^*]*\\*+([^/*][^*]*\\*+)*\\//g, "");',
  ];
  for (const fixture of bad) {
    it(`flags ${fixture}`, () => {
      expect(fixture).toMatch(REGEX_COMMENT_STRIPPER);
    });
  }

  it('does not flag the shared-lexer call or an unrelated regex', () => {
    expect('const t = stripComments(src);').not.toMatch(REGEX_COMMENT_STRIPPER);
    expect('const t = s.replace(/foo\\/bar/g, "");').not.toMatch(REGEX_COMMENT_STRIPPER);
  });

  it('does not flag URL/path regexes that merely contain //', () => {
    expect("const t = s.replace(/https?:\\/\\//, '');").not.toMatch(REGEX_COMMENT_STRIPPER);
    expect('const t = s.match(/^\\/\\/cdn/);').not.toMatch(REGEX_COMMENT_STRIPPER);
    expect('const t = s.replace(/https:\\/\\/.*\\.example/, "");').not.toMatch(
      REGEX_COMMENT_STRIPPER,
    );
    expect('const t = s.match(/\\/\\/.+\\.com/);').not.toMatch(REGEX_COMMENT_STRIPPER);
  });
});

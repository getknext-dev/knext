import { describe, expect, it } from 'bun:test';
import { splitSourceIntoStatements } from './helpers/shell-statements';

const texts = (src: string) => splitSourceIntoStatements(src).map((s) => s.text.trim());

/**
 * Unit tests for the shared shell lexer that both musl-rebuild guard tests
 * (`musl-rebuild-npm-run-as-builder`, `musl-rebuild-npm-ci-build-from-source`)
 * rely on: the tricky constructs, so a lexer regression is caught here rather
 * than as a silently-shrunk scan in a consumer.
 */
describe('shell-statements lexer', () => {
  it('splits on newline, ;, &&, ||, | and a background &', () => {
    expect(texts('a\nb; c && d || e | f & g')).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  });

  it('does not split on a redirect ampersand (2>&1, &>file, <&0)', () => {
    expect(texts('cmd >o 2>&1')).toEqual(['cmd >o 2>&1']);
    expect(texts('cmd &>o')).toEqual(['cmd &>o']);
  });

  it('does not split on separators inside quotes', () => {
    expect(texts(`echo "a; b && c" 'd | e'`)).toEqual([`echo "a; b && c" 'd | e'`]);
  });

  it('drops comments, and an apostrophe in a comment does not open a quote', () => {
    expect(texts("# the script's header\nnpm ci")).toEqual(['npm ci']);
    expect(texts('npm ci # trailing note')).toEqual(['npm ci']);
  });

  it('treats # inside a word or ${v#x} as NOT a comment', () => {
    expect(texts('x=${y#z}; run npm ci')).toEqual(['x=${y#z}', 'run npm ci']);
    expect(texts('a#b c')).toEqual(['a#b c']);
  });

  it('joins a backslash-newline continuation into one statement', () => {
    expect(texts('run_as_builder npm \\\n  ci --no-audit')).toEqual([
      'run_as_builder npm   ci --no-audit',
    ]);
  });

  it('lexes a command substitution as its own statement, leaving an empty $() marker', () => {
    expect(texts('echo "$(npm ci)"')).toEqual(['npm ci', 'echo "$()"']);
    expect(texts('a `b c` d')).toContain('b c');
  });

  it('cuts heredoc bodies out by line and lexes them as their own statements', () => {
    const r = texts("cat <<'EOF'\nnpm ci\nEOF\nafter");
    expect(r).toContain('npm ci');
    expect(r).toContain('after');
    expect(r[0]).toBe("cat <<'EOF'");
  });

  it('reports the 1-based line each statement starts on', () => {
    const r = splitSourceIntoStatements('a\n\nb && c');
    expect(r.map((s) => [s.text.trim(), s.line])).toEqual([
      ['a', 1],
      ['b', 3],
      ['c', 3],
    ]);
  });

  it('flushes an unclosed construct instead of dropping it (fails towards reporting)', () => {
    expect(texts('echo "unterminated npm ci').join(' ')).toContain('npm ci');
  });
});

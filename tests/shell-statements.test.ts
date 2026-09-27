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
    // The terminator line is consumed, never lexed as a statement of its own.
    expect(r).not.toContain('EOF');
    const body = splitSourceIntoStatements("cat <<'EOF'\nnpm ci\nEOF\nafter").find(
      (x) => x.text.trim() === 'npm ci',
    );
    expect(body?.line).toBe(2);
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
  // ---- rules that only consumers used to exercise; each is asserted here so a
  // lexer regression is red in THIS file, not as a silently-shrunk scan elsewhere.

  it('lexes a TOP-LEVEL $(...) as its own nested statement (not only inside "...")', () => {
    expect(texts('$(npm ci)')).toEqual(['npm ci', '$()']);
    expect(texts('x=$(npm ci); after')).toEqual(['npm ci', 'x=$()', 'after']);
    expect(texts('run $(npm ci) --flag')).toEqual(['npm ci', 'run $() --flag']);
  });

  it('lexes <(...) and >(...) process substitutions as their own nested statements', () => {
    expect(texts('diff <(npm ci) b')).toEqual(['npm ci', 'diff <() b']);
    expect(texts('tee >(npm ci) b')).toEqual(['npm ci', 'tee >() b']);
  });

  it('a subshell/arithmetic paren inside a substitution does not close it early', () => {
    expect(texts('echo $( (a; b) ; npm ci ) z')).toContain('npm ci');
  });

  it("$'...' (ANSI-C) honours \\' — an escaped quote does not end it, so a `;` inside stays literal", () => {
    expect(texts("echo $'a\\'b; npm ci'; next")).toEqual(["echo $'a\\'b; npm ci'", 'next']);
    expect(texts("$'a\\'b'")).toEqual(["$'a\\'b'"]);
  });

  it("a plain '...' is fully literal: a backslash before the closing quote does NOT escape it", () => {
    expect(texts("echo 'a\\'; npm ci")).toEqual(["echo 'a\\'", 'npm ci']);
  });

  it('${...} is a brace frame: a # after a blank inside it is not a comment, and no separators split it', () => {
    expect(texts('x=${v:- #}; npm ci')).toEqual(['x=${v:- #}', 'npm ci']);
    expect(texts('x=${v:-a;b&&c|d}; npm ci')).toEqual(['x=${v:-a;b&&c|d}', 'npm ci']);
  });

  it('a nested brace and a quoted } inside ${...} do not end the frame early', () => {
    expect(texts('x=${v:-${w:-y}}; npm ci')).toEqual(['x=${v:-${w:-y}}', 'npm ci']);
    expect(texts('x=${v:-{a}b;c}; npm ci')).toEqual(['x=${v:-{a}b;c}', 'npm ci']);
    expect(texts('x=${v:-"}"}; npm ci')).toEqual(['x=${v:-"}"}', 'npm ci']);
    expect(texts("x=${v:-'}'}; npm ci")).toEqual(["x=${v:-'}'}", 'npm ci']);
  });

  it('a "..." region keeps separators and # literal, and a \\" inside does not close it', () => {
    expect(texts('echo "a \\" ; # b"; npm ci')).toEqual(['echo "a \\" ; # b"', 'npm ci']);
  });

  it('a substitution inside ${...} inside "..." is still lexed as its own statement', () => {
    expect(texts('echo "${v:-$(npm ci)}"')).toContain('npm ci');
  });

  it('backticks nest and close, in code and inside "..."', () => {
    expect(texts('a `npm ci` b; c')).toEqual(['npm ci', 'a `` b', 'c']);
    expect(texts('echo "`npm ci`"')).toContain('npm ci');
  });

  it('heredoc variants: <<-EOF strips leading tabs on the terminator; <<"EOF" and <<\\EOF are delimiters; <<< is a here-string', () => {
    expect(texts('cat <<-EOF\n\tnpm ci\n\tEOF\nafter')).toEqual(['cat <<-EOF', 'npm ci', 'after']);
    expect(texts('cat <<"EOF"\nnpm ci\nEOF\nafter')).toContain('after');
    expect(texts('cat <<\\EOF\nnpm ci\nEOF\nafter')).toContain('after');
    // a here-string does not swallow the following lines
    expect(texts('cat <<< npm\nafter')).toContain('after');
  });

  it('two heredocs on one line are both cut, in order', () => {
    const r = texts('cat <<A <<B\none\nA\ntwo\nB\nafter');
    expect(r).toContain('one');
    expect(r).toContain('two');
    expect(r).toContain('after');
    expect(r).not.toContain('A');
    expect(r).not.toContain('B');
  });

  it('a heredoc body containing an apostrophe does not desync the outer lexer', () => {
    expect(texts("cat <<EOF\nit's npm\nEOF\nafter")).toContain('after');
  });
});

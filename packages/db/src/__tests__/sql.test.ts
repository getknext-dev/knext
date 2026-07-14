import { describe, expect, it } from 'vitest';
import { quoteIdent, quoteLiteral } from '../sql';

// #278: shared quote helpers for the `@knext/db` migration-SQL emitters. The
// threat model is build-time-only (the developer already holds arbitrary-SQL
// power), but consistent quoting is correct hygiene and prevents a footgun — a
// table/column name (or interval literal) carrying a quote or special char must
// produce valid, non-injectable SQL, not broken SQL. Rules mirror Postgres:
//   • identifiers  → double-quoted, embedded `"` doubled  (libpq PQescapeIdentifier)
//   • literals     → single-quoted, embedded `'` doubled; a `\` forces an
//                    E'' escape-string with `\` doubled     (libpq PQescapeStringConn)

// A NUL byte constructed without a literal control char in source.
const NUL = String.fromCharCode(0);

describe('@knext/db sql — quoteIdent()', () => {
  it('double-quotes a simple identifier (always-quote convention)', () => {
    expect(quoteIdent('metrics')).toBe('"metrics"');
    expect(quoteIdent('created_at')).toBe('"created_at"');
  });

  it('doubles an embedded double-quote', () => {
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
  });

  it('neutralizes an injection attempt (quote-break + DROP)', () => {
    // A naive `"${name}"` would emit `"foo";DROP TABLE users;--"` and break out of
    // the identifier. Doubling the `"` keeps the whole thing one quoted identifier.
    expect(quoteIdent('foo"; DROP TABLE users; --')).toBe('"foo""; DROP TABLE users; --"');
  });

  it('preserves unicode inside the quotes untouched', () => {
    expect(quoteIdent('naïve_café')).toBe('"naïve_café"');
    expect(quoteIdent('日本語')).toBe('"日本語"');
  });

  it('rejects an empty identifier', () => {
    expect(() => quoteIdent('')).toThrow();
  });

  it('rejects an identifier containing a NUL byte', () => {
    expect(() => quoteIdent(`a${NUL}b`)).toThrow();
  });
});

describe('@knext/db sql — quoteLiteral()', () => {
  it('single-quotes a simple literal (no E-prefix when no backslash)', () => {
    expect(quoteLiteral('7 days')).toBe("'7 days'");
    expect(quoteLiteral('metrics')).toBe("'metrics'");
  });

  it("doubles an embedded single-quote (o'clock)", () => {
    expect(quoteLiteral("o'clock")).toBe("'o''clock'");
  });

  it('neutralizes an injection attempt (quote-break + statement)', () => {
    expect(quoteLiteral("x'); DROP TABLE users; --")).toBe("'x''); DROP TABLE users; --'");
  });

  it('emits an E-string with the backslash doubled when a backslash is present', () => {
    // Standard-conforming strings treat `\` literally, but to be safe against
    // standard_conforming_strings=off we switch to an explicit E'' string and
    // double the backslash (matching libpq PQescapeStringConn behaviour).
    expect(quoteLiteral('a\\b')).toBe("E'a\\\\b'");
  });

  it('combines backslash + single-quote escaping in an E-string', () => {
    expect(quoteLiteral("a\\'b")).toBe("E'a\\\\''b'");
  });

  it('preserves unicode inside the quotes untouched', () => {
    expect(quoteLiteral('café')).toBe("'café'");
  });

  it('rejects a literal containing a NUL byte', () => {
    // Postgres text cannot contain a NUL; libpq rejects it too.
    expect(() => quoteLiteral(`a${NUL}b`)).toThrow();
  });
});

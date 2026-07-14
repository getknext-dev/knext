/**
 * `@knext/db` SQL quoting helpers (#278) — the one shared place the extension
 * emitters (`./extensions/timescaledb`, `./extensions/pgvector`, and future
 * lanes) turn developer-authored table/column names and interval/window literals
 * into **valid, non-injectable** SQL.
 *
 * ## Threat model (honest)
 *
 * These are **build-time migration-SQL string builders** — the developer already
 * holds arbitrary-SQL power at the point they call them, so this is not a
 * privilege boundary. What it *is*: correct hygiene and a footgun-remover. A
 * table named `o'clock` or a column carrying a `"` used to emit **broken /
 * injectable** SQL; routing every interpolation through these helpers makes it
 * emit correct SQL instead. As the emitter surface grows (pgvector helpers, more
 * to come) every lane inherits the same guarantee from day one.
 *
 * ## Convention: always-quote
 *
 * The simplest, safest rule — always quote, never conditionally. Postgres treats
 * `"foo"` and `foo` as the same identifier for the common lowercase-ASCII case,
 * so for well-formed names the emitted SQL is unchanged; for anything else the
 * quoting is what makes it correct.
 *
 * ## Escaping rules (Postgres / libpq)
 *
 * Implemented to match libpq's `PQescapeIdentifier` / `PQescapeStringConn` and
 * `pg-format`'s `%I` / `%L`, so no live connection and no heavy runtime dep are
 * needed:
 *   • Identifier: wrap in `"…"`, double every embedded `"` (`"` → `""`).
 *     https://www.postgresql.org/docs/current/sql-syntax-lexical.html#SQL-SYNTAX-IDENTIFIERS
 *   • Literal: wrap in `'…'`, double every embedded `'` (`'` → `''`). If the value
 *     contains a backslash, switch to a leading `E'…'` escape-string and double
 *     every backslash (`\` → `\\`) — this stays correct whether or not the server
 *     has `standard_conforming_strings` on (libpq does exactly this).
 *     https://www.postgresql.org/docs/current/sql-syntax-lexical.html#SQL-SYNTAX-STRINGS
 *   • A NUL byte cannot appear in a Postgres identifier or text value; both
 *     helpers reject it (libpq rejects it too). An empty identifier is also
 *     rejected — it is never a valid target.
 */

// A Postgres identifier or text value can never contain a NUL byte.
const NUL = String.fromCharCode(0);

/**
 * Quote a developer-supplied SQL **identifier** (table / column / index name).
 * Wraps in double quotes and doubles any embedded double quote, per Postgres
 * identifier rules (libpq `PQescapeIdentifier`). Throws on an empty name or a
 * NUL byte — neither is a valid identifier.
 *
 * ```ts
 * quoteIdent('metrics');   // → "metrics"
 * quoteIdent('we"ird');    // → "we""ird"
 * ```
 */
export function quoteIdent(name: string): string {
  if (name.length === 0) {
    throw new Error('quoteIdent: identifier must be a non-empty string');
  }
  if (name.includes(NUL)) {
    throw new Error('quoteIdent: identifier must not contain a NUL byte');
  }
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Quote a developer-supplied string **literal** (an interval, retention window,
 * or any text argument). Wraps in single quotes and doubles any embedded single
 * quote. If the value contains a backslash it is emitted as an `E'…'`
 * escape-string with backslashes doubled, so it is correct regardless of the
 * server's `standard_conforming_strings` setting (libpq `PQescapeStringConn`).
 * Throws on a NUL byte — Postgres text cannot contain one.
 *
 * ```ts
 * quoteLiteral('7 days');   // → '7 days'
 * quoteLiteral("o'clock");  // → 'o''clock'
 * quoteLiteral('a\\b');     // → E'a\\b'
 * ```
 */
export function quoteLiteral(value: string): string {
  if (value.includes(NUL)) {
    throw new Error('quoteLiteral: value must not contain a NUL byte');
  }
  const escaped = value.replace(/'/g, "''");
  if (value.includes('\\')) {
    // Force an escape-string so the backslash is literal under any
    // standard_conforming_strings setting, and double the backslashes.
    return `E'${escaped.replace(/\\/g, '\\\\')}'`;
  }
  return `'${escaped}'`;
}

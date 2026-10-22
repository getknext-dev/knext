#!/usr/bin/env node
/**
 * Fail-closed govulncheck gate.
 *
 *   govulncheck -format json ./... | node scripts/govulncheck-gate.mjs
 *
 * govulncheck's JSON mode always exits 0, so this gate does the failing: any
 * CALLED vulnerability (a finding whose trace names a function) fails unless
 * security/govulncheck-exceptions.json carries a live entry for its id. An
 * entry is `{ id, expires, justification }`; a malformed entry, an expired
 * entry, and an entry whose vulnerability is no longer called all FAIL, so an
 * exception cannot outlive its reason or sit around unread.
 *
 * One exceptions file serves every Go module, so an entry may carry an optional
 * `modules: [dir, ...]` scope (module directories relative to the repo root).
 * Omitted means every module. The module being scanned is the first argument
 * (or GOVULNCHECK_MODULE) and is REQUIRED on the command line, so a step that
 * forgets it fails rather than silently applying every entry.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ID = /^GO-\d{4}-\d{4,}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KEYS = new Set(['id', 'expires', 'justification', 'modules']);

/** Split govulncheck's stream of concatenated JSON objects. Throws if truncated. */
export function parseStream(text) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth < 0) throw new Error('govulncheck output: unbalanced }');
      if (depth === 0) out.push(JSON.parse(text.slice(start, i + 1)));
    } else if (depth === 0 && !/\s/.test(c)) {
      throw new Error(`govulncheck output: unexpected character ${JSON.stringify(c)}`);
    }
  }
  if (depth !== 0 || inStr) throw new Error('govulncheck output: truncated JSON');
  return out;
}

export function evaluate(messages, entries, now = new Date(), module = undefined) {
  const errors = [];
  // Fail closed on a crashed or truncated govulncheck: an empty stream must not
  // read as "no vulnerabilities". A real run opens with `config` and reaches the
  // call-graph stage before any finding is emitted.
  if (!messages.some((m) => m?.config)) {
    errors.push('govulncheck produced no config message (crashed or no output)');
  }
  if (
    !messages.some((m) =>
      /Checking the code against the vulnerabilities/.test(m?.progress?.message ?? ''),
    )
  ) {
    errors.push('govulncheck did not complete a scan (no call-graph stage reached)');
  }
  const called = new Set();
  for (const m of messages) {
    const f = m?.finding;
    if (f?.osv && Array.isArray(f.trace) && f.trace.some((t) => t?.function)) called.add(f.osv);
  }

  const live = new Set();
  const today = now.toISOString().slice(0, 10);
  for (const e of entries) {
    const label = `exception ${JSON.stringify(e?.id)}`;
    const extra = Object.keys(e ?? {}).filter((k) => !KEYS.has(k));
    if (extra.length) errors.push(`${label}: unknown key(s) ${extra.join(', ')}`);
    if (typeof e?.id !== 'string' || !ID.test(e.id)) {
      errors.push(`${label}: id must look like GO-YYYY-NNNN`);
      continue;
    }
    if (
      typeof e.expires !== 'string' ||
      !DATE.test(e.expires) ||
      Number.isNaN(Date.parse(e.expires))
    ) {
      errors.push(`${label}: expires must be an ISO date (YYYY-MM-DD)`);
      continue;
    }
    if (typeof e.justification !== 'string' || e.justification.trim().length < 20) {
      errors.push(`${label}: justification must be at least 20 characters`);
      continue;
    }
    if (e.expires < today) {
      errors.push(`${label}: expired on ${e.expires}; bump the toolchain and remove it`);
      continue;
    }
    if (e.modules !== undefined) {
      if (
        !Array.isArray(e.modules) ||
        e.modules.length === 0 ||
        e.modules.some((m) => typeof m !== 'string' || m.trim() === '')
      ) {
        errors.push(`${label}: modules must be a non-empty array of module directories`);
        continue;
      }
      // Out of scope for the module being scanned: it neither covers a finding nor
      // can it be stale here (the module it names is scanned in its own leg).
      if (module !== undefined && !e.modules.includes(module)) continue;
    }
    if (!called.has(e.id)) {
      errors.push(`${label}: stale, ${e.id} is no longer called; remove the entry`);
      continue;
    }
    live.add(e.id);
  }

  for (const id of called) {
    if (!live.has(id)) errors.push(`${id}: called vulnerability with no live exception`);
  }
  return { ok: errors.length === 0, errors, called: [...called] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const module = process.argv[2] ?? process.env.GOVULNCHECK_MODULE;
  if (!module) {
    console.error(
      'govulncheck-gate: the module is required (argument or GOVULNCHECK_MODULE), e.g. templates/go',
    );
    process.exit(1);
  }
  const file = resolve(import.meta.dirname, '../security/govulncheck-exceptions.json');
  const entries = JSON.parse(readFileSync(file, 'utf8')).allow;
  if (!Array.isArray(entries)) throw new Error(`${file}: "allow" must be an array`);
  // Async chunked read: a ~600 KB pipe through readFileSync(0) aborted node
  // ("malloc(): invalid size") on the CI runner.
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = Buffer.concat(chunks).toString('utf8');
  const result = evaluate(parseStream(input), entries, new Date(), module);
  if (!result.ok) {
    for (const e of result.errors) console.error(`govulncheck-gate: ${e}`);
    process.exit(1);
  }
  console.log(`govulncheck-gate: ok (called and excepted: ${result.called.join(', ') || 'none'})`);
}

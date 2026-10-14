#!/usr/bin/env node
/**
 * Mutation proof for the @getknext/ffi generator's name hygiene, 64-bit JSON
 * refusal, TSDoc accuracy, output hygiene, the type namespace and object keys
 * (issue #2344, PR #2351 rounds 2-3).
 *
 * Two guards, two specs:
 *
 *   - `ffi-render-hygiene.test.ts` scans a rendered module with the TypeScript
 *     compiler. It is run on its own (not through render.test.ts) because
 *     render.test.ts pins the full golden module, which reds on ANY change to
 *     the output and would make every mutation below look caught.
 *   - `ffi-loader.test.ts` runs the generated module against a real shared
 *     library (the C fixture): a collision is a SyntaxError at import, and a
 *     64-bit integer sent as a JSON number must come back as a RustError naming
 *     its path.
 *
 * Each mutation puts back ONE defect (most of them the round-1 text exactly)
 * and requires its spec to go red. The codec closure parameters (H05-H07) are
 * proved only against the scan: a closure parameter that shadows an argument
 * is legal JavaScript, so no behavioural test can see it, and the scan is what
 * keeps them out of the argument namespace anyway.
 *
 * Verdicts are by EXIT CODE only (the shared driver, `scripts/lib/guard-prover.mjs`,
 * never parses output), every anchor must occur exactly once (preflight first),
 * each baseline must be green, a canary must go red before any green is trusted,
 * and every restore is content-verified. The specs are `bun:test` files, run one
 * file per process by `scripts/bun-test.mjs`. The loader spec needs a system `cc`.
 *
 * Usage:  node scripts/mutation-prove-ffi-generator.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HYGIENE_SPEC = 'packages/ffi/src/__tests__/ffi-render-hygiene.test.ts';
const LOADER_SPEC = 'packages/ffi/src/__tests__/ffi-loader.test.ts';
const HYGIENE = [
  // ── generated locals vs Rust argument names ─────────────────────────────
  {
    id: 'H01',
    subject: 'render',
    claim: 'the (ptr, len) offset/length locals lose their $ prefix (o0, n0)',
    anchor:
      '      lines.push(`  const $o${i} = $put(${value});`);\n      lines.push(`  const $n${i} = $last;`);\n      call.push(`$n${i} === 0 ? null : $scratch + $o${i}`, `$n${i}`);',
    replacement:
      '      lines.push(`  const o${i} = $put(${value});`);\n      lines.push(`  const n${i} = $last;`);\n      call.push(`n${i} === 0 ? null : $scratch + o${i}`, `n${i}`);',
  },
  {
    id: 'H02',
    subject: 'render',
    claim: 'the scratch-buffer base pointer is a bare `base` again',
    anchor:
      "      call.push(`$n${i} === 0 ? null : $scratch + $o${i}`, `$n${i}`);\n    });\n    if (buffers > 0) {\n      this.used.add('$put');\n      lines.push('  const $scratch = $base();');",
    replacement:
      "      call.push(`$n${i} === 0 ? null : base + $o${i}`, `$n${i}`);\n    });\n    if (buffers > 0) {\n      this.used.add('$put');\n      lines.push('  const base = $base();');",
  },
  {
    id: 'H03',
    subject: 'render',
    claim: 'the status local is a bare `st` again',
    anchor:
      "    lines.push(`  const $st = $lib.${f.symbol}(${call.join(', ')});`);\n    lines.push(`  if ($st !== 0) $fail(${name}, $st);`);",
    replacement:
      "    lines.push(`  const st = $lib.${f.symbol}(${call.join(', ')});`);\n    lines.push(`  if (st !== 0) $fail(${name}, st);`);",
  },
  {
    id: 'H04',
    subject: 'render',
    claim: 'the parsed-result local is a bare `r` again',
    anchor:
      "      lines.push('  const $r: unknown = JSON.parse($takeString());');\n      lines.push(`  return ${this.dec(rt, '$r', name, q('result'), 0).code};`);",
    replacement:
      "      lines.push('  const r: unknown = JSON.parse($takeString());');\n      lines.push(`  return ${this.dec(rt, 'r', name, q('result'), 0).code};`);",
  },
  {
    id: 'H05',
    subject: 'render',
    claim: 'the encoder closure parameter is a bare `x0` again',
    anchor: '      const x = `$x${depth}`;\n      const inner = this.enc(d.of, x, depth + 1);',
    replacement: '      const x = `x${depth}`;\n      const inner = this.enc(d.of, x, depth + 1);',
  },
  {
    id: 'H06',
    subject: 'render',
    claim: 'the Option decoder closure parameter is a bare `x0` again',
    anchor:
      '      const x = `$x${depth}`;\n      const inner = this.dec(d.of, x, fn, at, depth + 1);',
    replacement:
      '      const x = `x${depth}`;\n      const inner = this.dec(d.of, x, fn, at, depth + 1);',
  },
  {
    id: 'H07',
    subject: 'render',
    claim: 'the Vec decoder path parameter is a bare `at0` again',
    anchor: '      const a = `$at${depth}`;',
    replacement: '      const a = `at${depth}`;',
  },
  // ── module scope vs Rust export/type names ──────────────────────────────
  {
    id: 'H08',
    subject: 'render',
    claim: 'node:path `join` is imported under its own name again (an export `join` collides)',
    anchor: '    "import { dirname as $dirname, join as $join } from \'node:path\';",',
    replacement: '    "import { dirname as $dirname, join as $join, join } from \'node:path\';",',
  },
  {
    id: 'H09',
    subject: 'manifest',
    claim: 'an export named `process` is accepted (it would shadow the global the loader reads)',
    anchor: "  'process',",
    replacement: '',
  },
  {
    id: 'H10',
    subject: 'manifest',
    claim: 'an argument named `JSON` is accepted (it would shadow JSON.stringify/JSON.parse)',
    anchor: "  'JSON',",
    replacement: '',
  },
  // ── internal references in generated output ─────────────────────────────
  {
    id: 'H11',
    subject: 'render',
    claim: 'the $SCHEMAS comment carries the ADR reference into user apps again',
    anchor: "    '/** [export, symbol, expected FNV-1a 64 of its transitive schema]. */',",
    replacement:
      "    '/** [export, symbol, expected FNV-1a 64 of its transitive schema] (ADR-0069 D4). */',",
  },
  {
    id: 'H12',
    subject: 'render',
    claim: 'the $s64 comment carries the design-decision label into user apps again',
    anchor: '    $s64: `/** A 64-bit integer crosses JSON as a decimal string. */',
    replacement: '    $s64: `/** A 64-bit integer crosses JSON as a decimal string (D7). */',
  },
  // ── TSDoc accuracy ──────────────────────────────────────────────────────
  {
    id: 'H13',
    subject: 'render',
    claim: 'TSDoc promises a TypeError for every argument again, record/enum ones included',
    anchor:
      '  if (checked.length > 0) {\n' +
      '    extra.push(\n' +
      '      `@throws {TypeError} when ${orList(checked)} has the wrong type or is out of range.`,',
    replacement:
      '  if (f.args.length > 0) {\n' +
      '    extra.push(\n' +
      "      '@throws {TypeError} when an argument has the wrong type or is out of range.',",
  },
  {
    id: 'H14',
    subject: 'render',
    claim: 'TSDoc no longer says record/enum arguments are unchecked in JavaScript',
    anchor: '  if (unchecked.length > 0) {',
    replacement: '  if (false) {',
  },
  // ── type namespace and object keys (round 3) ────────────────────────────
  {
    id: 'H15',
    subject: 'manifest',
    claim:
      'a record or enum named `string` is accepted (`export interface string` does not compile)',
    anchor: "  'object',\n  'string',\n  'symbol',",
    replacement: "  'object',\n  'symbol',",
  },
  {
    id: 'H16',
    subject: 'manifest',
    claim:
      'a type named `keyof` is accepted (`p: keyof` does not parse): caught only by type-checking every TypeScript keyword',
    anchor: "  'keyof',",
    replacement: '',
  },
  {
    id: 'H17',
    subject: 'manifest',
    claim:
      'a field named `__proto__` is accepted (an object literal sets the prototype and drops it)',
    anchor: "  if (!FIELD.test(name) || name === '__proto__') {",
    replacement: '  if (!FIELD.test(name)) {',
  },
  {
    id: 'H18',
    subject: 'manifest',
    claim: 'record field names are not checked at all again',
    anchor: '      checkField(fl.name);',
    replacement: '',
  },
];

const LOADER = [
  {
    id: 'L01',
    subject: 'render',
    claim: '`fn scale(r: f64) -> Point` redeclares `r`: the module no longer parses',
    anchor:
      "      lines.push('  const $r: unknown = JSON.parse($takeString());');\n      lines.push(`  return ${this.dec(rt, '$r', name, q('result'), 0).code};`);",
    replacement:
      "      lines.push('  const r: unknown = JSON.parse($takeString());');\n      lines.push(`  return ${this.dec(rt, 'r', name, q('result'), 0).code};`);",
  },
  {
    id: 'L02',
    subject: 'render',
    claim: 'an argument named `o0`/`n0` redeclares a buffer local',
    anchor:
      '      lines.push(`  const $o${i} = $put(${value});`);\n      lines.push(`  const $n${i} = $last;`);\n      call.push(`$n${i} === 0 ? null : $scratch + $o${i}`, `$n${i}`);',
    replacement:
      '      lines.push(`  const o${i} = $put(${value});`);\n      lines.push(`  const n${i} = $last;`);\n      call.push(`n${i} === 0 ? null : $scratch + o${i}`, `n${i}`);',
  },
  {
    id: 'L03',
    subject: 'render',
    claim: 'an argument named `base` redeclares the scratch base pointer',
    anchor:
      "      call.push(`$n${i} === 0 ? null : $scratch + $o${i}`, `$n${i}`);\n    });\n    if (buffers > 0) {\n      this.used.add('$put');\n      lines.push('  const $scratch = $base();');",
    replacement:
      "      call.push(`$n${i} === 0 ? null : base + $o${i}`, `$n${i}`);\n    });\n    if (buffers > 0) {\n      this.used.add('$put');\n      lines.push('  const base = $base();');",
  },
  {
    id: 'L04',
    subject: 'render',
    claim: 'an argument named `st` redeclares the status local',
    anchor:
      "    lines.push(`  const $st = $lib.${f.symbol}(${call.join(', ')});`);\n    lines.push(`  if ($st !== 0) $fail(${name}, $st);`);",
    replacement:
      "    lines.push(`  const st = $lib.${f.symbol}(${call.join(', ')});`);\n    lines.push(`  if (st !== 0) $fail(${name}, st);`);",
  },
  {
    id: 'L05',
    subject: 'render',
    claim: 'an export named `join` collides with the node:path import',
    anchor: '    "import { dirname as $dirname, join as $join } from \'node:path\';",',
    replacement: '    "import { dirname as $dirname, join as $join, join } from \'node:path\';",',
  },
  {
    id: 'L06',
    subject: 'render',
    claim:
      'a 64-bit integer sent as a JSON number is accepted (precision silently lost above 2^53)',
    anchor: "  if (typeof v !== 'string' || !/^-?[0-9]+$/.test(v)) {",
    replacement: "  if (typeof v !== 'string' && typeof v !== 'number') {",
  },
  {
    id: 'L07',
    subject: 'render',
    claim: 'a record decoder error no longer names the field (path stays `result`)',
    anchor:
      "        `${key(f.name)}: ${this.dec(f.type, `o[${q(f.name)}]`, 'fn', `at + ${q(`.${f.name}`)}`, 0).code}`,",
    replacement:
      "        `${key(f.name)}: ${this.dec(f.type, `o[${q(f.name)}]`, 'fn', 'at', 0).code}`,",
  },
  {
    id: 'L08',
    subject: 'render',
    claim: 'a Vec decoder error no longer names the element index',
    anchor: '  return (v as unknown[]).map((x, i) => f(x, \\`\\${at}[\\${i}]\\`));',
    replacement: '  return (v as unknown[]).map((x, i) => f(x, at));',
  },
  {
    id: 'L09',
    subject: 'manifest',
    claim:
      'field names are held to the identifier word list: `new`, `type` (Rust r#new, r#type) are refused, so keyword and Object.prototype-named fields stop round-tripping',
    anchor: "  if (!FIELD.test(name) || name === '__proto__') {",
    replacement: "  if (!FIELD.test(name) || name === '__proto__' || RESERVED.has(name)) {",
  },
];

// The subjects are inline literals, not a shared constant: the lane's
// subject-existence audit reads them from the createGuardProver call.
const hygiene = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: HYGIENE_SPEC,
  subjects: { render: 'packages/ffi/src/render.ts', manifest: 'packages/ffi/src/manifest.ts' },
});
const loader = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: LOADER_SPEC,
  subjects: { render: 'packages/ffi/src/render.ts', manifest: 'packages/ffi/src/manifest.ts' },
});

console.log('=== mutation proof: @getknext/ffi generator (#2344, PR #2351 rounds 2-3) ===');
hygiene.preflight(HYGIENE);
loader.preflight(LOADER);
declareMutations(HYGIENE.length + LOADER.length);

console.log(
  '\n=== hygiene spec (scan, full type-check, field keys, TSDoc, internal references) ===',
);
hygiene.baseline();
hygiene.proveCanSeeRed({ subject: 'manifest', anchor: "  'Record',", replacement: '' });
for (const m of HYGIENE) {
  hygiene.run({ ...m, expect: 'red' });
  recordMutation();
}
hygiene.finish(HYGIENE.length);

console.log('\n=== loader spec (the generated module against the C fixture library) ===');
loader.baseline();
loader.proveCanSeeRed({
  subject: 'render',
  anchor: '    lines.push(`  if ($st !== 0) $fail(${name}, $st);`);',
  replacement: '    lines.push(`  if ($st === 99) $fail(${name}, $st);`);',
});
for (const m of LOADER) {
  loader.run({ ...m, expect: 'red' });
  recordMutation();
}
loader.finish(LOADER.length);

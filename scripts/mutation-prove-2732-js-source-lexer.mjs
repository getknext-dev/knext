#!/usr/bin/env node
/**
 * Mutation proof for the shared comment/string lexer (#2732).
 *
 * Two halves, each a guard that must go red when its subject is broken:
 *   - the golden vectors (packages/kn-next/src/__tests__/js-source-lexer.test.ts)
 *     against string, template, regex and comment handling in the lexer itself;
 *   - the call-site migration guard (tests/js-source-lexer-sharing.test.ts)
 *     against a guard dropping the shared import or growing its own scanner back.
 *
 * Same discipline as the other provers: `mutate` asserts each anchor occurs
 * EXACTLY once and aborts otherwise; judged on EXIT CODES only, never grepped
 * output; a baseline-green check first and a green-again check after each restore.
 *
 *   node scripts/mutation-prove-2732-js-source-lexer.mjs
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');

// biome-ignore format: the anchor scan needs the resolve() call on ONE line
const LEXER = resolve(REPO_ROOT, 'packages/kn-next/src/adapters/js-source-lexer.mjs');
const STATIC_EXPORT = resolve(REPO_ROOT, 'packages/kn-next/src/cli/static-export-guard.ts');
const INSTALL_GUARD = resolve(REPO_ROOT, 'scripts/workflow-script-install-guard.mjs');
const ANCHOR_SCAN = resolve(REPO_ROOT, 'scripts/lib/prover-anchor-scan.mjs');

const SPEC_VECTORS = 'packages/kn-next/src/__tests__/js-source-lexer.test.ts';
const SPEC_SHARING = 'tests/js-source-lexer-sharing.test.ts';
const SPECS = [SPEC_VECTORS, SPEC_SHARING];

/** `/*` so the residue marker cannot comment out the rest of a mid-line expression. */
const OPTS = { commentPrefix: '/*' };

const MUTATIONS = [
  {
    label: 'lexer: ignore escaped quotes inside a string',
    target: LEXER,
    spec: SPEC_VECTORS,
    anchor: "!== '\\n') j += source[j] === '\\\\' ? 2 : 1;",
    replacement: "!== '\\n') j += 1;",
  },
  {
    label: 'lexer: ignore an escaped backtick inside template text',
    target: LEXER,
    spec: SPEC_VECTORS,
    anchor: "      j += source[j] === '\\\\' ? 2 : 1;\n    }\n    out.push(keep(",
    replacement: '      j += 1;\n    }\n    out.push(keep(',
  },
  {
    label: 'lexer: blank-strings mode no longer blanks string or template text',
    target: LEXER,
    spec: SPEC_VECTORS,
    anchor: 'const keep = (s) => (blankStrings ? blank(s) : s);',
    replacement: 'const keep = (s) => s;',
  },
  {
    label: 'lexer: blank-regex mode no longer blanks a regex body',
    target: LEXER,
    spec: SPEC_VECTORS,
    anchor: 'const keepRegex = (s) => (blankRegex ? blank(s) : s);',
    replacement: 'const keepRegex = (s) => s;',
  },
  {
    label: 'lexer: never recognise a regex literal (its `//` reads as a comment)',
    target: LEXER,
    spec: SPEC_VECTORS,
    anchor: "} else if (c === '/' && regexMayStart() && scanRegex()) {",
    replacement: '} else if (false) {',
  },
  {
    label: 'lexer: a block comment swallows its newlines (offsets and lines shift)',
    target: LEXER,
    spec: SPEC_VECTORS,
    anchor: '      const j = k === -1 ? n : k + 2;\n      out.push(blank(source.slice(i, j)));',
    replacement: "      const j = k === -1 ? n : k + 2;\n      out.push(' '.repeat(j - i));",
  },
  {
    label: 'lexer: an unterminated string eats the newline that ends it',
    target: LEXER,
    spec: SPEC_VECTORS,
    anchor: 'i = closed ? j + 1 : Math.min(j, n);',
    replacement: 'i = Math.min(j + 1, n);',
  },
  {
    label: 'lexer: template `${}` expressions are not tracked (code inside reads as text)',
    target: LEXER,
    spec: SPEC_VECTORS,
    anchor: '      templates.push(depth);',
    replacement: '      void depth;',
  },
  {
    label: 'call site: the static-export guard stops importing the shared lexer',
    target: STATIC_EXPORT,
    spec: SPEC_SHARING,
    anchor: 'import { stripComments } from "../adapters/js-source-lexer.mjs";\n',
    replacement: 'const stripComments = (s: string) => s;\n',
  },
  {
    label: 'call site: the install guard grows its own stripComments back',
    target: INSTALL_GUARD,
    spec: SPEC_SHARING,
    anchor:
      "import { stripComments } from '../packages/kn-next/src/adapters/js-source-lexer.mjs';\n",
    replacement: 'function stripComments(source) {\n  return source;\n}\n',
  },
  {
    label: 'call site: the anchor scan grows a hand-rolled comment scanner back',
    target: ANCHOR_SCAN,
    spec: SPEC_SHARING,
    anchor: '  return stripComments(src, { blankStrings: true });',
    replacement: "  src.indexOf('*/', 0);\n  return stripComments(src, { blankStrings: true });",
  },
];

declareMutations(MUTATIONS.length);

/** True when the spec PASSED. Exit code only, never the output. */
function specPasses(spec) {
  const runner = resolveSpecRunner(REPO_ROOT, spec);
  const r = spawnSync(runner.command, [...runner.args, ...runner.runArgs(spec)], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
  });
  return r.status === 0;
}

let pass = 0;
let fail = 0;

function prove({ label, target, spec, anchor, replacement }) {
  console.log(`── mutation: ${label}`);
  const snap = snapshot(target);
  try {
    mutate(snap, anchor, replacement, OPTS);
    if (specPasses(spec)) {
      console.log(`   x DECORATION: ${spec} stayed GREEN with the behaviour removed`);
      fail += 1;
    } else {
      console.log(`   ok ${spec} went RED as required`);
      pass += 1;
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (!specPasses(spec)) {
    console.error(`   FATAL: ${spec} did not go green again after restore`);
    process.exit(1);
  }
}

console.log('Baseline: every spec must be GREEN before anything is mutated.');
for (const spec of SPECS) {
  if (!specPasses(spec)) {
    console.error(`FATAL: ${spec} is not green to begin with`);
    process.exit(1);
  }
}
console.log('   ok baseline green\n');

// Byte snapshots of every subject, taken before the first mutation: each must be
// byte-identical again once every mutation has been restored.
const SUBJECTS = [
  snapshot(LEXER),
  snapshot(STATIC_EXPORT),
  snapshot(INSTALL_GUARD),
  snapshot(ANCHOR_SCAN),
];

for (const m of MUTATIONS) prove(m);

for (const s of SUBJECTS) {
  if (!readFileSync(s.path).equals(s.bytes)) {
    console.error(`FATAL: ${s.path} is not byte-identical to its pre-mutation snapshot`);
    process.exit(1);
  }
}

console.log(`\n${pass} caught, ${fail} undetected.`);
if (fail > 0) {
  console.error('At least one mutation went undetected, so that guard is decoration.');
  process.exit(1);
}

#!/usr/bin/env node
/**
 * Mutation proof for the escalation-trigger classifier's widened scope (#2388).
 *
 * `.claude/rules/workflow.md`: "a guard that stays green when its subject is
 * removed is decoration." Each mutation below removes or widens one rule the
 * #2388 re-scope added — every CRD types file, every package CLI and manifest,
 * `crates/`, the supply-chain set, and fail-closed handling of unknown input —
 * plus round 2's rules (M27–M44): the transitive release-path import closure and
 * its fail-closed gaps, both paths of a rename, `-z` parsing, and write-grant /
 * `toJSON(secrets)` credentials — plus round 3's (M45–M81): scripts a module
 * spawns or names, `createRequire` and unresolvable child-process gaps, their
 * resolution (wrappers, runner factories, invoker overrides), token-aware comment
 * stripping, and non-literal shell `source` —
 * and REQUIRES `tests/escalation-triggers.test.ts` to go red. The shared driver
 * (`scripts/lib/guard-prover.mjs`) owns the discipline: verdicts by EXIT CODE
 * only, baseline green first, a canary that must go red, anchors that must occur
 * exactly once, byte-exact restore.
 *
 * Usage: node scripts/mutation-prove-2388-escalation-trigger-scope.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/escalation-triggers.test.ts';

const MUTATIONS = [
  {
    id: 'M1',
    expect: 'red',
    claim:
      'the CRD rule shrinks back to nextapp_types.go — a new or second API types file stops firing',
    subject: 'guard',
    anchor: '    match: (p) => CRD_TYPES.test(p),',
    replacement:
      "    match: (p) => p === 'packages/kn-next-operator/api/v1alpha1/nextapp_types.go',",
  },
  {
    id: 'M2',
    expect: 'red',
    claim: 'the CRD pattern loses its api/ anchor — any *_types.go (controller internals) fires',
    subject: 'guard',
    anchor: 'const CRD_TYPES = /(^|\\/)api\\/(.+\\/)?[^/]+_types\\.go$/;',
    replacement: 'const CRD_TYPES = /_types\\.go$/;',
  },
  {
    id: 'M3',
    expect: 'red',
    claim: "the CLI rule shrinks back to core's src/cli/ — grpc/ffi cli.ts stop firing",
    subject: 'guard',
    anchor: '    match: (p) => CLI_SURFACE.test(p) && !isTestPath(p),',
    replacement: "    match: (p) => p.startsWith('packages/kn-next/src/cli/'),",
  },
  {
    id: 'M4',
    expect: 'red',
    claim: 'the CLI rule stops excluding tests — a test under src/cli/ is mistaken for surface',
    subject: 'guard',
    anchor: '    match: (p) => CLI_SURFACE.test(p) && !isTestPath(p),',
    replacement: '    match: (p) => CLI_SURFACE.test(p),',
  },
  {
    id: 'M5',
    expect: 'red',
    claim: 'the crates rule is dropped — Rust source, Cargo.lock and deny.toml stop firing',
    subject: 'guard',
    anchor: "    match: (p) => p.startsWith('crates/'),",
    replacement: '    match: (p) => false && p,',
  },
  {
    id: 'M6',
    expect: 'red',
    claim: 'security/** stops being supply chain — scan allowlists change unflagged',
    subject: 'guard',
    anchor: "  if (p.startsWith('security/')) return true;\n",
    replacement: '',
  },
  {
    id: 'M7',
    expect: 'red',
    claim: 'scripts/audit-published.mjs stops being supply chain',
    subject: 'guard',
    anchor: "  if (p === 'scripts/audit-published.mjs') return true;\n",
    replacement: '',
  },
  {
    id: 'M8',
    expect: 'red',
    claim:
      'package supply-chain modules (packages/ffi/src/supply-chain.ts, the #2359 miss) stop firing',
    subject: 'guard',
    anchor:
      '  return /^packages\\/[^/]+\\/src\\/(.+\\/)?supply-chain\\.[cm]?[jt]s$/.test(p) && !isTestPath(p);',
    replacement: '  return false && p;',
  },
  {
    id: 'M9',
    expect: 'red',
    claim: 'supply-chain modules stop excluding test fixtures',
    subject: 'guard',
    anchor:
      '  return /^packages\\/[^/]+\\/src\\/(.+\\/)?supply-chain\\.[cm]?[jt]s$/.test(p) && !isTestPath(p);',
    replacement: '  return /^packages\\/[^/]+\\/src\\/(.+\\/)?supply-chain\\.[cm]?[jt]s$/.test(p);',
  },
  {
    id: 'M10',
    expect: 'red',
    claim: 'id-token: write (OIDC federation, keyless signing) stops counting as a credential',
    subject: 'guard',
    anchor: '  if (/id-token\\s*:\\s*[\'"]?write/.test(text)) return true;\n',
    replacement: '',
  },
  {
    id: 'M11',
    expect: 'red',
    claim: 'a secrets[...] index expression (name unknowable) passes instead of failing closed',
    subject: 'guard',
    anchor: '  if (/secrets\\s*\\[/.test(text)) return true;\n',
    replacement: '',
  },
  {
    id: 'M12',
    expect: 'red',
    claim: 'a named secret such as NPM_TOKEN stops counting as a credential',
    subject: 'guard',
    anchor: '    if (!LOW_PRIVILEGE_SECRETS.has(m[1])) return true;',
    replacement: '    if (false && m) return true;',
  },
  {
    id: 'M13',
    expect: 'red',
    claim: 'the low-privilege exemption is ignored — every ci.yml edit (CODECOV_TOKEN) fires',
    subject: 'guard',
    anchor: '    if (!LOW_PRIVILEGE_SECRETS.has(m[1])) return true;',
    replacement: '    if (m) return true;',
  },
  {
    id: 'M14',
    expect: 'red',
    claim: 'only the head side is scanned — DELETING a credential-bearing workflow passes',
    subject: 'guard',
    anchor: "      const sides = [repo.show('base', c.path), repo.show('head', c.path)];",
    replacement: "      const sides = [repo.show('head', c.path)];",
  },
  {
    id: 'M15',
    expect: 'red',
    claim: 'only the base side is scanned — ADDING a secret to a plain workflow passes',
    subject: 'guard',
    anchor: "      const sides = [repo.show('base', c.path), repo.show('head', c.path)];",
    replacement: "      const sides = [repo.show('base', c.path)];",
  },
  {
    id: 'M16',
    expect: 'red',
    claim: 'scripts run by a credential-bearing workflow stop counting as supply chain',
    subject: 'guard',
    anchor: '    runByCredential.has(p) ||',
    replacement: '    false ||',
  },
  {
    id: 'M17',
    expect: 'red',
    claim: 'local composite actions used by a credential-bearing workflow stop counting',
    subject: 'guard',
    anchor:
      "    [...runByCredential].some((r) => r.startsWith('.github/actions/') && p.startsWith(`${r}/`));",
    replacement: '    false;',
  },
  {
    id: 'M18',
    expect: 'red',
    claim:
      'every workflow is treated as credential-bearing — a script only a plain workflow runs fires',
    subject: 'guard',
    anchor: '    .filter((text) => text !== null && workflowHoldsCredential(text));',
    replacement: '    .filter((text) => text !== null);',
  },
  {
    id: 'M19',
    expect: 'red',
    claim: 'trailing prose punctuation is kept — a comment mention `scripts/a.mjs.` never resolves',
    subject: 'guard',
    anchor: "    const p = m[1].replace(/[.,;:]+$/, '');",
    replacement: '    const p = m[1];',
  },
  {
    id: 'M20',
    expect: 'red',
    claim: 'the manifest rule shrinks back to packages/kn-next — grpc/ffi exports stop firing',
    subject: 'guard',
    anchor: 'const PACKAGE_MANIFEST = /^packages\\/[^/]+\\/package\\.json$/;',
    replacement: 'const PACKAGE_MANIFEST = /^packages\\/kn-next\\/package\\.json$/;',
  },
  {
    id: 'M21',
    expect: 'red',
    claim: 'the manifest rule widens to any package.json — scaffold templates fire',
    subject: 'guard',
    anchor: 'const PACKAGE_MANIFEST = /^packages\\/[^/]+\\/package\\.json$/;',
    replacement: 'const PACKAGE_MANIFEST = /(^|\\/)package\\.json$/;',
  },
  {
    id: 'M22',
    expect: 'red',
    claim: 'an UNPARSEABLE manifest passes instead of failing closed',
    subject: 'guard',
    anchor: '    if (before === UNPARSEABLE || after === UNPARSEABLE) {',
    replacement: '    if (false) {',
  },
  {
    id: 'M23',
    expect: 'red',
    claim: 'the fired reason stops saying the manifest was unparseable',
    subject: 'guard',
    anchor:
      "        (unparseable ? ' (a manifest is UNPARSEABLE, so it cannot be proven unchanged)' : ''),",
    replacement: "        (unparseable ? '' : ''),",
  },
  {
    id: 'M24',
    expect: 'red',
    claim: 'an unknown git name-status letter is classified instead of failing',
    subject: 'guard',
    anchor: '  if (!status || !GIT_STATUSES.has(status[0])) {',
    replacement: '  if (!status) {',
  },
  {
    id: 'M25',
    expect: 'red',
    claim: 'a name-status line with no path is classified instead of failing',
    subject: 'guard',
    anchor: '    if (paths.length < n || paths.some((p) => !p)) {',
    replacement: '    if (false) {',
  },
  {
    id: 'M26',
    expect: 'red',
    claim: 'merging content triggers into path triggers drops new paths for an existing id',
    subject: 'guard',
    anchor:
      '    else for (const p of f.paths) if (!existing.paths.includes(p)) existing.paths.push(p);',
    replacement: '    else void existing;',
  },
  {
    id: 'M27',
    expect: 'red',
    claim:
      'static `import \u2026 from` / `export \u2026 from` edges stop being followed \u2014 a transitive release-path import changes unflagged',
    subject: 'guard',
    anchor: '  for (const m of text.matchAll(STATIC_IMPORT)) specs.push(m[2]);',
    replacement: '  void STATIC_IMPORT;',
  },
  {
    id: 'M28',
    expect: 'red',
    claim: 'a literal require()/import() argument stops being followed',
    subject: 'guard',
    anchor: '    if (lit) specs.push(lit[2] ?? lit[3]);',
    replacement: '    if (lit) void lit;',
  },
  {
    id: 'M29',
    expect: 'red',
    claim: 'a NON-LITERAL import()/require() is skipped instead of failing closed',
    subject: 'guard',
    anchor: "    else nonLiteral.push(`${m[1]}(${rest.slice(0, 40).split('\\n')[0].trim()}`);",
    replacement: '    else void m;',
  },
  {
    id: 'M30',
    expect: 'red',
    claim: 'an unresolvable relative import is skipped instead of failing closed',
    subject: 'guard',
    anchor: "        if (target === null) gaps.push(`${file}: unresolvable import '${spec}'`);",
    replacement: '        if (target === null) continue;',
  },
  {
    id: 'M31',
    expect: 'red',
    claim:
      'the import closure is computed but never consulted \u2014 only literally-named scripts fire',
    subject: 'guard',
    anchor: '    closure.has(p) ||',
    replacement: '    false ||',
  },
  {
    id: 'M32',
    expect: 'red',
    claim:
      'files are read from the head tree only \u2014 a DELETED import target is never followed',
    subject: 'guard',
    anchor: "    if (!cache.has(p)) cache.set(p, repo.show('head', p) ?? repo.show('base', p));",
    replacement: "    if (!cache.has(p)) cache.set(p, repo.show('head', p));",
  },
  {
    id: 'M33',
    expect: 'red',
    claim: 'a shell script or action.yml on the release path is not scanned for what IT runs',
    subject: 'guard',
    anchor: '      for (const p of referencedPaths(text)) addNamed(p);',
    replacement: '      void text;',
  },
  {
    id: 'M34',
    expect: 'red',
    claim: 'a local action directory is not listed \u2014 its action.yml is never opened',
    subject: 'guard',
    anchor: '    else for (const f of listUnder(`${p}/`)) add(f); // a local action directory',
    replacement: '    else void listUnder;',
  },
  {
    id: 'M35',
    expect: 'red',
    claim: 'an INCOMPLETE closure stops failing closed \u2014 changed modules pass',
    subject: 'guard',
    anchor: '    } else if (gaps.length > 0 && couldBeOnPath(c.path)) {',
    replacement: '    } else if (false) {',
  },
  {
    id: 'M36',
    expect: 'red',
    claim: 'the fired reason stops naming the edge that made the closure incomplete',
    subject: 'guard',
    anchor:
      "          ? ` (the release-path import closure is INCOMPLETE \u2014 ${gaps.join('; ')} \u2014 so a changed module cannot be proven off it)`",
    replacement: "          ? ' (incomplete)'",
  },
  {
    id: 'M37',
    expect: 'red',
    claim: 'comment lines are scanned \u2014 a JSDoc mention of import() fires on every module PR',
    subject: 'guard',
    anchor: '  const text = stripComments(source);',
    replacement: '  const text = source;',
  },
  {
    id: 'M38',
    expect: 'red',
    claim: 'a rename/copy yields only its destination \u2014 moving a file OUT of scope passes',
    subject: 'guard',
    anchor: '      .slice(0, n)',
    replacement: '      .slice(n - 1, n)',
  },
  {
    id: 'M39',
    expect: 'red',
    claim: 'the CLI reads C-quoted name-status \u2014 a non-ASCII CRD types path never matches',
    subject: 'guard',
    anchor: "git(['diff', '-z', '--name-status',",
    replacement: "git(['diff', '--name-status',",
  },
  {
    id: 'M40',
    expect: 'red',
    claim: 'the NUL-separated (-z) record form is not parsed',
    subject: 'guard',
    anchor: "  if (text.includes('\\0')) {",
    replacement: '  if (false) {',
  },
  {
    id: 'M41',
    expect: 'red',
    claim: 'permissions: write-all stops counting as a credential',
    subject: 'guard',
    anchor: '  if (/permissions\\s*:\\s*[\'"]?write-all/.test(text)) return true;\n',
    replacement: '',
  },
  {
    id: 'M42',
    expect: 'red',
    claim: 'packages/contents/attestations: write stop counting as credentials',
    subject: 'guard',
    anchor:
      '  if (/(?:^|[\\s{,])(?:packages|contents|attestations)\\s*:\\s*[\'"]?write\\b/m.test(text)) return true;\n',
    replacement: '',
  },
  {
    id: 'M43',
    expect: 'red',
    claim: 'toJSON(secrets) stops counting as a credential',
    subject: 'guard',
    anchor: '  if (/toJSON\\s*\\(\\s*secrets\\s*\\)/i.test(text)) return true;\n',
    replacement: '',
  },
  {
    id: 'M44',
    expect: 'red',
    claim: 'the git reader treats a TREE as a file \u2014 a local action directory is never listed',
    subject: 'guard',
    anchor: "      if (type !== 'blob') return null;\n",
    replacement: '',
  },
  {
    id: 'M45',
    expect: 'red',
    claim: 'module files are not scanned for the scripts they NAME (a literal "scripts/…" string)',
    subject: 'guard',
    anchor: '  const paths = [...referencedPaths(text)];',
    replacement: '  const paths = [];',
  },
  {
    id: 'M46',
    expect: 'red',
    claim: 'join()/new URL() path expressions in a module stop becoming edges',
    subject: 'guard',
    anchor: "    if (v?.t === 'path') addPath(v.path);",
    replacement: '    void v;',
  },
  {
    id: 'M47',
    expect: 'red',
    claim: 'the paths a module names are computed but never added to the closure',
    subject: 'guard',
    anchor: '      for (const p of edges.paths) addReferenced(p);',
    replacement: '      void edges.paths;',
  },
  {
    id: 'M48',
    expect: 'red',
    claim:
      'module-named edges leave the scripts/ + actions scope — a script READING package.json makes it fire',
    subject: 'guard',
    anchor: '    if (!/^(?:scripts|\\.github\\/actions)\\//.test(p)) return;\n',
    replacement: '',
  },
  {
    id: 'M49',
    expect: 'red',
    claim: 'a module-named DIRECTORY (join(ROOT, "scripts", "lib")) pulls in every file under it',
    subject: 'guard',
    anchor:
      "    if (read(p) !== null) add(p);\n    else if (/^\\.github\\/actions\\/[^/]+\\/?$/.test(p)) addNamed(p.replace(/\\/$/, ''));",
    replacement: '    addNamed(p);',
  },
  {
    id: 'M50',
    expect: 'red',
    claim: 'createRequire stops being a gap',
    subject: 'guard',
    anchor:
      "    gaps.push('createRequire (a require() whose specifiers cannot be read statically)');",
    replacement: '    void gaps;',
  },
  {
    id: 'M51',
    expect: 'red',
    claim: 'an unresolvable child-process call is computed but never recorded as a gap',
    subject: 'guard',
    anchor:
      '    if (why) gaps.push(`${call.name}(…) at line ${lineOf(text, call.index)} — ${why}`);',
    replacement: '    void why;',
  },
  {
    id: 'M52',
    expect: 'red',
    claim: 'an ALIASED child_process import (`execFileSync as run`) is not recognised',
    subject: 'guard',
    anchor:
      '      const [orig, alias] = part.trim().split(/\\s+as\\s+/);\n      if (CP_FUNCS.has(orig)) local.set(alias ?? orig, orig);',
    replacement:
      '      const [orig] = part.trim().split(/\\s+as\\s+/);\n      if (CP_FUNCS.has(orig)) local.set(orig, orig);',
  },
  {
    id: 'M53',
    expect: 'red',
    claim: 'a destructured require of child_process (`{ fork: f }`) is not recognised',
    subject: 'guard',
    anchor: '      const [orig, alias] = part.trim().split(/\\s*:\\s*/);',
    replacement: '      const [orig, alias] = [part.trim(), undefined];',
  },
  {
    id: 'M54',
    expect: 'red',
    claim: 'a namespace binding (`cp.exec`, `cp.fork`) is not recognised',
    subject: 'guard',
    anchor: '    ns.add(m[1] ?? m[2]);',
    replacement: '    void m;',
  },
  {
    id: 'M55',
    expect: 'red',
    claim: 'Bun.spawn is not read as a command ARRAY — a literal one becomes a false gap',
    subject: 'guard',
    anchor: "    } else if (m[1] === 'Bun' && /^spawn(?:Sync)?$/.test(m[2])) {",
    replacement: '    } else if (false) {',
  },
  {
    id: 'M56',
    expect: 'red',
    claim: 'calls are found in un-blanked text — a message naming spawnSync( is read as a call',
    subject: 'guard',
    anchor: '  const code = stripComments(source, { blankStrings: true });',
    replacement: '  const code = text;',
  },
  {
    id: 'M57',
    expect: 'red',
    claim: "an interpreter's non-literal SCRIPT argument passes",
    subject: 'guard',
    anchor: "    return isPathLike(v) ? null : fail('the script argument is not a literal path');",
    replacement: '    return null;',
  },
  {
    id: 'M58',
    expect: 'red',
    claim: 'a non-literal COMMAND passes',
    subject: 'guard',
    anchor: "    return fail('the command is not a literal');",
    replacement: '    return null;',
  },
  {
    id: 'M59',
    expect: 'red',
    claim: 'interpreter arguments that are not a literal array pass',
    subject: 'guard',
    anchor:
      "  if (rest === undefined) return fail('the interpreter arguments are not a literal array');",
    replacement: '  if (rest === undefined) return null;',
  },
  {
    id: 'M60',
    expect: 'red',
    claim: 'a non-literal spread before the script position passes',
    subject: 'guard',
    anchor: "    if (e === null) return fail('the interpreter arguments spread a non-literal');",
    replacement: '    if (e === null) return null;',
  },
  {
    id: 'M61',
    expect: 'red',
    claim: 'a non-literal exec()/execSync() shell command passes',
    subject: 'guard',
    anchor: "    return isStr(v) ? null : fail('the shell command is not a literal');",
    replacement: '    return null;',
  },
  {
    id: 'M62',
    expect: 'red',
    claim: 'a non-literal fork() module passes',
    subject: 'guard',
    anchor: "      : fail('the forked module is not a literal path');",
    replacement: '      : null;',
  },
  {
    id: 'M63',
    expect: 'red',
    claim: 'an EXPORTED wrapper is resolved from same-file call sites only',
    subject: 'guard',
    anchor: '  if (!fn || fn.params.length === 0 || fn.exported) return why;',
    replacement: '  if (!fn || fn.params.length === 0) return why;',
  },
  {
    id: 'M64',
    expect: 'red',
    claim: 'wrapper parameters are never resolved through call sites — every wrapper is a gap',
    subject: 'guard',
    anchor: '  const fail = (what) => paramRetry(ctx, call, depth, what);',
    replacement: '  const fail = (what) => what;',
  },
  {
    id: 'M65',
    expect: 'red',
    claim: 'a wrapper call site with a non-literal script is skipped instead of failing closed',
    subject: 'guard',
    anchor: '    if (g) return `${g} (via ${fn.name}() at line ${lineOf(ctx.text, open)})`;',
    replacement: '    if (g) continue;',
  },
  {
    id: 'M66',
    expect: 'red',
    claim: 'a wrapper that escapes as a value is resolved from its visible call sites only',
    subject: 'guard',
    anchor: '    if (!paren) return `${why} (wrapper ${fn.name} escapes as a value)`;',
    replacement: '    if (!paren) continue;',
  },
  {
    id: 'M67',
    expect: 'red',
    claim: 'a runner object (`runner.command`) is never resolved through its factory',
    subject: 'guard',
    anchor: '  if (member) return resolveMember(ctx, member[1], member[2], at, depth);',
    replacement: '  if (member) return null;',
  },
  {
    id: 'M68',
    expect: 'red',
    claim: 'a factory with a non-object return is resolved from its object returns only',
    subject: 'guard',
    anchor: '    if (m[1] === undefined) return [];',
    replacement: '    if (m[1] === undefined) continue;',
  },
  {
    id: 'M69',
    expect: 'red',
    claim:
      'an env override with a literal default (`KNEXT_BUN ?? "bun"`) is not resolved — bun-test gaps',
    subject: 'guard',
    anchor: '  if (fallback) return commandValue(ctx, fallback[1], at, depth + 1);',
    replacement: '  if (fallback) return null;',
  },
  {
    id: 'M70',
    expect: 'red',
    claim: 'an argv flag parser with a literal default is not resolved — bun-test gaps',
    subject: 'guard',
    anchor:
      '    if (readsArgv && returnsDefault) return commandValue(ctx, args[1], at, depth + 1);',
    replacement: '    if (readsArgv && returnsDefault) return null;',
  },
  {
    id: 'M71',
    expect: 'red',
    claim: 'the override shape is accepted in the SCRIPT position too — node [env ?? lit] passes',
    subject: 'guard',
    anchor: '    const v = resolveValue(e.ctx, e.expr, e.at, 0);',
    replacement: '    const v = commandValue(e.ctx, e.expr, e.at, 0);',
  },
  {
    id: 'M72',
    expect: 'red',
    claim: 'comments are stripped by whole LINE again — `/* c */ import …` hides the import',
    subject: 'guard',
    anchor: '  const text = stripComments(source);',
    replacement: "  const text = source.replace(/^[ \\t]*(?:\\/\\/|\\/\\*|\\*).*$/gm, '');",
  },
  {
    id: 'M73',
    expect: 'red',
    claim: 'regex literals are not recognised — `/https?:\\/\\//` swallows the rest of the line',
    subject: 'guard',
    anchor: "    } else if (c === '/' && regexMayStart() && scanRegex()) {",
    replacement: '    } else if (false) {',
  },
  {
    id: 'M74',
    expect: 'red',
    claim: "strings are not recognised — a '/*' inside one opens a comment",
    subject: 'guard',
    anchor: '    } else if (c === \'"\' || c === "\'") {\n      scanString(c);',
    replacement: '    } else if (false) {\n      scanString(c);',
  },
  {
    id: 'M75',
    expect: 'red',
    claim: 'a non-literal shell `source`/`.` is not a gap',
    subject: 'guard',
    anchor: '    if (/[$`]/.test(m[1])) gaps.push(`non-literal shell source ${m[1]}`);',
    replacement: '    void m;',
  },
  {
    id: 'M76',
    expect: 'red',
    claim: 'shell source gaps are computed but never recorded',
    subject: 'guard',
    anchor: '      for (const g of shellSourceGaps(text)) gaps.push(`${file}: ${g}`);',
    replacement: '      void shellSourceGaps;',
  },
  {
    id: 'M77',
    expect: 'red',
    claim: 'with a gap, a changed shell script under scripts/ is not covered by the fallback',
    subject: 'guard',
    anchor: "  p.startsWith('scripts/') ||",
    replacement: '  false ||',
  },
  {
    id: 'M78',
    expect: 'red',
    claim: 'new URL("./x", import.meta.url) does not resolve relative to the module',
    subject: 'guard',
    anchor: '    return repoPath(posix.join(posix.dirname(ctx.file), spec.vals[0]));',
    replacement: '    return null;',
  },
  {
    id: 'M79',
    expect: 'red',
    claim: 'join(__dirname, …) does not resolve relative to the module',
    subject: 'guard',
    anchor: "    if (base?.t === 'path') return repoPath(posix.join(base.path, ...segs));",
    replacement: "    if (base?.t === 'path') return null;",
  },
  {
    id: 'M80',
    expect: 'red',
    claim: 'an identifier is never resolved through its const binding',
    subject: 'guard',
    anchor: '  if (bindings.length === 0) return null;',
    replacement: '  return null;',
  },
  {
    id: 'M81',
    expect: 'red',
    claim: 'join(REPO_ROOT, "scripts", …) — an unknown base naming scripts/ — is not resolved',
    subject: 'guard',
    anchor: '    if (segs.length > 0 && /^(?:scripts|\\.github)(?:\\/|$)/.test(segs[0])) {',
    replacement: '    if (false) {',
  },
];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    guard: 'scripts/check-escalation-triggers.mjs',
  },
});

console.log(`=== mutation proof: ${SPEC} (escalation-trigger scope, #2388) ===`);
prover.preflight(MUTATIONS);
declareMutations(MUTATIONS.length);
prover.baseline();
prover.proveCanSeeRed({
  subject: 'guard',
  anchor: "    match: (p) => p.startsWith('crates/'),",
  replacement: '    match: (p) => false && p,',
});

console.log('\n=== mutations ===');
for (const m of MUTATIONS) {
  prover.run(m);
  recordMutation();
}
prover.finish(MUTATIONS.length);

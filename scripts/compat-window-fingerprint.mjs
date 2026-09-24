#!/usr/bin/env node
/**
 * compat-window-fingerprint.mjs — the COMPAT-WINDOW FINGERPRINT (S1, #545).
 *
 * v1.0 is gated on "14 consecutive scheduled node-lane runs with the harness
 * unchanged". Nothing recorded what "unchanged" meant, so the guarantee was
 * unfalsifiable: the window would be policed by a human reading a log they also
 * wrote. This script makes it checkable — it emits a deterministic digest over
 * the FROZEN SET, recorded per scheduled run, so a mid-window change is
 * detectable from the log rather than from memory.
 *
 * THE FROZEN SET (docs/adr/0039, decision D-1 of docs/SPRINT_2.md) has two
 * halves, and both must be in the digest:
 *
 *   harness — .github/workflows/test-e2e-deploy.yml, the scripts/e2e-* lifecycle
 *             scripts the reference harness shells out to, and the deploy-tests
 *             manifest that selects what runs.
 *   packed  — the `@getknext/*` tarballs the workflow packs and installs into
 *             every fixture, each covered IN FULL. This is THE ADAPTER UNDER
 *             TEST. A fingerprint that covers only the harness would go
 *             unchanged across a night that tested different code — the exact
 *             silent failure this exists to prevent — so an empty or
 *             non-@getknext packed set is a hard error, never a quietly-omitted
 *             component.
 *
 * "IN FULL" is literal and load-bearing: `dist/cli/**` and the shared
 * `dist/chunk-*.js` are INSIDE the digest. `packages/kn-next/package.json` has
 * `files: ["dist"]` and `bin: ./dist/cli/kn-next.js`, so the CLI ships in the
 * tarball under test, and 8 of the 9 chunks `dist/cli/*` references are shared
 * with non-CLI dist files — a path-prefix filter could not separate them even if
 * we wanted one, because a CLI change perturbing a shared chunk rotates its
 * hashed filename and rewrites import specifiers in adapter entries too.
 * A CLI change therefore RESETS the window. What
 * `scripts/adapter-import-closure.mjs` proves is a different claim — that the
 * adapter never *executes* CLI code, which makes `src/cli/` review-safe, not
 * window-safe. Do not conflate the two (ADR-0039, corrected on PR #574).
 *
 * SUITE PROVENANCE is RECORDED, NOT FROZEN. `NEXTJS_REF` is a git TAG resolved
 * fresh each night and that checkout supplies `run-tests.js` and the suite
 * itself, so a retag moves what "green" means under a stable fingerprint. The
 * resolved commit + the `next` tarball digest are written into the artifact and
 * deliberately kept OUT of the digest: a legitimate suite bump should be a
 * visible decision, not a silent window reset.
 *
 * SCANNED, NOT ENUMERATED. The roots below are directories + patterns, not a
 * file list: a newly-added `scripts/e2e-*.sh`, a second manifest lane, or a
 * fourth packed package moves the digest with no edit here. An enumerated list
 * is how the second file gets missed.
 *
 * NOT in the frozen set: `scripts/compat-smoke.mjs` and `ci.yml` — a DIFFERENT
 * gate, PR-time and app-side. Confusing the two is the likeliest way to widen
 * this scope by accident.
 *
 * PER-CELL WORKFLOW ENTRY (#1294). The harness has exactly one `harness` file
 * entry — the workflow that EXECUTED — but which *file* that is depends on the
 * lane: the node and bun (turbopack) cells run from `test-e2e-deploy.yml`, the
 * vinext cells from `compat-vinext.yml`. Before this, the entry was hardcoded
 * to `test-e2e-deploy.yml` for every lane, so an edit to `compat-vinext.yml`
 * never moved the vinext cells' fingerprint — the changed harness could carry
 * a 14-night window, which violates ADR-0056 D3. `--lane` selects the entry
 * from the ONE declared table (`CREDENTIAL_CELLS.workflowFile`,
 * `scripts/compat-window-audit.mjs`), so a new cell or a moved workflow file
 * cannot silently keep hashing the wrong bytes. Unset, `--lane` defaults to
 * `node` (`CREDENTIAL_LANE`) — the pre-#1294 behaviour, byte-identical.
 *
 * Usage:
 *   node scripts/compat-window-fingerprint.mjs \
 *     --repo-root . --tarballs-dir "$GITHUB_WORKSPACE/knext-tarballs" \
 *     [--lane node|bun|bun-vinext|...] \
 *     [--next-js-dir next.js] [--next-tarball next-prebuilt/next.tgz] \
 *     [--next-ref v16.2.0] \
 *     [--workflow-file knext-executing/.github/workflows/test-e2e-deploy.yml] \
 *     [--out compat-window-fingerprint.json] [--json] [--files]
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
// A REAL parser, not a hand-rolled tokenizer (#1294 round 5). Three
// successive rounds each found a new hole in a hand-written JS tokenizer
// (round 3: raw regex over untokenized source; round 4: no regex-literal
// state, then a staleness bug in the FIX for that; round 5: keywords like
// `return` treated as operands, and no template-literal awareness) — the
// review named it directly as the successive-round regression class this
// repo's own workflow docs warn about. `typescript` is already a root
// devDependency (used the same way by scripts/lib/parse-validity.mjs,
// executable-lines.mjs, continuation-attribution.mjs) and is resolved the
// same way here: a plain static import, so a missing package fails the
// whole module load loudly (Node's own `ERR_MODULE_NOT_FOUND`) rather than
// silently guessing — the workflow install step order is verified in
// tests/compat-window-fingerprint.test.ts and this file's own header notes.
import ts from 'typescript';
import { CREDENTIAL_CELLS, CREDENTIAL_LANE } from './compat-window-audit.mjs';

export const SCHEMA = 'knext.compat-window-fingerprint/v1';

/**
 * The frozen HARNESS roots that are the SAME for every cell — the shared half
 * of the digest (ADR-0056 D2 note: narrowing this per cell is an ADR-0039
 * scope change, left to the founder, not decided here). Each `dir` root is
 * SCANNED (recursively) and filtered by `match`, so the set grows with the
 * tree rather than with edits to this file. The per-lane WORKFLOW entry is
 * NOT here — see `workflowRootForLane` below (#1294).
 *
 * @type {{ kind: 'file' | 'dir', path: string, match?: RegExp }[]}
 */
export const HARNESS_ROOTS = [
  // The lifecycle scripts the reference harness invokes
  // (NEXT_TEST_DEPLOY_SCRIPT_PATH and friends) plus the preflight/summary/ledger
  // helpers the workflow runs around them. These are the ENTRY POINTS for the
  // import/source closure below (#1294 round 2) — not the whole frozen set by
  // themselves.
  { kind: 'dir', path: 'scripts', match: /^e2e-[^/]*\.(sh|mjs|cjs|js)$/, isClosureEntry: true },
  // The deploy-tests manifest(s): the exclude ledger that decides what the
  // night actually selected. A second lane manifest is picked up automatically.
  { kind: 'dir', path: 'test', match: /^deploy-tests-manifest\.[^/]*\.json$/ },
];

/**
 * Local (`./…`/`../…`) import specifiers a JS file ACTUALLY imports, via a
 * REAL parser — never a hand-rolled tokenizer (#1294 round 5).
 *
 * Rounds 3 and 4 each found a new hole in a hand-written JS tokenizer: round
 * 3, a raw regex over UNtokenized source (a comment mentioning import-like
 * text hard-errored the whole fingerprint); round 4, no regex-literal state
 * at all (a regex containing a quote character got misread as a string
 * start), then a staleness bug in the FIX for that. Round 5's review named
 * the pattern directly — "each round has found a new hole in the hand-rolled
 * tokenizer, which is the successive-round regression class" — and found two
 * more: `isRegexPosition` treated JS KEYWORDS (`return`, `typeof`, …) as
 * operands (so `return /'/.test(s)` mis-scanned exactly like the round-4
 * bug), and nested TEMPLATE LITERAL interpolation (`` `${a ? `'` : ""}` ``)
 * was never modelled at all. A hand tokenizer cannot be patched into
 * soundness one review at a time; a REAL parser handles all of this by
 * construction, because it is not guessing.
 *
 * Extracts specifiers from: `import … from '…'`, `export … from '…'`, bare
 * `import '…'`, `require('…')`, and dynamic `import('…')` — anywhere in the
 * file, at any nesting depth, via a full AST walk (`ts.forEachChild`).
 *
 * FAILS CLOSED on a NON-LITERAL specifier (round 5: "fail closed on
 * non-literal specifiers that could be relative"): `require(x)`,
 * `import(\`./${x}\`)`, `require(cond ? './a' : './b')` are all hard errors.
 * A computed specifier MIGHT be relative — silently skipping it (as
 * `ts.isStringLiteralLike` naturally would, by just finding no specs there)
 * would reopen exactly the "silently unfrozen dependency" failure mode this
 * whole mechanism exists to close, just moved one layer up. Deliberately
 * scoped to bare `require(`/`import(` — `require.resolve(x)` is a RESOLVE
 * call, not a module load that adds a dependency to this closure (and the
 * real corpus already has one: `scripts/e2e-preflight.mjs`'s
 * `require.resolve(ADAPTER_SUBPATH)`, a non-literal argument that must NOT
 * trip this check).
 *
 * @param {string} src
 * @param {string} absPath used for the parser's `fileName` and error text
 * @returns {string[]} every relative (`./…`/`../…`) specifier found
 */
function jsLocalImportSpecifiers(src, absPath) {
  // `ts.createSourceFile` is ERROR-TOLERANT by design (it powers editor
  // tooling, which must produce SOME AST for a file mid-edit) — an
  // unterminated string or regex does not throw, it recovers a best-effort
  // parse. That is the right behaviour for an editor and the wrong one here:
  // silently walking a recovered-but-wrong AST is exactly the "guess instead
  // of refusing" failure mode this whole mechanism exists to close. So parse
  // TWICE: once via `transpileModule` (the same syntax-only check
  // `scripts/lib/parse-validity.mjs` already uses elsewhere in this repo)
  // purely to FAIL CLOSED on any syntax error, then the real walk below.
  const syntaxErrors = ts
    .transpileModule(src, {
      reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
    })
    .diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (syntaxErrors.length > 0) {
    const first = ts.flattenDiagnosticMessageText(syntaxErrors[0].messageText, ' ');
    throw new Error(
      `compat-window fingerprint: ${absPath} does not parse as JavaScript: ${first}. A file that cannot be parsed cannot be scanned for dependencies — refusing to guess (#1294 round 5).`,
    );
  }

  const sourceFile = ts.createSourceFile(
    absPath,
    src,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.JS,
  );

  /** @type {string[]} */
  const specs = [];

  const isBareRequireCall = (node) =>
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'require';
  const isDynamicImportCall = (node) =>
    ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;

  /** @param {ts.Node} node @param {ts.Node} callOrDeclNode */
  const addSpecifier = (node, callOrDeclNode) => {
    if (ts.isStringLiteralLike(node)) {
      specs.push(node.text);
      return;
    }
    const { line: lineNumber } = sourceFile.getLineAndCharacterOfPosition(
      callOrDeclNode.getStart(sourceFile),
    );
    throw new Error(
      `compat-window fingerprint: ${absPath}:${lineNumber + 1} references a module with a NON-LITERAL specifier. It might be a relative path, and guessing whether it is one is exactly what this refuses to do — rewrite it as a literal string, or hand-declare the dependency (CREDENTIAL_CELLS.extraFiles) (#1294 round 5).`,
    );
  };

  /** @param {ts.Node} node */
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      addSpecifier(node.moduleSpecifier, node);
    } else if (isBareRequireCall(node) || isDynamicImportCall(node)) {
      const arg = /** @type {ts.CallExpression} */ (node).arguments[0];
      if (arg) {
        addSpecifier(arg, node);
      } else {
        const { line: lineNumber } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        throw new Error(
          `compat-window fingerprint: ${absPath}:${lineNumber + 1} calls ${isBareRequireCall(node) ? 'require()' : 'import()'} with no argument — refusing to guess (#1294 round 5).`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specs.filter((raw) => /^\.\.?\//.test(raw));
}

/**
 * Extract this file's DIRECT local dependencies — never third-party or
 * `node:`/bare-specifier imports, only files inside the repo (#1294 round 2).
 *
 * WHY A CLOSURE, NOT A DIRECTORY PATTERN: `scripts/e2e-preflight.mjs` imports
 * `./lib/knext-closure.mjs` and `./lib/workspace-protocol.mjs` — neither
 * carries the `e2e-` prefix a directory-pattern root (`scripts/lib` matched
 * only `e2e-*`) would need to see them, so editing either left the fingerprint
 * unchanged: the same gap class the original #1294 fix closed for
 * `e2e-state-snapshot.sh`, just one level less naming-convention-dependent.
 * SCANNING is only honest when it reaches everything a script actually
 * executes, not everything that happens to be named like it does.
 *
 * @param {string} absPath
 * @returns {string[]} resolved absolute paths of files this one directly
 *   `import`s / `require`s / dynamic-`import()`s (JS) or `source`s / `.`s (sh)
 */
function directLocalDeps(absPath) {
  const src = readFileSync(absPath, 'utf8');
  const dir = dirname(absPath);
  /** @type {string[]} */
  const specs = [];

  if (/\.(mjs|cjs|js)$/.test(absPath)) {
    specs.push(...jsLocalImportSpecifiers(src, absPath));
  } else {
    // Shell: `. "${SCRIPT_DIR}/lib/x.sh"` / `source "${SCRIPT_DIR}/lib/x.sh"`.
    // The `${VAR}/` prefix is always the SCRIPT'S OWN directory by convention
    // here (`SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"`), so
    // it resolves the same as a relative import — strip it, resolve from `dir`.
    const shPatterns = [
      /^\s*\.\s+"\$\{[A-Z_]+\}\/([^"]+)"/gm,
      /^\s*source\s+"\$\{[A-Z_]+\}\/([^"]+)"/gm,
    ];
    for (const re of shPatterns) {
      for (const m of src.matchAll(re)) specs.push(`./${m[1]}`);
    }
  }

  /** @type {string[]} */
  const resolved = [];
  for (const spec of specs) {
    const base = join(dir, spec);
    const candidates = /\.[a-z]+$/.test(spec)
      ? [base]
      : [base, `${base}.mjs`, `${base}.js`, `${base}.cjs`];
    const hit = candidates.find((c) => existsSync(c));
    if (!hit) {
      throw new Error(
        `compat-window fingerprint: ${relative(process.cwd(), absPath)} references "${spec}", which does not resolve to a real file. A dependency the frozen set cannot see is a hole in the freeze scope (#1294).`,
      );
    }
    resolved.push(resolve(hit));
  }
  return resolved;
}

/**
 * BFS the import/source closure from a set of entry files (#1294 round 2).
 * Returns every file TRANSITIVELY reached, entries included, deduplicated.
 *
 * @param {string[]} entryAbsPaths
 * @returns {string[]} absolute paths, entries + everything they reach
 */
function closureFrom(entryAbsPaths) {
  const seen = new Set(entryAbsPaths);
  const queue = [...entryAbsPaths];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const dep of directLocalDeps(current)) {
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  return [...seen];
}

/**
 * The lane's frozen WORKFLOW file, `.github/workflows/<basename>` — the one
 * `harness` entry whose SOURCE is per-cell (#1294). Reads the single declared
 * table (`CREDENTIAL_CELLS`, `scripts/compat-window-audit.mjs`) rather than
 * re-declaring the mapping here, so a cell added there cannot be forgotten
 * here. An unknown lane, or a known lane with no workflow wired yet
 * (`workflowFile: null` — node×vinext today), is a hard error: silently
 * falling back to SOME workflow would fingerprint bytes that did not run.
 *
 * @param {string} lane
 * @returns {{ kind: 'file', path: string }}
 */
export function workflowRootForLane(lane) {
  const cell = CREDENTIAL_CELLS.find((c) => c.lane === lane);
  if (!cell) {
    throw new Error(
      `compat-window fingerprint: unknown lane "${lane}". Known lanes: ${CREDENTIAL_CELLS.map((c) => c.lane).join(', ')}.`,
    );
  }
  if (!cell.workflowFile) {
    throw new Error(
      `compat-window fingerprint: lane "${lane}" has no workflowFile wired in CREDENTIAL_CELLS yet — it cannot be fingerprinted until its credential workflow lands.`,
    );
  }
  return { kind: 'file', path: `.github/workflows/${cell.workflowFile}` };
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Recursively list files under `dir`, as paths relative to `dir`, sorted. */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  const visit = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = join(current, entry.name);
      if (entry.isDirectory()) visit(abs, rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  visit(dir, '');
  return out.sort();
}

/**
 * One digest line per frozen file. The executable bit is part of the identity:
 * a lifecycle script that loses `+x` changes what the night ran.
 */
function line(component, path, absolute) {
  const mode = statSync(absolute).mode & 0o111 ? 'x' : '-';
  return `${component}\t${path}\t${mode}\t${sha256(readFileSync(absolute))}`;
}

/**
 * @param {string} repoRoot
 * @param {string} lane — selects the per-cell workflow entry (#1294),
 *   `workflowRootForLane`.
 * @param {{ workflowFile?: string | null }} [opts]
 *   `workflowFile` — ADR-0039 Amendment 1 (ADR-0056). A credential night checks
 *   out an RC tag, but GitHub runs the DEFAULT BRANCH's workflow file. The
 *   workflow entry must hash the bytes that ran, so they are read from here (a
 *   sparse checkout of `github.workflow_sha`). The entry's path LABEL is
 *   unchanged, so identical bytes give a byte-identical digest. A given but
 *   missing file is a hard error, never a fallback to the checkout's copy.
 */
function collectHarness(repoRoot, lane, opts = {}) {
  const roots = [workflowRootForLane(lane), ...HARNESS_ROOTS];
  /** @type {{ component: string, path: string, line: string }[]} */
  const entries = [];
  const addedAbs = new Set();
  /** @type {string[]} entry points for the import/source closure (#1294 round 2) */
  const closureEntries = [];

  const addEntry = (path, abs) => {
    if (addedAbs.has(abs)) return;
    addedAbs.add(abs);
    entries.push({ component: 'harness', path, line: line('harness', path, abs) });
  };

  for (const root of roots) {
    const override = root.kind === 'file' && opts.workflowFile ? resolve(opts.workflowFile) : null;
    const abs = override ?? resolve(repoRoot, root.path);
    if (root.kind === 'file') {
      if (!existsSync(abs)) {
        throw new Error(
          override
            ? `compat-window fingerprint: --workflow-file ${override} is missing. The executing workflow is part of the frozen set; refusing to fall back to the checkout's copy, which did not run (docs/adr/0039 Amendment 1).`
            : `compat-window fingerprint: frozen harness file ${root.path} is missing. A root that resolves to nothing silently shrinks the frozen set — fix the path or amend the freeze scope (docs/adr/0039).`,
        );
      }
      addEntry(root.path, abs);
      continue;
    }
    if (!existsSync(abs)) {
      throw new Error(`compat-window fingerprint: frozen harness root ${root.path}/ is missing`);
    }
    const matched = walk(abs).filter((rel) => (root.match ? root.match.test(rel) : true));
    if (matched.length === 0) {
      throw new Error(
        `compat-window fingerprint: frozen harness root ${root.path}/ matched ZERO files for ${root.match}. An empty root is a fingerprint over nothing.`,
      );
    }
    for (const rel of matched) {
      const fileAbs = resolve(join(abs, rel));
      addEntry(`${root.path}/${rel}`, fileAbs);
      if (root.isClosureEntry) closureEntries.push(fileAbs);
    }
  }

  // #1294 round 3: the DECLARED extras — files the lane's workflow EXECUTES
  // via subprocess (`node knext/scripts/X.mjs` in a `run:` step) or READS
  // directly (a JSON pin), which the import/source closure cannot discover
  // on its own because nothing in the top-level closure-entry scripts
  // references them. `CREDENTIAL_CELLS[lane].extraFiles` is the one declared
  // table this reads. Fed into `closureEntries` BELOW, not added directly:
  // round 4 found that a declared extra can itself import something —
  // `compat-run-ledger.mjs` imports `./compat-credential-ref.mjs` — and a
  // direct `addEntry` (no closure walk) left that transitive import unfrozen
  // even on lanes that declare the ledger script but not the credential-ref
  // one. An extra is exactly as much an entry point as a top-level `e2e-*`
  // script, so it gets the SAME treatment: one closure walk, not two
  // half-mechanisms with different reach.
  const cell = CREDENTIAL_CELLS.find((c) => c.lane === lane);
  for (const relPath of cell?.extraFiles ?? []) {
    const abs = resolve(repoRoot, relPath);
    if (!existsSync(abs)) {
      throw new Error(
        `compat-window fingerprint: lane "${lane}" declares extraFiles entry "${relPath}" (CREDENTIAL_CELLS, scripts/compat-window-audit.mjs), which does not exist. A declared-but-missing file is a hole in the freeze scope (#1294).`,
      );
    }
    addEntry(relPath, abs);
    closureEntries.push(abs);
  }

  // #1294 round 2 (round 4: now ALSO covers the extras above): follow every
  // entry point's LOCAL import/require/import() (JS) and source/`.` (sh)
  // chain, transitively, and freeze whatever it reaches — regardless of
  // filename convention. A directory-pattern root only sees files whose NAME
  // matches; a closure sees everything a script actually EXECUTES, which is
  // the honest claim "the harness is frozen" requires.
  // `scripts/e2e-preflight.mjs` importing `./lib/knext-closure.mjs` (no
  // `e2e-` prefix) is exactly the shape round 2 closed; `compat-run-
  // ledger.mjs` importing `./compat-credential-ref.mjs` (a declared EXTRA
  // importing another file) is the round-4 shape.
  for (const abs of closureFrom(closureEntries)) {
    addEntry(relative(repoRoot, abs), abs);
  }

  return entries;
}

function collectPacked(tarballsDir) {
  const dir = resolve(tarballsDir);
  if (!existsSync(dir)) {
    throw new Error(`compat-window fingerprint: --tarballs-dir ${tarballsDir} does not exist`);
  }
  const tarballs = readdirSync(dir)
    .filter((f) => f.endsWith('.tgz'))
    .sort();
  if (tarballs.length === 0) {
    throw new Error(
      `compat-window fingerprint: no *.tgz in ${tarballsDir}. The packed @getknext/* closure IS the adapter under test; a fingerprint that omits it would stay identical across a night that ran different code. Refusing to emit one.`,
    );
  }

  /** @type {{ component: string, path: string, line: string }[]} */
  const entries = [];
  /** @type {{ tarball: string, name: string, version: string, files: number, sha256: string }[]} */
  const packages = [];

  for (const tarball of tarballs) {
    const stage = mkdtempSync(join(tmpdir(), 'knext-cwfp-'));
    try {
      // Hash the tarball's CONTENTS, never its bytes: gzip embeds an mtime and
      // pnpm pack is not bit-reproducible, so a byte digest would churn nightly
      // and the window would never hold for reasons that are not code changes.
      execFileSync('tar', ['xzf', join(dir, tarball), '-C', stage]);
      const pkgRoot = existsSync(join(stage, 'package')) ? join(stage, 'package') : stage;
      const manifestPath = join(pkgRoot, 'package.json');
      if (!existsSync(manifestPath)) {
        throw new Error(
          `compat-window fingerprint: ${tarball} has no package.json — not an npm tarball`,
        );
      }
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@getknext/')) {
        throw new Error(
          `compat-window fingerprint: ${tarball} packs "${manifest.name}", not an @getknext/* package. The packed set is the adapter under test; a foreign tarball means the pack step drifted.`,
        );
      }

      const files = walk(pkgRoot);
      const pkgLines = files.map((rel) => {
        const path = `${manifest.name}@${manifest.version}/${rel}`;
        return { component: 'packed', path, line: line('packed', path, join(pkgRoot, rel)) };
      });
      entries.push(...pkgLines);
      packages.push({
        tarball,
        name: manifest.name,
        version: manifest.version,
        files: files.length,
        sha256: sha256(pkgLines.map((e) => e.line).join('\n')),
      });
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
  return { entries, packages };
}

/**
 * Suite provenance — RECORDED, NEVER DIGESTED.
 *
 * The nightly resolves `NEXTJS_REF` (a git TAG) fresh, and that checkout is the
 * compat suite itself. Recording the resolved commit + the `next` tarball digest
 * makes a retag visible in the log; folding them into the fingerprint would make
 * every legitimate suite bump a silent window reset instead of a decision.
 *
 * A SUPPLIED path that cannot be read is a hard error — recording `null` for a
 * path someone asked us to record would be a fingerprint that quietly forgets.
 *
 * @param {{ nextJsDir?: string | null, nextTarball?: string | null, nextRef?: string | null }} options
 */
function collectSuiteProvenance({ nextJsDir, nextTarball, nextRef }) {
  /** @type {string | null} */
  let nextJsCommit = null;
  if (nextJsDir) {
    if (!existsSync(nextJsDir)) {
      throw new Error(`compat-window fingerprint: --next-js-dir ${nextJsDir} does not exist`);
    }
    nextJsCommit = execFileSync('git', ['-C', nextJsDir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  }

  /** @type {string | null} */
  let nextTarballSha256 = null;
  /** @type {number | null} */
  let nextTarballBytes = null;
  if (nextTarball) {
    if (!existsSync(nextTarball)) {
      throw new Error(`compat-window fingerprint: --next-tarball ${nextTarball} does not exist`);
    }
    const bytes = readFileSync(nextTarball);
    nextTarballSha256 = sha256(bytes);
    nextTarballBytes = bytes.length;
  }

  return {
    // Stated in the artifact so a reader cannot mistake these for frozen fields.
    frozen: false,
    note: 'Recorded, not frozen: a suite retag or a next-tarball change does NOT reset the 14-night window. It is a visible decision, made here rather than silently.',
    nextRef: nextRef ?? null,
    nextJsCommit,
    nextTarballSha256,
    nextTarballBytes,
  };
}

/**
 * The observed-runtime component (#1147, window-bun-lane.md rule 4).
 *
 * The bun lane's result is BUILD-DEPENDENT: Bun ≤1.3.14 is deterministically red
 * on the documented edge-fetch / not-found-invariant files, stable 1.4.0 is
 * green, and a canary that ALSO reported `1.4.0` was red — so the version STRING
 * is not a sufficient freeze key. The frozen key is the observed `bun --version`
 * TOGETHER WITH `bun --revision` (the build hash). Folding it into the digest
 * makes any Bun build move restart the streak via the audit's rule-1
 * (fingerprint-identical) check, rather than a human eyeballing it.
 *
 * CRITICAL: this is STRICTLY ADDITIVE. The node lane passes no runtime identity,
 * so `runtimeVersion` and `runtimeRevision` are both absent there, `runtime` is
 * `null`, and the digest string is byte-identical to the pre-#1147 formula — the
 * live node streak is never reset by this code path.
 *
 * @param {{ runtimeVersion?: string | null, runtimeRevision?: string | null }} options
 * @returns {string | null} a `sha256:…` component, or null when no identity was supplied
 */
function collectRuntimeComponent({ runtimeVersion, runtimeRevision }) {
  const version = runtimeVersion == null || runtimeVersion === '' ? null : runtimeVersion;
  const revision = runtimeRevision == null || runtimeRevision === '' ? null : runtimeRevision;
  if (version === null && revision === null) return null;
  // Both halves in the digested line, each labelled, so the identity is legible
  // in the artifact and neither half can be silently dropped.
  return `sha256:${sha256(`version\t${version ?? ''}\nrevision\t${revision ?? ''}`)}`;
}

/**
 * @param {{ repoRoot: string, tarballsDir: string, nextJsDir?: string | null, nextTarball?: string | null, nextRef?: string | null, runtimeVersion?: string | null, runtimeRevision?: string | null, workflowFile?: string | null, lane?: string }} options
 */
export function computeFingerprint({
  repoRoot,
  tarballsDir,
  nextJsDir,
  nextTarball,
  nextRef,
  runtimeVersion,
  runtimeRevision,
  workflowFile,
  // #1294: which cell's workflow entry to hash. Defaults to `CREDENTIAL_LANE`
  // ('node') — the pre-#1294 caller never passed this, and 'node' resolves to
  // the same `test-e2e-deploy.yml` entry the un-lane-aware formula always used,
  // so an un-migrated caller's digest is byte-identical.
  lane = CREDENTIAL_LANE,
}) {
  const harness = collectHarness(repoRoot, lane, { workflowFile });
  const { entries: packed, packages } = collectPacked(tarballsDir);

  const harnessLines = harness.map((e) => e.line).sort();
  const packedLines = packed.map((e) => e.line).sort();
  /** @type {{ harness: string, packed: string, runtime?: string }} */
  const components = {
    harness: `sha256:${sha256(harnessLines.join('\n'))}`,
    packed: `sha256:${sha256(packedLines.join('\n'))}`,
  };

  // The digest string. The `runtime` line is APPENDED only when an identity was
  // supplied (the bun lane), so the node lane's digest is unchanged from the
  // original `${SCHEMA}\n${harness}\n${packed}\n` formula — byte for byte.
  const runtimeComponent = collectRuntimeComponent({ runtimeVersion, runtimeRevision });
  let digestInput = `${SCHEMA}\n${components.harness}\n${components.packed}\n`;
  if (runtimeComponent !== null) {
    components.runtime = runtimeComponent;
    digestInput += `runtime\t${runtimeComponent}\n`;
  }
  const fingerprint = `sha256:${sha256(digestInput)}`;

  return {
    schema: SCHEMA,
    fingerprint,
    components,
    // Outside `fingerprint` by construction: it is derived from `components`
    // only, so nothing under `recorded` can move the digest.
    recorded: {
      suite: collectSuiteProvenance({ nextJsDir, nextTarball, nextRef }),
      // Recorded verbatim (as well as folded) so the observed build is legible
      // in the artifact without re-deriving it from the opaque component hash.
      // On the node lane both are null and nothing is folded.
      runtime: {
        version: runtimeVersion == null || runtimeVersion === '' ? null : runtimeVersion,
        revision: runtimeRevision == null || runtimeRevision === '' ? null : runtimeRevision,
        frozen: runtimeComponent !== null,
      },
    },
    counts: { harness: harness.length, packed: packed.length },
    packages,
    files: [...harness, ...packed].map((e) => ({ component: e.component, path: e.path })),
  };
}

/* c8 ignore start — CLI wrapper */
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(`--${name}`);
  const arg = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1];
  };

  const repoRoot = resolve(arg('repo-root', process.cwd()));
  const tarballsDir = arg('tarballs-dir', null);
  if (!tarballsDir) {
    console.error(
      'compat-window fingerprint: --tarballs-dir is REQUIRED (the packed adapter is half the frozen set)',
    );
    process.exit(2);
  }

  let result;
  try {
    result = computeFingerprint({
      repoRoot,
      tarballsDir,
      // Recorded, not frozen — see collectSuiteProvenance().
      nextJsDir: arg('next-js-dir', null),
      nextTarball: arg('next-tarball', null),
      nextRef: arg('next-ref', null),
      // #1147 (window-bun-lane.md rule 4): the OBSERVED Bun build. Absent on the
      // node lane → nothing folded, node digest unchanged.
      runtimeVersion: arg('runtime-version', null),
      runtimeRevision: arg('runtime-revision', null),
      // ADR-0039 Amendment 1: the workflow file that EXECUTED (github.workflow_sha).
      workflowFile: arg('workflow-file', null),
      // #1294: which cell's workflow entry to hash — defaults to CREDENTIAL_LANE.
      lane: arg('lane', CREDENTIAL_LANE),
    });
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const payload = flag('files') ? result : { ...result, files: undefined };
  const out = arg('out', null);
  if (out) {
    writeFileSync(resolve(out), `${JSON.stringify(result, null, 2)}\n`);
  }
  if (flag('json')) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`compat-window fingerprint: ${result.fingerprint}`);
    console.log(`  harness ${result.components.harness} (${result.counts.harness} files)`);
    console.log(`  packed  ${result.components.packed} (${result.counts.packed} files)`);
    for (const p of result.packages) {
      console.log(`    ${p.name}@${p.version} ${p.sha256} (${p.files} files)`);
    }
    const suite = result.recorded.suite;
    console.log(
      '  suite provenance (RECORDED, not frozen — a bump here does not reset the window):',
    );
    console.log(`    next ref            ${suite.nextRef ?? 'n/a'}`);
    console.log(`    next.js checkout    ${suite.nextJsCommit ?? 'n/a'}`);
    console.log(`    next tarball sha256 ${suite.nextTarballSha256 ?? 'n/a'}`);
    const runtime = result.recorded.runtime;
    if (runtime.frozen) {
      console.log('  observed Bun build (FROZEN — folded into the digest, #1147 rule 4):');
      console.log(`    bun --version   ${runtime.version ?? 'n/a'}`);
      console.log(`    bun --revision  ${runtime.revision ?? 'n/a'}`);
    } else {
      console.log('  runtime identity: none (node lane — nothing folded)');
    }
    if (out) console.log(`  written to ${relative(process.cwd(), resolve(out))}`);
  }
}
/* c8 ignore stop */

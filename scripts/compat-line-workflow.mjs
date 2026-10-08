#!/usr/bin/env node
/**
 * compat-line-workflow — DERIVE a release line's credential workflow from the
 * pinned RC tag's OWN `test-e2e-deploy.yml`, and prove the derivation.
 *
 * WHY DERIVED, NOT COPIED. GitHub fires scheduled workflows only from `main`,
 * so a v1.3 credential night needs a workflow file ON MAIN. But it must run
 * the v1.3 tag's own harness, and `test-e2e-deploy.yml` on main is frozen for
 * v1.0. Dispatching `test-e2e-deploy.yml` at the v1.3 tag instead was rejected:
 * those runs would land in the v1.0 workflow's run list, which the v1.0 audit
 * reads 100 runs at a time across ALL events — four extra runs a night would
 * shrink v1.0's visible horizon from ~16 nights to ~10, below its 14-night
 * window. So the v1.3 lane is a separate file, `compat-credential-v1.3.yml`,
 * that is EXACTLY the tag's `test-e2e-deploy.yml` with a short, declared list
 * of anchor-exact substitutions applied (`lineSubstitutions`) and a header
 * recording which tag and which source digest it came from.
 *
 * TWO PROOFS, so a hand edit or a stale file cannot run a night:
 *
 *   * RUN TIME (the gate). The derived workflow's credential-ref job fetches the
 *     resolved tag's `test-e2e-deploy.yml` and runs `--check`: the header tag
 *     must equal the resolved tag, the source's sha256 must equal the header
 *     digest, and `derive(source)` must equal the executing file byte for byte.
 *     Any mismatch refuses the night before anything is built.
 *   * PR TIME (no tag needed). Every substitution is exactly invertible (its
 *     replacement never occurs in the text it is applied to), so
 *     `underiveLineWorkflow(committed)` recovers the source. The spec then
 *     asserts the recovered source hashes to the header digest, re-derives to
 *     the committed file, and that the header tag equals the line's pin.
 *
 * A THIRD PROOF, FOR THE CODE THAT GRADES THE LINE. The resolver
 * (`compat-credential-line.mjs`), this gate and the tracker run from `main`,
 * together with everything they transitively import (`lineGuardClosure`:
 * the audit's `auditWindow`, the matrix tracker's row formatting, the v1.0
 * resolver's `gitLsRemote` / `isRcTag`, …). The fingerprint covers the RC
 * tag's checkout plus the one executing workflow file, so none of that is
 * fingerprinted. Every closure file's sha256 (`lineGuardDigests`) is therefore
 * recorded in the header — i.e. in the executing file's bytes. Editing any of
 * them changes the expected header, so `--check` and the PR-time spec refuse
 * the old file; the regenerated file has different bytes, a different
 * fingerprint, and every v1.3 cell's window restarts. Some closure files are
 * also in the v1.0 frozen set; they are only READ here, never edited.
 *
 * ANCHORS ARE COUNTED, NOT HOPED FOR. Each substitution names the exact number
 * of occurrences it expects; a different count THROWS. When a future tag
 * changes its own workflow so an anchor moves, regeneration fails loudly with
 * the anchor's id — it never derives a half-substituted file.
 *
 * Usage:
 *   # regenerate after a v1.3 pin bump (see docs/RELEASING.md)
 *   git show v1.3.0-rc.N:.github/workflows/test-e2e-deploy.yml > /tmp/src.yml
 *   node scripts/compat-line-workflow.mjs --write --line v1.3 --tag v1.3.0-rc.N --source /tmp/src.yml
 *   # the run-time gate (the derived workflow calls this)
 *   node scripts/compat-line-workflow.mjs --check --line v1.3 --tag <resolved> \
 *     --source <tag's test-e2e-deploy.yml> --executing <this workflow>
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lineSpec } from './compat-credential-line.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} text */
export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Non-overlapping occurrence count of `needle` in `hay`. */
function count(hay, needle) {
  if (!needle) throw new Error('compat-line-workflow: empty anchor');
  return hay.split(needle).length - 1;
}

/**
 * The declared substitutions for `spec`, in application order. Each is
 * `{ id, from, to, count }`: `from` must occur EXACTLY `count` times in the
 * text it is applied to, and `to` must occur zero times there (which is what
 * makes the step exactly invertible).
 *
 * @param {ReturnType<typeof lineSpec>} spec
 */
export function lineSubstitutions(spec) {
  const derivedPath = `.github/workflows/${spec.workflowFile}`;
  const v = spec.line;
  /** @type {{id: string, from: string, to: string, count: number}[]} */
  const subs = [
    {
      id: 'workflow-name',
      from: 'name: Compat suite (official Next.js deploy harness)\n',
      to: `name: ${spec.workflowName}\n`,
      count: 1,
    },
  ];
  // The four credential crons, moved to this line's offset slots. Every
  // occurrence moves — the env expressions, the recovery job's inlined `if:`
  // and the source's comments — so no expression can still name a v1.0 slot.
  const cronCounts = {
    '17 1 * * *': 4,
    '47 5 * * *': 7,
    '17 22 * * *': 6,
    '47 23 * * *': 8,
  };
  for (const [from, to] of Object.entries(spec.cronMap)) {
    subs.push({ id: `cron ${from}`, from: `'${from}'`, to: `'${to}'`, count: cronCounts[from] });
  }
  // The two v1.0 EARLY-WARNING crons test `main`; this line is credential-only,
  // so they are unscheduled (their env-expression branches become dead: a cron
  // that never fires cannot select them).
  for (const cron of spec.unscheduledCrons) {
    subs.push({
      id: `unschedule ${cron}`,
      from: `    - cron: '${cron}'\n`,
      to: `    # ${v} line: the '${cron}' early-warning slot is not scheduled (credential-only lane).\n`,
      count: 1,
    });
  }
  subs.push(
    {
      // The executing-file path: the frozen-set workflow entry (ADR-0039
      // Amendment 1) is THIS derived file, so editing it moves the v1.3
      // fingerprint — never v1.0's.
      id: 'executing-workflow-path',
      from: '.github/workflows/test-e2e-deploy.yml',
      to: derivedPath,
      count: 2,
    },
    {
      id: 'line-resolver',
      from:
        '          node knext/scripts/compat-credential-ref.mjs \\\n' +
        '            --mode "${KNEXT_COMPAT_MODE}" \\\n' +
        '            --pin knext/.github/compat-credential-ref.json \\\n' +
        '            --remote-dir knext\n',
      to:
        '          node knext/scripts/compat-credential-line.mjs \\\n' +
        `            --line ${v} \\\n` +
        '            --mode "${KNEXT_COMPAT_MODE}" \\\n' +
        `            --pin knext/${spec.pinFile} \\\n` +
        '            --remote-dir knext\n' +
        '\n' +
        `      # ${v} line — refuse the night unless THIS executing file is exactly the\n` +
        "      # resolved tag's own .github/workflows/test-e2e-deploy.yml plus the declared\n" +
        '      # substitutions in scripts/compat-line-workflow.mjs. A pin bump that did\n' +
        '      # not regenerate this file, or a hand edit, fails here, before any build.\n' +
        "      - name: Verify this workflow is the pinned tag's own harness (derived, byte-for-byte)\n" +
        '        env:\n' +
        '          CHECKOUT_SHA: ${{ steps.resolve.outputs.checkout_sha }}\n' +
        '          RESOLVED_TAG: ${{ steps.resolve.outputs.tag }}\n' +
        '        run: |\n' +
        '          set -euo pipefail\n' +
        '          git -C knext fetch --no-tags --depth=1 origin "${CHECKOUT_SHA}"\n' +
        '          git -C knext show "${CHECKOUT_SHA}:.github/workflows/test-e2e-deploy.yml" > "${RUNNER_TEMP}/line-source-workflow.yml"\n' +
        `          node knext/scripts/compat-line-workflow.mjs --check --line ${v} \\\n` +
        '            --tag "${RESOLVED_TAG}" \\\n' +
        '            --source "${RUNNER_TEMP}/line-source-workflow.yml" \\\n' +
        `            --executing knext/${derivedPath}\n`,
      count: 1,
    },
    {
      id: 'alert-title',
      from: 'title="Compat CREDENTIAL RED (${KNEXT_LANE}, RC tag)"',
      to: `title="${spec.alertTitle}"`,
      count: 2,
    },
    {
      id: 'reset-label',
      from: '"credential-reset"',
      to: `"${spec.resetLabel}"`,
      count: 6,
    },
    {
      id: 'reset-label-prose',
      from: 'This per-cell issue is labelled \\`credential-reset\\`.',
      to: `This per-cell issue is labelled \\\`${spec.resetLabel}\\\`.`,
      count: 1,
    },
    {
      id: 'window-prose',
      from: 'v1.0 14-night window',
      to: `${v} 14-night window`,
      count: 3,
    },
    {
      id: 'pin-prose',
      from: 'pinned in \\`.github/compat-credential-ref.json\\`',
      to: `pinned in \\\`${spec.pinFile}\\\``,
      count: 1,
    },
    {
      id: 'tracker-prose',
      from: 'The single aggregate view is the pinned **Compat v1.0 credential matrix tracker** issue, refreshed daily by \\`compat-matrix-tracker-nightly.yml\\`.',
      to: `The single aggregate view for this line is the (unpinned) **${spec.trackerTitle}** issue, refreshed daily by \\\`${spec.trackerWorkflow}\\\`.`,
      count: 1,
    },
  );
  return subs;
}

/** `import … from '…'` / `export … from '…'` / bare `import '…'`. */
const STATIC_SPECIFIER_RE = /\b(?:from|import)\s*(['"])([^'"\n]+)\1/g;
/**
 * `import(` / `require(` as CODE — the argument is inspected separately.
 * Two prose exclusions keep the fail-closed below from firing on comments:
 * a match right after a backtick is skipped (in valid JS that is
 * template-literal TEXT, never a call), and so is a space before the paren
 * ("they import (…)") — biome, which formats every script here, writes a
 * call with no space, so formatted code never takes that shape.
 */
const CALL_RE = /(?<!`)\b(?:import|require)\(/g;
/** The ways an ES module can load by a name the scan cannot read. */
const LOADER_ESCAPE_RE = /(?<!`)\bgetBuiltinModule\(/;
/** A call argument that is one plain string literal, then `)`. */
const LITERAL_CALL_ARG_RE = /^\s*(['"])([^'"\n]+)\1\s*\)/;

/**
 * Every RELATIVE module specifier `src` may load: static `import`/`export …
 * from`, bare `import '…'`, and literal `import('…')` / `require('…')`.
 *
 * DELIBERATELY OVER-INCLUSIVE, AND DEPENDENCY-FREE. This runs inside the
 * derived workflow's credential-ref job, which has no `node_modules` — so no
 * parser. Instead the scan reads RAW text, comments and strings included: a
 * prose mention of `from './x.mjs'` adds that file to the guard set, which
 * costs only an extra digest (a file that does not exist is skipped by the
 * caller). Missing a real import is the failure that matters, and it is
 * covered from the other side: `tests/compat-credential-line.test.ts`
 * re-derives the closure with a REAL parser (`Bun.Transpiler`) and reds if any
 * file it finds is absent from this one.
 *
 * FAILS CLOSED on an `import(` / `require(` whose argument is not one plain
 * string literal, and on any route to node:module's `createRequire` — a
 * computed specifier might be relative, and a silently-unguarded dependency is
 * exactly what this closure exists to rule out.
 *
 * @param {string} src
 * @param {string} where  the file, for the error text
 * @returns {string[]}
 */
export function localImportSpecifiers(src, where) {
  /** @type {string[]} */
  const specs = [];
  for (const m of src.matchAll(STATIC_SPECIFIER_RE)) specs.push(m[2]);
  for (const m of src.matchAll(CALL_RE)) {
    const rest = src.slice((m.index ?? 0) + m[0].length);
    if (/^\s*\)/.test(rest)) continue; // `import()` in prose names nothing
    const lit = rest.match(LITERAL_CALL_ARG_RE);
    if (!lit) {
      throw new Error(
        `compat-line-workflow: ${where} has a non-literal ${m[0]}…) — the guard closure cannot follow a computed specifier; use a static import`,
      );
    }
    specs.push(lit[2]);
  }
  // `createRequire` (and every alias of it) comes from node:module, and
  // `process.getBuiltinModule` reaches it without an import: either one is a
  // loader this scan cannot follow, so refuse rather than under-report.
  if (specs.some((s) => s === 'module' || s === 'node:module') || LOADER_ESCAPE_RE.test(src)) {
    throw new Error(
      `compat-line-workflow: ${where} reaches node:module (createRequire) — the guard closure cannot follow an aliased require; use a static import`,
    );
  }
  // A package `imports` alias (`#x`), an absolute path or a file: URL can name a
  // repo file without looking relative — refuse rather than skip it as a package.
  const opaque = specs.find((s) => s.startsWith('#') || s.startsWith('/') || s.startsWith('file:'));
  if (opaque !== undefined) {
    throw new Error(
      `compat-line-workflow: ${where} imports ${JSON.stringify(opaque)} — the guard closure follows only relative specifiers; use one`,
    );
  }
  return specs.filter((s) => s.startsWith('./') || s.startsWith('../'));
}

/**
 * The line's GUARD CLOSURE: `spec.guardEntries` plus every repo file they
 * TRANSITIVELY import (relative specifiers, followed recursively), as sorted
 * repo-relative paths, read from `repoRoot` (default: this repo).
 *
 * Why transitive: the entries grade nights with code they import — the
 * tracker's `auditWindow` (compat-window-audit.mjs) and `formatCellRow` /
 * `looksLikeFetchFailure` (compat-matrix-tracker.mjs), the resolver's
 * `gitLsRemote` / `isRcTag` (compat-credential-ref.mjs), and whatever those
 * import in turn. An edit to any of them changes v1.3 grading as surely as an
 * edit to an entry, so all of them are digested. Computed, not enumerated: a
 * new import is in the set the moment it is written.
 *
 * @param {ReturnType<typeof lineSpec>} spec
 * @param {string} [repoRoot]
 * @returns {string[]}
 */
export function lineGuardClosure(spec, repoRoot = REPO_ROOT) {
  const root = resolve(repoRoot);
  const seen = new Set();
  const queue = [...spec.guardEntries];
  while (queue.length > 0) {
    const rel = /** @type {string} */ (queue.shift());
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = join(root, rel);
    for (const s of localImportSpecifiers(readFileSync(abs, 'utf8'), rel)) {
      const target = resolve(dirname(abs), s);
      const relTarget = relative(root, target);
      if (relTarget.startsWith('..') || isAbsolute(relTarget)) {
        throw new Error(
          `compat-line-workflow: ${rel} imports ${s}, outside the repo — the guard closure cannot cover it`,
        );
      }
      // Over-inclusive scan (see localImportSpecifiers): a prose match that
      // names no file is not a dependency.
      if (!existsSync(target) || !statSync(target).isFile()) continue;
      queue.push(relTarget.split(sep).join('/'));
    }
  }
  return [...seen].sort();
}

/**
 * sha256 of each file in the line's GUARD CLOSURE (`lineGuardClosure`). None
 * of these is in the fingerprint (it hashes the RC tag's checkout plus the one
 * executing workflow file), and most are in no frozen set. Writing their
 * digests into the derived header (the executing file, which the fingerprint
 * hashes byte for byte) is what makes editing one mid-window restart the
 * window: the edit changes the expected header, so `--check` and the PR-time
 * spec refuse the old file, and the regenerated one has different bytes.
 *
 * @param {ReturnType<typeof lineSpec>} spec
 * @param {string} [repoRoot]
 * @returns {[string, string][]}
 */
export function lineGuardDigests(spec, repoRoot = REPO_ROOT) {
  return lineGuardClosure(spec, repoRoot).map((path) => [
    path,
    sha256(readFileSync(join(repoRoot, path), 'utf8')),
  ]);
}

const GUARD_LINE_RE = /^# guard-script-sha256: (\S+) ([0-9a-f]{64})$/gm;

/**
 * The generated header. Its last lines carry the provenance the run-time
 * gate checks; everything else is fixed text, so `parseDerivedHeader` can
 * rebuild and compare it exactly.
 *
 * @param {ReturnType<typeof lineSpec>} spec
 * @param {string} tag
 * @param {string} digest
 * @param {[string, string][]} guards
 */
function buildHeader(spec, tag, digest, guards) {
  return [
    '# ─────────────────────────────────────────────────────────────────────────────',
    '# GENERATED by scripts/compat-line-workflow.mjs — DO NOT EDIT BY HAND.',
    `# The ${spec.line} compat CREDENTIAL lane (parallel to v1.0's; founder decision`,
    "# 2026-10-08). This file is the pinned tag's OWN",
    '# .github/workflows/test-e2e-deploy.yml with ONLY the substitutions declared in',
    '# scripts/compat-line-workflow.mjs applied: the workflow name, the four',
    "# credential crons moved to this line's offset slots, the two early-warning",
    `# crons unscheduled, the ${spec.line} pin + line resolver + this derivation check,`,
    '# the executing-file path, and the alert title/label/tracker text. Every other',
    '# byte — including every comment below, which still names v1.0 slots and',
    "# paths — is the tag's. The credential-ref job REFUSES the night unless this",
    '# file equals derive(<resolved tag>:.github/workflows/test-e2e-deploy.yml).',
    '# The guard-script digests below fold the main-side code that resolves and',
    '# grades this line (the resolver, this gate and the tracker, plus everything they',
    '# transitively import) into the bytes the compat-window fingerprint hashes:',
    '# editing any of it forces a regeneration, which moves the fingerprint and',
    '# restarts the window.',
    `# Regenerate on a ${spec.line} pin bump or a guard-script edit: docs/RELEASING.md.`,
    ...guards.map(([path, d]) => `# guard-script-sha256: ${path} ${d}`),
    `# derived-from-tag: ${tag}`,
    `# derived-from-sha256: ${digest}`,
    '# ─────────────────────────────────────────────────────────────────────────────',
    '',
  ].join('\n');
}

/**
 * Apply `lineSubstitutions` to the tag's `test-e2e-deploy.yml` text.
 *
 * @param {string} sourceText
 * @param {{line: string, tag: string, repoRoot?: string}} opts
 */
export function deriveLineWorkflow(sourceText, { line, tag, repoRoot }) {
  const spec = lineSpec(line);
  if (!spec.tagPattern.test(String(tag))) {
    throw new Error(`compat-line-workflow: ${JSON.stringify(tag)} is not a ${line} RC tag`);
  }
  let text = sourceText;
  for (const s of lineSubstitutions(spec)) {
    const n = count(text, s.from);
    if (n !== s.count) {
      throw new Error(
        `compat-line-workflow: anchor "${s.id}" occurs ${n} time(s), expected ${s.count} — the source workflow changed; update lineSubstitutions deliberately`,
      );
    }
    if (count(text, s.to) !== 0) {
      throw new Error(
        `compat-line-workflow: replacement for "${s.id}" already occurs in the source — the step would not be invertible`,
      );
    }
    text = text.split(s.from).join(s.to);
  }
  return buildHeader(spec, tag, sha256(sourceText), lineGuardDigests(spec, repoRoot)) + text;
}

const HEADER_TAG_RE = /^# derived-from-tag: (\S+)$/m;
const HEADER_DIGEST_RE = /^# derived-from-sha256: ([0-9a-f]{64})$/m;

/**
 * Read the provenance header; throws unless it is exactly the generated one
 * and records exactly the guard closure computed from `repoRoot`.
 *
 * @param {string} derivedText
 * @param {string} [line]
 * @param {string} [repoRoot]
 */
export function parseDerivedHeader(derivedText, line = 'v1.3', repoRoot = REPO_ROOT) {
  const spec = lineSpec(line);
  const tag = derivedText.match(HEADER_TAG_RE)?.[1];
  const digest = derivedText.match(HEADER_DIGEST_RE)?.[1];
  if (!tag || !digest) {
    throw new Error('compat-line-workflow: no derived-from-tag / derived-from-sha256 header');
  }
  const guards = [...derivedText.matchAll(GUARD_LINE_RE)].map((m) => [m[1], m[2]]);
  const closure = lineGuardClosure(spec, repoRoot);
  if (JSON.stringify(guards.map(([p]) => p)) !== JSON.stringify(closure)) {
    throw new Error(
      `compat-line-workflow: the header must record exactly the guard closure ${closure.join(', ')}`,
    );
  }
  const header = buildHeader(spec, tag, digest, guards);
  if (!derivedText.startsWith(header)) {
    throw new Error('compat-line-workflow: the generated header was edited or is not at the top');
  }
  return { tag, digest, guards, header };
}

/**
 * Invert `deriveLineWorkflow`: strip the header, undo each substitution in
 * reverse order (each `to` must occur exactly `count` times at that point).
 *
 * @param {string} derivedText
 * @param {{line: string, repoRoot?: string}} opts
 */
export function underiveLineWorkflow(derivedText, { line, repoRoot }) {
  const spec = lineSpec(line);
  const { tag, digest, guards, header } = parseDerivedHeader(derivedText, line, repoRoot);
  let text = derivedText.slice(header.length);
  for (const s of [...lineSubstitutions(spec)].reverse()) {
    const n = count(text, s.to);
    if (n !== s.count) {
      throw new Error(
        `compat-line-workflow: cannot invert "${s.id}": its replacement occurs ${n} time(s), expected ${s.count} — the derived file was hand-edited`,
      );
    }
    text = text.split(s.to).join(s.from);
  }
  return { sourceText: text, tag, digest, guards };
}

/**
 * The run-time gate.
 *
 * @param {{line: string, tag: string, sourceText: string, executingText: string, repoRoot?: string}} input
 * @returns {{ok: boolean, reason: string}}
 */
export function checkLineWorkflow({ line, tag, sourceText, executingText, repoRoot }) {
  let header;
  try {
    header = parseDerivedHeader(executingText, line, repoRoot);
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  if (header.tag !== tag) {
    return {
      ok: false,
      reason: `the executing workflow was derived from ${header.tag}, but this night resolved ${tag} — regenerate it for the new pin (docs/RELEASING.md)`,
    };
  }
  const digest = sha256(sourceText);
  if (digest !== header.digest) {
    return {
      ok: false,
      reason: `${tag}'s test-e2e-deploy.yml hashes to ${digest}, not the recorded ${header.digest} — the executing workflow is not this tag's harness`,
    };
  }
  let derived;
  try {
    derived = deriveLineWorkflow(sourceText, { line, tag, repoRoot });
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  if (derived !== executingText) {
    return {
      ok: false,
      reason:
        "the executing workflow differs from derive(tag's test-e2e-deploy.yml) — it was hand-edited, or a file in the guard closure (resolver / derivation gate / tracker or anything they import) changed since it was generated; regenerate it",
    };
  }
  return {
    ok: true,
    reason: `executing workflow = derive(${tag}:test-e2e-deploy.yml), byte for byte`,
  };
}

/* c8 ignore start — CLI wrapper */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const arg = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? undefined : args[i + 1];
  };
  const line = arg('line');
  const tag = arg('tag');
  const sourcePath = arg('source');
  try {
    const spec = lineSpec(line);
    if (!sourcePath) throw new Error('--source <tag test-e2e-deploy.yml> is required');
    const sourceText = readFileSync(sourcePath, 'utf8');
    if (args.includes('--check')) {
      const executing = arg('executing');
      if (!executing) throw new Error('--executing <workflow> is required');
      const r = checkLineWorkflow({
        line,
        tag,
        sourceText,
        executingText: readFileSync(executing, 'utf8'),
      });
      console.log(r.ok ? 'OK' : 'REFUSED', r.reason);
      if (!r.ok) {
        console.error(`::error::${line} credential workflow REFUSED: ${r.reason}`);
        process.exit(1);
      }
    } else if (args.includes('--write')) {
      const out = join(REPO_ROOT, '.github', 'workflows', spec.workflowFile);
      writeFileSync(out, deriveLineWorkflow(sourceText, { line, tag }));
      console.log(`wrote ${out} (derived from ${tag}, sha256 ${sha256(sourceText)})`);
    } else {
      throw new Error('pass --check or --write');
    }
  } catch (err) {
    console.error(`compat-line-workflow: ${err.message}`);
    process.exit(1);
  }
}
/* c8 ignore stop */

/**
 * ADR-0044 Option C — the in-process request byte cap, as an auditable checker.
 *
 * ## What this is, and why the ADR's own design collapsed into it
 *
 * Decision 4 described Option C as a knext-owned front socket that owns `$PORT`
 * and loopback-forwards to a child. That premise died with ADR-0048: the
 * compiled binary's entry IS the request path and it already serves through
 * srvx, which exposes `maxRequestBodySize` and — on Bun — forwards it to
 * `Bun.serve`, where the runtime answers 413 before any user code runs.
 *
 * MEASURED, on two runtimes, because the difference is the whole guarantee:
 *
 *   bun 1.3.5  honest 5 KB / cap 1 KB → 413 · CHUNKED 5 KB, no Content-Length → 200
 *   bun 1.4.0  honest 5 KB / cap 1 KB → 413 · CHUNKED 5 KB, no Content-Length → 413
 *
 * ADR-0044 Decision 4 requires COUNTED bytes, never a trusted `Content-Length`,
 * so the constraint is satisfied by the runtime only at >= 1.4.0. That is not a
 * footnote: `vinext-build.ts`'s existing Bun floor is what puts a compliant
 * runtime inside every shipped binary, so lowering it would silently downgrade a
 * security control. `auditBunFloor` below makes the dependency a gate.
 *
 * ## What Bun's 413 does NOT do, recorded so it is not re-attempted
 *
 * The rejection is synthesized by the runtime before the handler: the `error`
 * hook does not fire, the body is EMPTY and there is no `content-type` (only the
 * status text differs — "Request Entity Too Large" for a declared length,
 * "Payload Too Large" for a counted one). srvx's middleware chain passes the
 * ORIGINAL request to `next()` and ignores what a middleware returns
 * (`dist/_chunks/_plugins.mjs`), so a middleware cannot substitute a limited
 * request either. There is therefore NO in-process seam at which knext can name
 * itself in the 413 body without either widening the cap (letting oversize
 * declared-length requests through to a knext handler) or rebuilding the Request
 * and dropping srvx's expando augmentation (the #460 bug-2 class). The cap is
 * made discoverable at BOOT instead — `REQUEST_BYTE_CAP:<n>` on stdout — and in
 * the docs.
 *
 * ## Why the scan is over "serves through srvx/bun", not over a basename
 *
 * `knext-bun-entry.mjs` has five homes and `scripts/lib/runtime-entry-copies.mjs`
 * pins them to each other — but the file the behavioural e2e actually boots is
 * `examples/bun-exec/test/srvx-close-harness.mjs`, which is a deliberate mirror
 * under a different name. A basename scan would leave the proof's own subject
 * unpinned. The property is "anything that serves through srvx/bun caps its
 * request bodies", so that is what is scanned for.
 *
 * Nothing here spawns anything or reads the tree on import — the mutation prover
 * calls these functions directly, which is what lets it prove a `bun:test` guard
 * without a runner (#902 has not landed).
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { blankNonCode } from './blank-non-code.mjs';
import { codeWithLiterals } from './prover-lane.mjs';
import { stripGeneratedByHeader } from './runtime-entry-copies.mjs';

/** The operator-facing knob. Env only — deliberately NOT a CRD field. */
export const ENV_VAR = 'KNEXT_MAX_REQUEST_BYTES';

/**
 * 8 MiB.
 *
 * ADR-0044's own arithmetic: the memory limit is 1Gi and `containerConcurrency`
 * defaults to 20 (`nextapp_controller.go`), so 20 worst-case buffered bodies
 * must not approach 1Gi — 20 x 8 MiB = 160 MiB. Deliberately ABOVE Next's 1 MB
 * `serverActions.bodySizeLimit`: two layers answering different errors at one
 * threshold is how a support ticket becomes unanswerable.
 */
export const DEFAULT_MAX_REQUEST_BYTES = 8 * 1024 * 1024;

/**
 * 64 KiB, FIXED, for the `:9464` listener.
 *
 * It answers exactly one GET, and until now ran at Bun's 128 MB default on the
 * co-resident-pod path ADR-0044's threat scope names as unbounded. It is not a
 * function of `ENV_VAR`, so the app-side escape hatch cannot re-open it.
 */
export const METRICS_MAX_REQUEST_BYTES = 64 * 1024;

/** The Bun version at which `maxRequestBodySize` starts counting chunked bytes. */
export const BUN_COUNTED_BODY_FLOOR = '1.4.0';

/** The canonical template whose resolver semantics are evaluated. */
export const CANONICAL_CONTRACT = 'packages/kn-next/templates/app/runtime-contract.mjs.hbs';

/** Where the Bun floor that backs the counted-bytes guarantee is declared. */
export const BUN_FLOOR_SOURCE = 'packages/kn-next/src/cli/vinext-build.ts';

/** The option srvx forwards to `Bun.serve`, and Bun enforces before the handler. */
const CAP_OPTION = 'maxRequestBodySize';

/** Directories a scan must never descend into. Mirrors the copy-pin's list. */
const SKIP_DIRS = new Set([
  '.git',
  '.next',
  '.output',
  '.turbo',
  '.vercel',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'coverage-bun',
  '.claude',
  'graphify-out',
]);

const SCANNED_EXT = /\.(mjs|js|ts|mjs\.hbs|js\.hbs|ts\.hbs)$/;

/**
 * Every file in the tree that serves through `srvx/bun`, as repo-relative POSIX
 * paths, sorted.
 *
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function discoverSrvxServeSites(repoRoot) {
  const root = resolve(repoRoot);
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile() || !SCANNED_EXT.test(entry.name)) continue;
      let src;
      try {
        src = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      if (!isSrvxServeSite(src)) continue;
      found.push(relative(root, full).split(sep).join('/'));
    }
  };
  walk(root);
  return found.sort();
}

/**
 * Does this source IMPORT `srvx/bun`?
 *
 * Two failure directions, and both have to be closed:
 *
 *   - a COMMENT mentioning srvx/bun must not make a file a serve site. Handled
 *     by scanning the blanked view (comments are erased wholesale).
 *   - a STRING mentioning it must not either — and this one is not hypothetical:
 *     `tests/request-byte-cap.test.ts` builds a fixture source containing
 *     `"import { serve } from 'srvx/bun';"` as a string, and the first version
 *     of this scan reported the test file itself as an uncapped serve site.
 *     `blankNonCode` empties literal contents, so the specifier has to be read
 *     back from the original — which makes a nested literal look like code.
 *
 * So the match must be an import STATEMENT: the `import` keyword at the start of
 * a statement, not preceded on its line by anything but whitespace. That is how
 * every ESM import in this tree is actually written (and how biome formats them),
 * and the discovery FLOOR in `auditRequestByteCap` is what catches this
 * predicate if it ever stops matching the real entries.
 *
 * @param {string} source
 */
export function isSrvxServeSite(source) {
  // `codeWithLiterals` — the SHARED comment-stripping-but-literal-keeping view
  // from the prover lane, not a fourth tokenizer. `tests/blank-non-code.test.ts`
  // fails if a second `blankNonCode*` definition appears anywhere under
  // `scripts/` or `tests/`, and it is right to: this scan re-deriving the same
  // view is exactly the copy-instead-of-share failure the lane exists to catch.
  const view = codeWithLiterals(source);
  return /(?:^|\n)[ \t]*import\b[\s\S]{0,400}?from\s*['"]srvx\/bun['"]/.test(view);
}

/**
 * Every `serve({...})` / `Bun.serve({...})` call in `source`.
 *
 * Located in the comment- and string-blanked view so a MENTION of the option
 * cannot satisfy the check, and brace-matched so the two listeners are read
 * separately rather than by "does the word appear somewhere in the file" — which
 * one capped listener would satisfy for both.
 *
 * @param {string} source
 * @returns {Array<{ kind: 'srvx' | 'bun', index: number, body: string, hasCap: boolean, value: string | undefined }>}
 */
export function serveCalls(source) {
  const code = blankNonCode(source);
  const calls = [];
  const pattern = /(?<prefix>[A-Za-z_$][\w$]*\s*\.\s*)?\bserve\s*\(/g;
  for (const match of code.matchAll(pattern)) {
    const prefix = (match.groups?.prefix ?? '').replace(/[\s.]/g, '');
    // `appSrvx.serve()`, `server.serve()` etc. are not listener constructions.
    if (prefix && prefix !== 'Bun') continue;
    const open = code.indexOf('{', match.index + match[0].length - 1);
    if (open === -1) continue;
    let depth = 0;
    let close = -1;
    for (let i = open; i < code.length; i++) {
      if (code[i] === '{') depth += 1;
      else if (code[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) continue;
    const body = code.slice(open, close + 1);
    const cap = new RegExp(`\\b${CAP_OPTION}\\s*:\\s*([^,\\n}]+)`).exec(body);
    calls.push({
      kind: prefix === 'Bun' ? 'bun' : 'srvx',
      index: match.index,
      body,
      hasCap: cap !== null,
      value: cap ? cap[1].trim() : undefined,
    });
  }
  return calls;
}

/**
 * Evaluate the canonical template's cap resolver.
 *
 * The template is plain JavaScript with a `.hbs` extension and no handlebars
 * expressions, so it is written to a temp `.mjs` and imported. Evaluating the
 * TEMPLATE rather than one of its copies is deliberate: the template is what a
 * scaffolded app receives, and the copy pin already guarantees the copies match.
 *
 * @param {string} repoRoot
 */
export async function loadCapResolver(repoRoot) {
  const src = stripGeneratedByHeader(readFileSync(resolve(repoRoot, CANONICAL_CONTRACT), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'knext-cap-'));
  const file = join(dir, 'runtime-contract.mjs');
  try {
    writeFileSync(file, src);
    return await import(pathToFileURL(file).href);
  } finally {
    // The module is already evaluated; the file on disk is no longer needed.
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The resolver semantics ADR-0044 Decision 4 and the T1 design require, as
 * findings.
 *
 * @param {{ resolveMaxRequestBytes?: Function }} mod
 * @returns {string[]}
 */
export function auditCapResolver(mod) {
  const findings = [];
  const resolve_ = mod.resolveMaxRequestBytes;
  if (typeof resolve_ !== 'function') {
    findings.push(
      `${CANONICAL_CONTRACT} does not export resolveMaxRequestBytes — nothing reads ${ENV_VAR}`,
    );
    return findings;
  }
  const check = (label, got, want) => {
    if (got !== want) findings.push(`${label}: expected ${String(want)}, got ${String(got)}`);
  };
  check('the default cap with no env set', resolve_({}).bytes, DEFAULT_MAX_REQUEST_BYTES);
  check('the default cap is 8 MiB', DEFAULT_MAX_REQUEST_BYTES, 8 * 1024 * 1024);
  check(`a positive ${ENV_VAR} override`, resolve_({ [ENV_VAR]: '4096' }).bytes, 4096);
  check(
    `${ENV_VAR}=0 must be undefined (no option), not 0`,
    resolve_({ [ENV_VAR]: '0' }).bytes,
    undefined,
  );
  check(`${ENV_VAR}=0 must be classed uncapped`, resolve_({ [ENV_VAR]: '0' }).source, 'uncapped');
  if (!/uncapped/i.test(resolve_({ [ENV_VAR]: '0' }).warning ?? '')) {
    findings.push(
      `${ENV_VAR}=0 must warn loudly — an uncapped listener that says nothing is the defect`,
    );
  }
  // The security-relevant direction: a typo must fall back to the DEFAULT, never
  // to uncapped and never to NaN (which srvx would forward and Bun would reject).
  for (const raw of ['', ' ', 'abc', '-1', '1.5', 'NaN', 'Infinity', '1e9x']) {
    const got = resolve_({ [ENV_VAR]: raw });
    check(
      `${ENV_VAR}=${JSON.stringify(raw)} must fall back to the default`,
      got.bytes,
      DEFAULT_MAX_REQUEST_BYTES,
    );
  }
  // The knob must not reach the metrics listener.
  check(
    'the metrics cap must stay fixed while the app is uncapped',
    resolve_({ [ENV_VAR]: '0' }).metricsBytes,
    METRICS_MAX_REQUEST_BYTES,
  );
  check('the metrics cap is 64 KiB', METRICS_MAX_REQUEST_BYTES, 64 * 1024);
  return findings;
}

/**
 * The counted-bytes guarantee is a property of the RUNTIME, so pin the floor
 * that puts a compliant runtime in every shipped binary.
 *
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function auditBunFloor(repoRoot) {
  const findings = [];
  let src;
  try {
    src = readFileSync(resolve(repoRoot, BUN_FLOOR_SOURCE), 'utf8');
  } catch {
    return [`bun floor: ${BUN_FLOOR_SOURCE} is missing — the counted-bytes guarantee is unpinned`];
  }
  const code = blankNonCode(src);
  const major = /MIN_BUN_MAJOR\s*=\s*(\d+)/.exec(code);
  const minor = /MIN_BUN_MINOR\s*=\s*(\d+)/.exec(code);
  if (!major || !minor) {
    return [
      `bun floor: MIN_BUN_MAJOR/MIN_BUN_MINOR are no longer declared in ${BUN_FLOOR_SOURCE}. ` +
        'ADR-0044 Option C leans on that floor: below Bun 1.4.0 `maxRequestBodySize` passes a ' +
        'CHUNKED oversize body straight to the handler (measured), so the cap stops being ' +
        'counted-bytes and the control is bypassable by omitting Content-Length.',
    ];
  }
  const [wantMajor, wantMinor] = BUN_COUNTED_BODY_FLOOR.split('.').map(Number);
  const have = [Number(major[1]), Number(minor[1])];
  if (have[0] < wantMajor || (have[0] === wantMajor && have[1] < wantMinor)) {
    findings.push(
      `bun floor: ${BUN_FLOOR_SOURCE} allows Bun ${have[0]}.${have[1]}, below ${BUN_COUNTED_BODY_FLOOR}. ` +
        'Measured: on 1.3.5 an oversize CHUNKED body (no Content-Length) reaches the handler ' +
        'with a 200 while the same body with a Content-Length is 413 — the ADR-0044 Decision 4 ' +
        'counted-bytes constraint is not met below 1.4.0.',
    );
  }
  return findings;
}

/**
 * Every violation of the byte-cap contract in the tree; `[]` when it is clean.
 *
 * @param {{ repoRoot: string }} opts
 * @returns {Promise<string[]>}
 */
export async function auditRequestByteCap({ repoRoot }) {
  const root = resolve(repoRoot);
  const findings = [];
  const sites = discoverSrvxServeSites(root);

  // A walker that finds nothing passes vacuously, and an audit over zero files
  // reports a clean tree. The canonical entry template must be among the
  // DISCOVERED set — driven by a literal path, so neutering the scan reds here
  // rather than going quiet.
  const canonicalEntry = 'packages/kn-next/templates/app/knext-bun-entry.mjs.hbs';
  if (!sites.includes(canonicalEntry)) {
    findings.push(
      `the scan did not discover ${canonicalEntry} — discovery is broken, not the tree`,
    );
  }

  for (const rel of sites) {
    const src = readFileSync(join(root, rel), 'utf8');
    const calls = serveCalls(src);
    if (calls.length === 0) {
      findings.push(`${rel} imports srvx/bun but no serve({...}) call was parsed out of it`);
      continue;
    }
    for (const call of calls) {
      if (!call.hasCap) {
        findings.push(
          `${rel}: the ${call.kind === 'bun' ? 'Bun.serve' : 'srvx serve'} call at offset ` +
            `${call.index} does not set ${CAP_OPTION}. ADR-0044 Option C: an uncapped listener ` +
            'buffers an unbounded request body in the pod, and the :9464 listener is the exact ' +
            'co-resident path the ADR names.',
        );
        continue;
      }
      // The metrics listener must use the FIXED small constant. Wiring the app's
      // resolved value there would let `KNEXT_MAX_REQUEST_BYTES=0` uncap it.
      if (call.kind === 'bun' && !/METRICS_MAX_REQUEST_BYTES/.test(call.value ?? '')) {
        findings.push(
          `${rel}: the Bun.serve (:9464 metrics) call sets ${CAP_OPTION} to ` +
            `${JSON.stringify(call.value)} instead of METRICS_MAX_REQUEST_BYTES. The metrics ` +
            `cap is fixed on purpose — ${ENV_VAR}=0 must not re-open it.`,
        );
      }
    }
  }

  findings.push(...auditCapResolver(await loadCapResolver(root)));
  findings.push(...auditBunFloor(root));
  return findings;
}

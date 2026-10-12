/**
 * Upstream-runtime-defect ledger (ADR-0007 amendment, 2026-10-12).
 *
 * A SEPARATE category from the §h vercel-infra-coupled family (`$knextQuarantines`,
 * capped by `FAMILY_QUARANTINE_CAP`) and from `$knextExclusions` (global, closed).
 * It records a file that is red on exactly one lane because of a defect in a
 * runtime we do not own, where knext refuses the affected configuration at build
 * time and the defect has an upstream fix that is not yet released.
 *
 * Why it is not a quarantine: the file STAYS IN the corpus and keeps running on
 * its lane (it is not in `rules.exclude`), so the lane keeps reporting the red
 * honestly. The entry only records that the red is triaged, has a named upstream
 * cause, and has a removal condition. Pure and dependency-free so the spec and the
 * mutation prover share one definition.
 */

/** The manifest key holding the ledger (copied verbatim into the smoke manifest). */
export const UPSTREAM_RUNTIME_DEFECT_KEY = '$knextUpstreamRuntimeDefects';

/**
 * The category's OWN cap. It is deliberately not `FAMILY_QUARANTINE_CAP`: these
 * entries are not §h entries and must never consume (or hide behind) its headroom.
 * Raising it needs an ADR-0007 amendment, like the §h cap.
 */
export const UPSTREAM_RUNTIME_DEFECT_CAP = 5;

/** `<runtime>/<builder>`: a defect is scoped to ONE cell, never to a whole runtime. */
export const LANE_PATTERN = /^(node|bun)\/(turbopack|webpack)$/;

/** `owner/repo#N` — an upstream issue or PR in a repository knext does not own. */
export const UPSTREAM_REF_PATTERN = /^(?!getknext-dev\/)[\w.-]+\/[\w.-]+#\d+$/;

export interface UpstreamRuntimeDefect {
  test: string;
  lane: string;
  nextjsRef: string;
  cases: string[];
  mechanism: string;
  evidence: string;
  upstream: { issue: string; fix: string };
  /** The knext-side refusal that makes the red a deliberate, documented state. */
  knextRefusal: string;
  /** What ends this entry. Must be a concrete, checkable condition. */
  removeWhen: string;
  provenance: string;
  /** Optional re-audit stamp (a vX.Y.Z ref), same meaning as on a quarantine entry. */
  reaudited?: string;
}

/**
 * What the validator may look at in the repository. Injected so the module stays
 * pure: the spec passes the real filesystem, unit tests pass fakes. An entry cannot
 * be validated without it (a refusal that cannot be looked up is not a refusal).
 */
export interface LedgerContext {
  /** True when a repo-relative path exists. */
  exists: (repoPath: string) => boolean;
  /** The text of a repo-relative file, or undefined when it cannot be read. */
  read: (repoPath: string) => string | undefined;
}

/** `path/to/file.ts` or `path/to/file.ts#symbol`, anywhere in a free-text field. */
const REFUSAL_REF = /([\w./-]+\.(?:ts|tsx|mjs|cjs|js))(?:#([A-Za-z_$][\w$]*))?/g;
/** A corpus test path is one concrete file: no glob metacharacters at all. */
const CONCRETE_TEST_PATH = /^test\/[\w./-]+\.test\.[jt]sx?$/;

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/**
 * Parse the ledger out of a manifest's text. FAILS CLOSED: unreadable text, invalid
 * JSON, a missing key or a non-array value all THROW — an unreadable ledger must
 * never read as "no entries, nothing to enforce".
 */
export function parseUpstreamRuntimeDefects(manifestText: string): UpstreamRuntimeDefect[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch (err) {
    throw new Error(
      `upstream-runtime-defect ledger: manifest is not readable JSON (${(err as Error).message})`,
    );
  }
  const list = (parsed as Record<string, unknown> | null)?.[UPSTREAM_RUNTIME_DEFECT_KEY];
  if (!Array.isArray(list)) {
    throw new Error(
      `upstream-runtime-defect ledger: manifest has no ${UPSTREAM_RUNTIME_DEFECT_KEY} array`,
    );
  }
  return list as UpstreamRuntimeDefect[];
}

/** Does the free text name at least one existing repo file (and its symbol, when given)? */
function namesRealGuard(text: string, ctx: LedgerContext): boolean {
  for (const m of text.matchAll(REFUSAL_REF)) {
    const [, path, symbol] = m;
    if (!path || !ctx.exists(path)) continue;
    if (symbol === undefined) return true;
    if (ctx.read(path)?.includes(symbol)) return true;
  }
  return false;
}

/**
 * Everything wrong with ONE entry. Empty means admissible. Each rule is a guard the
 * mutation prover removes and must see go red.
 */
export function entryProblems(e: Partial<UpstreamRuntimeDefect>, ctx?: LedgerContext): string[] {
  const out: string[] = [];
  const who = e.test ?? '<no test>';
  if (
    !nonEmpty(e.test) ||
    !CONCRETE_TEST_PATH.test(e.test) ||
    e.test.split('/').some((seg) => seg === '..' || seg === '.')
  ) {
    out.push(`${who}: test must be one concrete corpus test file (no glob or wildcard)`);
  }
  if (!nonEmpty(e.lane) || !LANE_PATTERN.test(e.lane)) {
    out.push(`${who}: lane must be <node|bun>/<turbopack|webpack>, got ${JSON.stringify(e.lane)}`);
  }
  if (!nonEmpty(e.removeWhen)) {
    out.push(`${who}: removeWhen must be a non-empty removal condition`);
  } else if (nonEmpty(e.upstream?.fix) && !e.removeWhen.includes(e.upstream.fix)) {
    out.push(`${who}: removeWhen must reference the entry's own upstream fix (${e.upstream.fix})`);
  }
  if (!e.upstream || !UPSTREAM_REF_PATTERN.test(e.upstream.issue ?? '')) {
    out.push(`${who}: upstream.issue must be an owner/repo#N reference outside getknext-dev`);
  }
  if (!e.upstream || !UPSTREAM_REF_PATTERN.test(e.upstream.fix ?? '')) {
    out.push(`${who}: upstream.fix must be an owner/repo#N reference outside getknext-dev`);
  }
  if (!nonEmpty(e.knextRefusal)) {
    out.push(`${who}: knextRefusal must cite the build-time refusal that makes the red deliberate`);
  } else if (!ctx) {
    out.push(`${who}: knextRefusal cannot be verified without a repository context`);
  } else if (!namesRealGuard(e.knextRefusal, ctx)) {
    out.push(
      `${who}: knextRefusal must name a real guard: a repo path that exists, as path or path#symbol with the symbol present in that file`,
    );
  }
  if (!nonEmpty(e.mechanism)) out.push(`${who}: mechanism required`);
  if (!Array.isArray(e.cases) || e.cases.length === 0) out.push(`${who}: cases required`);
  if (!nonEmpty(e.evidence) || !/\brun \d{8,}\b/.test(e.evidence)) {
    out.push(`${who}: evidence must cite a CI run id`);
  }
  if (!nonEmpty(e.nextjsRef) || !/^v\d+\.\d+\.\d+$/.test(e.nextjsRef)) {
    out.push(`${who}: nextjsRef must be a vX.Y.Z ref`);
  }
  if (!nonEmpty(e.provenance)) out.push(`${who}: provenance required`);
  if (e.reaudited !== undefined && !/^v\d+\.\d+\.\d+$/.test(e.reaudited)) {
    out.push(`${who}: reaudited must be a vX.Y.Z ref when present`);
  }
  return out;
}

/** Ledger-level problems: every entry, the cap, duplicates. */
export function ledgerProblems(entries: UpstreamRuntimeDefect[], ctx?: LedgerContext): string[] {
  const out = entries.flatMap((e) => entryProblems(e, ctx));
  if (entries.length > UPSTREAM_RUNTIME_DEFECT_CAP) {
    out.push(
      `ledger holds ${entries.length} entries, over its own cap of ${UPSTREAM_RUNTIME_DEFECT_CAP} (raising it needs an ADR-0007 amendment)`,
    );
  }
  const seen = new Set<string>();
  for (const e of entries) {
    const key = `${e.test}@${e.lane}`;
    if (seen.has(key)) out.push(`${key}: duplicate entry`);
    seen.add(key);
  }
  return out;
}

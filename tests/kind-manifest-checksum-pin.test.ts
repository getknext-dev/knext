import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * #1289: checksum-pin the cert-manager/Knative/Kourier/Calico cluster
 * manifests AND digest-pin the mutable-tag IMAGES those manifests reference,
 * across every kind-based workflow — several used to `kubectl apply -f <url>`
 * those manifests directly, with NO checksum at all: a moved/edited release
 * asset would have applied silently.
 *
 * `scripts/kind-manifests/apply-cert-manager.sh` and
 * `apply-knative-kourier.sh` are the single "fetch + checksum-verify +
 * image-digest-pin + apply" helper the kind workflows call.
 *
 * #1410 review round 3: the round-2 scanner still worked at LINE granularity
 * and only looked FORWARD from a curl for its checksum, which several shapes
 * defeated:
 *   1. a single physical line chaining fetch-then-apply (`curl -o f URL &&
 *      kubectl apply -f f`) — exactly what a folded YAML `run: >` block
 *      produces — plus combined short flags (`-fsSLo f`), `--output=f`,
 *      a bare shell redirect (`> f`), `wget`, and a helper function that
 *      wraps `curl` (so the literal string never appears at the apply site);
 *   2. the bare-URL check ran on kind workflows only and matched a literal
 *      string, missing `URL=https://…; kubectl apply -f "$URL"`, a NEW `.sh`
 *      script (any script, not just a kind workflow), `-f-`/`-f -`, `kubectl
 *      create -f -`, and `-f <(curl …)`;
 *   3. the `|| true`/`|| :` defeat scan missed `|| exit 0`, `|| /bin/true`,
 *      `set +e`, and wrapping the check in `if ! fetch …; then …`.
 *
 * `unsafeApplies()` below replaces the old per-line, per-shape regexes with
 * one ordered scan: it tracks, per source, which local files were EVER the
 * target of a `curl`/`wget` fetch (`pendingFetch`), which of those were
 * subsequently checksum-verified (`verified` — by a direct `sha256sum -c`
 * naming that same token, OR by a call to a shell function whose OWN body
 * fetches-then-checksums one of its positional args, the `fetch()` pattern
 * both real scripts use), and which shell variables were ever assigned a
 * bare URL literal (`urlVars`). A `kubectl apply|create -f <arg>` is then
 * judged in this order:
 *   - `<(…)` containing curl/wget, or `-f -`/`-f-` fed by a pipeline
 *     containing curl/wget → ALWAYS unsafe (a stream can never be
 *     checksummed before `apply` reads it);
 *   - a literal `http(s)://` URL, or a variable known to hold one → unsafe;
 *   - a token that WAS fetched by curl/wget in this source but is not (yet)
 *     in `verified` at this point in the scan → unsafe;
 *   - anything else (a token never seen as a curl/wget target at all, e.g. a
 *     repo-committed manifest applied directly) → out of scope for this
 *     checksum-pinning concern, not flagged.
 * The last bullet is deliberate, not an oversight: `manifestInstallScripts()`
 * now scans broadly (any `.sh` file, any `kubectl apply|create -f`), and
 * several of those apply locally-authored manifests
 * (`apps/file-manager/platform-e2e/data-plane.yaml`,
 * `benchmarks/image-prewarm-oke/nodesh.sh`'s heredoc-generated job) that were
 * never fetched over the network and have nothing to checksum-verify.
 * Flagging every `kubectl apply -f <local-file>` in the repo would be a
 * different, much broader policy than #1289 asked for.
 */

const ROOT = join(import.meta.dirname, '..');

const CERT_MANAGER_SCRIPT = 'scripts/kind-manifests/apply-cert-manager.sh';
const KNATIVE_SCRIPT = 'scripts/kind-manifests/apply-knative-kourier.sh';
const PIN_SCRIPT = 'scripts/kind-manifests/pin-known-images.sh';
const DIGEST_TABLE = 'scripts/kind-manifests/image-digest-pins.json';
const NETPOL_DRILL_SCRIPT = 'packages/kn-next-operator/test/networkpolicy-enforcement-drill.sh';

function grepRepo(pattern: string): string[] {
  try {
    const out = execFileSync('git', ['grep', '-lE', pattern, '--', ':(exclude).claude/worktrees'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    return out.split('\n').filter(Boolean);
  } catch (e) {
    const err = e as { status?: number };
    if (err.status === 1) return [];
    throw e;
  }
}

/**
 * Every kind-based workflow, discovered by scanning — NEVER a hand-maintained
 * list (#1413 review). A workflow is "kind-based" if it stands up a kind
 * cluster, directly or via the `helm/kind-action` install step.
 */
function kindWorkflows(): string[] {
  return grepRepo('kind create cluster|helm/kind-action').filter((f) =>
    f.startsWith('.github/workflows/'),
  );
}

/**
 * Every shell script this repo ships that installs a cluster manifest by
 * URL — scanned the same way, so a new kind-drill script added later is
 * covered automatically rather than needing this file edited. #1410 review
 * round 3: broadened from `kubectl apply -f` to also catch `kubectl create
 * -f` (finding 2's exact bypass: a new script that uses `create` instead of
 * `apply` was previously invisible to this scan entirely).
 */
function manifestInstallScripts(): string[] {
  return grepRepo('kubectl (apply|create) -f').filter(
    (f) => f.endsWith('.sh') && !f.startsWith('.claude/'),
  );
}

/**
 * A named shell script body — one entry per `.sh` file, and one per GitHub
 * Actions workflow `run:` step (`<workflow>#<job>[<stepIndex>]`). #1413
 * review round 2: the earlier scan ONLY looked at `.sh` files, so a
 * `curl`-then-`apply` sequence inlined directly in a workflow's `run:` block
 * (never extracted into a `.sh` file) was invisible to it — exactly the
 * pattern file-manager-platform-e2e-nightly.yml used to have before it was
 * moved to the shared scripts (#1413 round 1).
 */
interface ScriptSource {
  id: string;
  text: string;
}

interface WorkflowStep {
  run?: string;
  uses?: string;
}
interface WorkflowJob {
  steps?: WorkflowStep[];
}
interface WorkflowDoc {
  jobs?: Record<string, WorkflowJob>;
}

function allScriptSources(): ScriptSource[] {
  const sources: ScriptSource[] = [];
  for (const f of manifestInstallScripts()) {
    sources.push({ id: f, text: readFileSync(join(ROOT, f), 'utf8') });
  }
  sources.push({
    id: NETPOL_DRILL_SCRIPT,
    text: readFileSync(join(ROOT, NETPOL_DRILL_SCRIPT), 'utf8'),
  });
  for (const wf of grepRepo('kubectl (apply|create) -f|curl\\b|wget\\b').filter((f) =>
    f.startsWith('.github/workflows/'),
  )) {
    const doc = parse(readFileSync(join(ROOT, wf), 'utf8')) as WorkflowDoc;
    for (const [jobId, job] of Object.entries(doc.jobs ?? {})) {
      (job.steps ?? []).forEach((step, i) => {
        if (
          typeof step.run === 'string' &&
          /kubectl (apply|create) -f|curl\b|wget\b/.test(step.run)
        ) {
          sources.push({ id: `${wf}#${jobId}[${i}]`, text: step.run });
        }
      });
    }
  }
  return sources;
}

// ---------------------------------------------------------------------------
// Low-level shell-text helpers shared by the unified apply-safety scanner.
// ---------------------------------------------------------------------------

/** Strips a trailing `# comment`, honoring simple quoting (not inside `'...'`/`"..."`). */
function stripComment(line: string): string {
  let inS = false;
  let inD = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS && line[i - 1] !== '\\') inD = !inD;
    else if (c === '#' && !inS && !inD && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Strips surrounding quotes and collapses `${NAME}` to `$NAME` for lexical token matching. */
function normalizeToken(tok: string): string {
  let t = tok.trim();
  t = t.replace(/^["']|["']$/g, '');
  t = t.replace(/^\$\{(\w+)\}$/, '$$$1');
  return t;
}

/**
 * Splits shell text into ordered "clauses" at top-level `&&`, `;`, and
 * newline boundaries, honoring quotes and `(...)`/`$(...)`/`<(...)` nesting
 * so those are never split. Deliberately does NOT split on `|`/`||` — a
 * pipeline (`curl … | kubectl apply -f -`, `echo … | sha256sum -c -`) must
 * stay one clause so its shape can be recognized as a whole.
 */
function splitClauses(text: string): string[] {
  const clauses: string[] = [];
  let cur = '';
  let depth = 0;
  let inS = false;
  let inD = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inS) {
      cur += c;
      if (c === "'") inS = false;
      i++;
      continue;
    }
    if (inD) {
      cur += c;
      if (c === '"' && text[i - 1] !== '\\') inD = false;
      i++;
      continue;
    }
    if (c === "'") {
      inS = true;
      cur += c;
      i++;
      continue;
    }
    if (c === '"') {
      inD = true;
      cur += c;
      i++;
      continue;
    }
    if (c === '(') {
      depth++;
      cur += c;
      i++;
      continue;
    }
    if (c === ')') {
      depth = Math.max(0, depth - 1);
      cur += c;
      i++;
      continue;
    }
    if (depth === 0) {
      if (text.slice(i, i + 2) === '&&') {
        clauses.push(cur);
        cur = '';
        i += 2;
        continue;
      }
      if (c === ';' || c === '\n') {
        clauses.push(cur);
        cur = '';
        i++;
        continue;
      }
    }
    cur += c;
    i++;
  }
  if (cur.trim()) clauses.push(cur);
  return clauses.map((c) => stripComment(c).trim()).filter(Boolean);
}

/** Splits a shell argument string into tokens, honoring simple quoting. */
function splitArgs(rest: string): string[] {
  const args: string[] = [];
  let cur = '';
  let inS = false;
  let inD = false;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (inS) {
      cur += c;
      if (c === "'") inS = false;
      continue;
    }
    if (inD) {
      cur += c;
      if (c === '"' && rest[i - 1] !== '\\') inD = false;
      continue;
    }
    if (c === "'") {
      inS = true;
      cur += c;
      continue;
    }
    if (c === '"') {
      inD = true;
      cur += c;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur) {
        args.push(cur);
        cur = '';
      }
      continue;
    }
    cur += c;
  }
  if (cur) args.push(cur);
  return args;
}

/**
 * Extracts the output-file token a `curl`/`wget` clause writes to, in ANY
 * flag spelling: `-o file`, a combined short-flag cluster ending in the
 * output letter (`-fsSLo file` for curl), `--output(-document)[= ]file`, a
 * bare shell redirect (`> file`, never `2>`/`&>`), or — with no explicit
 * target at all — the URL's own basename. curl and wget use DIFFERENT
 * letters for "write the body to this file" (`-o` vs `-O`), so they are
 * matched separately rather than treating `o`/`O` as interchangeable.
 */
function fetchTargetOf(clause: string): string | null {
  const hasCurl = /\bcurl\b/.test(clause);
  const hasWget = /\bwget\b/.test(clause);
  if (!hasCurl && !hasWget) return null;

  let m = clause.match(/--output(?:-document)?(?:=|\s+)"?(\S+?)"?(?:\s|$)/);
  if (m) return m[1];

  if (hasCurl) {
    m = clause.match(/(?:^|\s)-[a-zA-Z]*o[a-zA-Z]*\s+"?(\S+?)"?(?:\s|$)/);
    if (m) return m[1];
  } else {
    m = clause.match(/(?:^|\s)-[a-zA-Z]*O[a-zA-Z]*\s+"?(\S+?)"?(?:\s|$)/);
    if (m) return m[1];
  }

  m = clause.match(/(?<![012&>])>\s*"?(\S+?)"?(?:\s|$)/);
  if (m) return m[1];

  const urlM = clause.match(/https?:\/\/\S+/);
  if (urlM) {
    const url = urlM[0].replace(/["')]+$/, '');
    const base = url.split('/').filter(Boolean).pop();
    if (base) return base;
  }
  return null;
}

/**
 * Extracts the file token a `sha256sum -c` clause verifies, from the two
 * shapes both real scripts use: `echo "<hash>  <file>" | sha256sum -c -`
 * and `sha256sum -c <(echo "<hash>  <file>")`. Returns null for any other
 * shape (e.g. `sha256sum -c checksums.txt`, verifying a separate checksums
 * file) — such a clause verifies nothing this scanner can match to a
 * specific fetched token, so it correctly does NOT clear that token from
 * `pendingFetch`.
 */
function checksumTargetOf(clause: string): string | null {
  if (!/sha256sum\s+-c\b/.test(clause)) return null;
  let m = clause.match(/echo\s+"([^"]*)"\s*\|\s*sha256sum\s+-c\s+-/);
  if (!m) m = clause.match(/sha256sum\s+-c\s+<\(\s*echo\s+"([^"]*)"\s*\)/);
  if (!m) return null;
  const parts = m[1].trim().split(/\s+/);
  return parts.length >= 2 ? parts[parts.length - 1] : null;
}

/**
 * A clause "defeats" its own checksum/fetch verification if its exit status
 * is discarded — `|| <anything>` (not just `|| true`/`|| :`; `|| exit 0`,
 * `|| /bin/true`, `|| echo warn` are equally a discard) — if it runs under
 * `set +e` (errexit disabled, so a nonzero status here would not abort the
 * script), or if it is itself the test of an `if`/`elif` (the THEN branch's
 * handling can't be verified by a textual scan, so it fails closed).
 */
function isDefeated(clause: string, errexitDisabled: boolean): boolean {
  if (errexitDisabled) return true;
  if (/^\s*(if|elif)\b/.test(clause)) return true;
  const withoutLeadingIf = clause.replace(/^\s*(if|elif)\s+!?\s*/, '');
  return /\|\|/.test(withoutLeadingIf);
}

/** 1-based file-argument position for a helper function recognized as a trusted fetcher. */
interface FetcherInfo {
  fileArgIndex: number;
  selfVerifies: boolean;
}

/**
 * Finds `name() { ... }` single-level function definitions, analyzes each
 * body for the "fetches to a positional arg, then checksums that SAME arg"
 * shape (`fetch()` in both real scripts), and returns the body text with
 * those definitions spliced out (so the definition's own statements are not
 * re-scanned as if they executed at the top level) plus a name→FetcherInfo
 * map for recognizing CALL SITES later.
 */
function extractFunctions(text: string): { body: string; functions: Map<string, FetcherInfo> } {
  const functions = new Map<string, FetcherInfo>();
  const fnRe = /(^|\n)(\w+)\s*\(\)\s*\{([^{}]*)\}/g;
  let out = text;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
  while ((m = fnRe.exec(text))) {
    const [whole, , name, rawBody] = m;
    const bodyClauses = splitClauses(rawBody);
    let fileArgIndex: number | null = null;
    let selfVerifies = false;
    for (const c of bodyClauses) {
      const fetched = fetchTargetOf(c);
      if (fetched && /^\$\d+$/.test(fetched)) {
        fileArgIndex = Number(fetched.slice(1));
      }
    }
    if (fileArgIndex !== null) {
      for (const c of bodyClauses) {
        const verified = checksumTargetOf(c);
        if (verified === `$${fileArgIndex}` && !isDefeated(c, false)) {
          selfVerifies = true;
        }
      }
      functions.set(name, { fileArgIndex, selfVerifies });
    }
    out = out.replace(whole, '\n');
  }
  return { body: out, functions };
}

/**
 * Extracts the `kubectl apply|create -f` argument from a clause, in ANY
 * spacing: `-f -`/`-f-` (stdin), `-f <(...)` (process substitution),
 * `-f file`, `--filename[= ]file`. Quotes are left on the returned token;
 * callers normalize as needed.
 *
 * Only searches the text AFTER the `kubectl apply|create` verb, never the
 * whole clause — a clause like `curl -fsSL … | kubectl apply -f -` also
 * contains a literal `-f` inside curl's OWN combined short-flag cluster
 * (`-fsSL`), and an unanchored search would match THAT `-f` and misread its
 * following characters as the apply target instead of the real `-f -`.
 */
function applyTargetOf(clause: string): string | null {
  const verbM = clause.match(/\bkubectl\s+(?:apply|create)\b/);
  if (!verbM || verbM.index === undefined) return null;
  const rest = clause.slice(verbM.index + verbM[0].length);
  let m = rest.match(/-f\s*(<\([^()]*\))/);
  if (m) return m[1];
  m = rest.match(/--filename(?:=|\s+)(\S+)/);
  if (m) return m[1];
  m = rest.match(/-f\s*(\S+)/);
  if (m) return m[1];
  return null;
}

/**
 * The unified apply-safety scanner (#1410 review round 3). Walks a source's
 * clauses in order, tracking which local tokens were fetched, which of
 * those are checksum-verified at each point, which shell variables hold a
 * bare URL, and known trusted-fetcher functions — then judges every
 * `kubectl apply|create -f` against that running state. Returns one string
 * per offending clause.
 */
function unsafeApplies(rawText: string): string[] {
  const joined = rawText.replace(/\\\s*\n\s*/g, ' ');
  const { body, functions } = extractFunctions(joined);
  const offenders: string[] = [];

  const verified = new Set<string>();
  const pendingFetch = new Set<string>();
  const urlVars = new Set<string>();
  let errexitDisabled = false;

  for (const clause of splitClauses(body)) {
    if (/^set\s+\+e\b/.test(clause)) {
      errexitDisabled = true;
      continue;
    }
    if (/^set\s+-e\b/.test(clause)) {
      errexitDisabled = false;
      continue;
    }

    const assign = clause.match(/^(\w+)=(.*)$/);
    if (assign && !/^(if|elif|while|for)\b/.test(clause)) {
      const rhs = assign[2].replace(/^"/, '');
      if (/^https?:\/\//.test(rhs)) urlVars.add(`$${assign[1]}`);
    }

    const checksumTarget = checksumTargetOf(clause);
    // A fetcher call site can be wrapped in `if`/`elif`/`while` and/or a
    // leading `!` (`if ! fetch …; then …`) — strip that prefix before
    // looking for the call, or the "first word" would be `if`/`!` instead
    // of the function name and the call site would never be recognized.
    const callBody = clause.replace(/^\s*(if|elif|while)\b\s*/, '').replace(/^!\s*/, '');
    const callMatch = callBody.match(/^(\w+)\s+(.*)$/);
    const calledFetcher =
      callMatch && functions.has(callMatch[1]) ? functions.get(callMatch[1])! : null;

    if (checksumTarget || calledFetcher) {
      const defeated = isDefeated(clause, errexitDisabled);
      if (defeated) offenders.push(`defeated verification: ${clause}`);

      if (checksumTarget) {
        const norm = normalizeToken(checksumTarget);
        if (!defeated) verified.add(norm);
        pendingFetch.delete(norm);
      }
      if (calledFetcher && callMatch) {
        const args = splitArgs(callMatch[2]);
        const tok = args[calledFetcher.fileArgIndex - 1];
        if (tok) {
          const norm = normalizeToken(tok);
          if (calledFetcher.selfVerifies && !defeated) verified.add(norm);
          else pendingFetch.add(norm);
        }
      }
      continue;
    }

    const fetched = fetchTargetOf(clause);
    if (fetched) pendingFetch.add(normalizeToken(fetched));

    const target = applyTargetOf(clause);
    if (!target) continue;

    if (target.startsWith('<(')) {
      const inner = target.slice(2, -1);
      if (/\b(curl|wget)\b/.test(inner)) {
        offenders.push(`unverifiable process-substitution apply: ${clause}`);
      }
      continue;
    }
    if (target === '-') {
      if (/\b(curl|wget)\b/.test(clause)) {
        offenders.push(`unverifiable stdin-piped apply (fed by a network fetch): ${clause}`);
      }
      continue;
    }
    const bare = target.replace(/^["']|["']$/g, '');
    if (/^https?:\/\//.test(bare)) {
      offenders.push(`bare URL apply, no checksum possible: ${clause}`);
      continue;
    }
    const norm = normalizeToken(target);
    if (urlVars.has(norm)) {
      offenders.push(`apply of a variable known to hold a bare URL: ${clause}`);
      continue;
    }
    if (pendingFetch.has(norm) && !verified.has(norm)) {
      offenders.push(`apply of a fetched-but-not-checksum-verified file: ${clause}`);
    }
  }

  return offenders;
}

describe('kind-cluster cert-manager/Knative/Calico manifests are checksum + image-digest pinned (#1289)', () => {
  it('the kind-workflow scan itself is alive (finds all four known lanes)', () => {
    const found = kindWorkflows();
    expect(found).toContain('.github/workflows/operator-e2e-nightly.yml');
    expect(found).toContain('.github/workflows/operator-bundle-e2e.yml');
    expect(found).toContain('.github/workflows/file-manager-platform-e2e-nightly.yml');
    expect(found).toContain('.github/workflows/networkpolicy-enforcement.yml');
  });

  it('every workflow that installs cert-manager calls the shared script', () => {
    for (const wf of kindWorkflows()) {
      const text = readFileSync(join(ROOT, wf), 'utf8');
      if (!/cert-manager/i.test(text)) continue; // this lane doesn't touch cert-manager at all
      expect(text).toContain(CERT_MANAGER_SCRIPT);
    }
  });

  it('every workflow that installs Knative Serving/Kourier calls the shared script', () => {
    for (const wf of kindWorkflows()) {
      const text = readFileSync(join(ROOT, wf), 'utf8');
      if (!/knative|kourier/i.test(text)) continue;
      expect(text).toContain(KNATIVE_SCRIPT);
    }
  });

  it('no manifest-install source anywhere (script OR workflow run: step) has an unsafe kubectl apply|create -f — real scripts scan clean', () => {
    // Runs the unified scanner against every real source this repo ships.
    // Anything it flags here is either a real gap (fix the source) or a
    // false positive in the scanner itself (fix the scanner) — either way
    // this must be empty for the ACTUAL repo, distinct from the fixture
    // tests below which prove the scanner catches BAD constructs.
    const offenders: string[] = [];
    for (const src of allScriptSources()) {
      for (const bad of unsafeApplies(src.text)) {
        offenders.push(`${src.id}: ${bad}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('unsafeApplies() catches a single-line fetch-then-apply chain — the exact shape a folded YAML `run: >` block produces', () => {
    // #1410 review round 3, finding 1: the old scanner only looked at lines
    // AFTER the curl for a checksum, so everything on ONE line (as a folded
    // `run: >` block collapses to) sailed through.
    const offenders = unsafeApplies(
      'curl -sSL -o f "https://example.com/m.yaml" && kubectl apply -f f',
    );
    expect(offenders.length).toBeGreaterThan(0);
  });

  it('unsafeApplies() catches every curl/wget output-flag spelling finding 1 named', () => {
    const bad = [
      'curl -fsSLo f "https://example.com/m.yaml"\nkubectl apply -f f', // combined short flags
      'curl -sSL --output=f "https://example.com/m.yaml"\nkubectl apply -f f', // --output=
      'curl -sSL "https://example.com/m.yaml" > f\nkubectl apply -f f', // bare redirect
      'wget -O f "https://example.com/m.yaml"\nkubectl apply -f f', // wget
      // a helper function that wraps curl but never checksums its own output
      'download() { curl -fsSL -o "$2" "$1"; }\ndownload "https://example.com/m.yaml" f\nkubectl apply -f f',
    ];
    for (const src of bad) {
      expect(unsafeApplies(src).length).toBeGreaterThan(0);
    }
  });

  it('unsafeApplies() does NOT flag a genuinely checksum-verified fetch, including through a trusted-fetcher helper function', () => {
    const good = [
      'curl -fsSL -o f "https://example.com/m.yaml"\necho "abc  f" | sha256sum -c -\nkubectl apply -f f',
      'fetch() { curl -fsSL -o "$3" "$1"; echo "$2  $3" | sha256sum -c -; }\nfetch "https://example.com/m.yaml" "$SHA" f\nkubectl apply -f f',
    ];
    for (const src of good) {
      expect(unsafeApplies(src)).toEqual([]);
    }
  });

  it('unsafeApplies() catches every bare-URL / indirection shape finding 2 named, and does so on ANY script (not just kind workflows)', () => {
    const bad = [
      'kubectl apply -f https://example.com/m.yaml', // direct
      'URL=https://example.com/m.yaml\nkubectl apply -f "$URL"', // variable indirection
      'curl -fsSL "https://example.com/m.yaml" | kubectl apply -f -', // stdin from curl
      'curl -fsSL "https://example.com/m.yaml" | kubectl create -f -', // create verb, stdin
      'kubectl apply -f <(curl -fsSL "https://example.com/m.yaml")', // process substitution
    ];
    for (const src of bad) {
      expect(unsafeApplies(src).length).toBeGreaterThan(0);
    }
  });

  it('unsafeApplies() does NOT flag stdin/process-substitution applies fed by LOCAL/generated content, not a network fetch', () => {
    // The NetworkPolicy drill applies the operator's OWN rendered policy via
    // `echo "$POLICY" | kubectl apply -f -` — this is locally computed
    // content, not a downloaded release asset, so it is out of scope for
    // #1289's checksum-pinning concern and must not become a new false
    // positive under the stricter scanner.
    const good = 'POLICY=$(go run ./cmd/policygen)\necho "$POLICY" | kubectl apply -f -';
    expect(unsafeApplies(good)).toEqual([]);
  });

  it('unsafeApplies() does NOT flag an apply of a file that was never fetched by this source at all (a repo-committed manifest)', () => {
    const good = 'kubectl apply -f apps/file-manager/platform-e2e/data-plane.yaml';
    expect(unsafeApplies(good)).toEqual([]);
  });

  it('unsafeApplies() catches every verification-defeat shape finding 3 named', () => {
    const bad = [
      'curl -fsSL -o f "https://example.com/m.yaml"\necho "abc  f" | sha256sum -c - || true\nkubectl apply -f f',
      'curl -fsSL -o f "https://example.com/m.yaml"\necho "abc  f" | sha256sum -c - || exit 0\nkubectl apply -f f',
      'curl -fsSL -o f "https://example.com/m.yaml"\necho "abc  f" | sha256sum -c - || /bin/true\nkubectl apply -f f',
      'set +e\ncurl -fsSL -o f "https://example.com/m.yaml"\necho "abc  f" | sha256sum -c -\nset -e\nkubectl apply -f f',
      'fetch() { curl -fsSL -o "$3" "$1"; echo "$2  $3" | sha256sum -c -; }\nif ! fetch "https://example.com/m.yaml" "$SHA" f; then echo warn; fi\nkubectl apply -f f',
    ];
    for (const src of bad) {
      expect(unsafeApplies(src).length).toBeGreaterThan(0);
    }
  });

  it('apply-cert-manager.sh checksum-verifies the download before applying, and pins images with an expected count', () => {
    const text = readFileSync(join(ROOT, CERT_MANAGER_SCRIPT), 'utf8');
    expect(text).toContain('curl -fsSL');
    expect(text).toMatch(/sha256sum -c/);
    expect(text).toMatch(/pin-known-images\.sh"[^\n]*--expect \d+/);
    expect(text).toContain('kubectl apply -f');
    // The checksum verify must run BEFORE the apply — a script that applies
    // first and checks after has already done the damage.
    const shaIdx = text.indexOf('sha256sum -c');
    const applyIdx = text.indexOf('kubectl apply -f');
    expect(shaIdx).toBeGreaterThan(-1);
    expect(applyIdx).toBeGreaterThan(shaIdx);
  });

  it('apply-knative-kourier.sh checksum-verifies all three downloads before applying, and pins images with an expected count', () => {
    const text = readFileSync(join(ROOT, KNATIVE_SCRIPT), 'utf8');
    expect(text.match(/sha256sum -c/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(text).toMatch(/pin-known-images\.sh"[^\n]*--expect \d+/);
    // Three fetches (serving-crds, serving-core, kourier), three applies.
    expect(text.match(/kubectl apply -f/g)?.length ?? 0).toBe(3);
    const lastShaIdx = text.lastIndexOf('sha256sum -c');
    const firstApplyIdx = text.indexOf('kubectl apply -f');
    expect(firstApplyIdx).toBeGreaterThan(lastShaIdx);
  });

  it('the NetworkPolicy-enforcement drill checksum-verifies AND image-digest-pins Calico before applying it', () => {
    // #1413 review round 2, finding 4: the describe-block title above claims
    // "image-digest pinned" for every manifest this file covers, but until
    // this test the drill only checksummed the Calico MANIFEST — Calico's
    // three images (docker.io/calico/{cni,node,kube-controllers}:v3.28.2)
    // stayed tag-only, making the title's claim false for this one case.
    const text = readFileSync(join(ROOT, NETPOL_DRILL_SCRIPT), 'utf8');
    expect(text).toContain('curl -fsSL');
    expect(text).toMatch(/sha256sum -c/);
    expect(text).toMatch(/pin-known-images\.sh"[^\n]*--expect \d+/);
    const shaIdx = text.indexOf('sha256sum -c');
    const pinIdx = text.indexOf('pin-known-images.sh');
    const applyIdx = text.indexOf('kubectl apply -f');
    expect(shaIdx).toBeGreaterThan(-1);
    expect(pinIdx).toBeGreaterThan(shaIdx);
    expect(applyIdx).toBeGreaterThan(pinIdx);
  });

  it('image-digest-pins.json covers all three Calico images the drill pins', () => {
    const raw = readFileSync(join(ROOT, DIGEST_TABLE), 'utf8');
    const table = JSON.parse(raw) as Record<string, string>;
    for (const img of [
      'docker.io/calico/cni:v3.28.2',
      'docker.io/calico/node:v3.28.2',
      'docker.io/calico/kube-controllers:v3.28.2',
    ]) {
      expect(Object.hasOwn(table, img)).toBe(true);
      expect(table[img]).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it('pin-known-images.sh fails closed on a pin-count mismatch — BEHAVIOURALLY: exit code ≠ 0 against a manifest with the wrong number of known images', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pin-known-images-test-'));
    try {
      const manifest = join(dir, 'manifest.yaml');
      // Contains ZERO known images, but --expect 1 demands one pin.
      writeFileSync(manifest, 'apiVersion: v1\nkind: Pod\nspec: {}\n');
      let exitCode = 0;
      try {
        execFileSync('bash', [join(ROOT, PIN_SCRIPT), manifest, '--expect', '1'], {
          cwd: ROOT,
          stdio: 'pipe',
        });
      } catch (e) {
        exitCode = (e as { status?: number }).status ?? 1;
      }
      expect(exitCode).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pin-known-images.sh fails closed on a NEW, unrecognized mutable-tag image — BEHAVIOURALLY: exit code ≠ 0 even when the KNOWN images all pin correctly', () => {
    // #1413 review round 2: --expect only proves the table's KNOWN entries
    // still match; it says nothing about an image the table has never heard
    // of. This proves the standalone "any image: line lacking @sha256 fails"
    // guard added to pin-known-images.sh actually fires.
    const dir = mkdtempSync(join(tmpdir(), 'pin-known-images-test-'));
    try {
      const manifest = join(dir, 'manifest.yaml');
      writeFileSync(
        manifest,
        [
          'apiVersion: v1',
          'kind: Pod',
          'spec:',
          '  containers:',
          '    - name: cert-manager-controller',
          '      image: quay.io/jetstack/cert-manager-controller:v1.16.2',
          '    - name: new-sidecar',
          '      image: docker.io/newvendor/newimage:v2.0.0',
        ].join('\n'),
      );
      let exitCode = 0;
      try {
        execFileSync('bash', [join(ROOT, PIN_SCRIPT), manifest, '--expect', '1'], {
          cwd: ROOT,
          stdio: 'pipe',
        });
      } catch (e) {
        exitCode = (e as { status?: number }).status ?? 1;
      }
      expect(exitCode).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pin-known-images.sh fails closed on flow-style, JSON-style, and next-line image values (#1410 review round 3, finding 4)', () => {
    // The old scan anchored the whole line to `^...image:...$`, so it only
    // ever saw the block-style `image: repo:tag` (optionally list-prefixed)
    // form. Flow-style YAML (`{image: repo:tag}`), a JSON-quoted key
    // (`"image": "repo:tag"`), and a scalar value placed on the line AFTER
    // `image:` (also valid YAML) all sailed through unpinned.
    const dir = mkdtempSync(join(tmpdir(), 'pin-known-images-test-'));
    try {
      const manifest = join(dir, 'manifest.yaml');
      writeFileSync(
        manifest,
        [
          'apiVersion: v1',
          'kind: Pod',
          'spec:',
          '  containers:',
          '    - name: flowstyle',
          '      x: {image: docker.io/newvendor/flowimage:v2.0.0, name: foo}',
          '    - name: json',
          '      "image": "docker.io/newvendor/jsonimage:v3.0.0"',
          '    - name: nextline',
          '      image:',
          '        docker.io/newvendor/nextlineimage:v4.0.0',
        ].join('\n'),
      );
      let exitCode = 0;
      try {
        execFileSync('bash', [join(ROOT, PIN_SCRIPT), manifest, '--expect', '0'], {
          cwd: ROOT,
          stdio: 'pipe',
        });
      } catch (e) {
        exitCode = (e as { status?: number }).status ?? 1;
      }
      expect(exitCode).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pin-known-images.sh succeeds BEHAVIOURALLY on a fully-pinned, correctly-counted manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pin-known-images-test-'));
    try {
      const manifest = join(dir, 'manifest.yaml');
      writeFileSync(
        manifest,
        [
          'apiVersion: v1',
          'kind: Pod',
          'spec:',
          '  containers:',
          '    - name: cert-manager-controller',
          '      image: quay.io/jetstack/cert-manager-controller:v1.16.2',
        ].join('\n'),
      );
      // Must NOT throw.
      execFileSync('bash', [join(ROOT, PIN_SCRIPT), manifest, '--expect', '1'], {
        cwd: ROOT,
        stdio: 'pipe',
      });
      const pinned = readFileSync(manifest, 'utf8');
      expect(pinned).toContain('@sha256:');
      expect(pinned).not.toMatch(/image:.*:v1\.16\.2\s*$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('operator-bundle-e2e.yml triggers on changes to scripts/kind-manifests/** (a change there must re-run the e2e it feeds)', () => {
    const text = readFileSync(join(ROOT, '.github/workflows/operator-bundle-e2e.yml'), 'utf8');
    const occurrences = text.match(/scripts\/kind-manifests\/\*\*/g);
    // Both pull_request and push:branches[main] trigger blocks need the path.
    expect(occurrences?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('image-digest-pins.json entries are well-formed sha256 digests', () => {
    const raw = readFileSync(join(ROOT, DIGEST_TABLE), 'utf8');
    const table = JSON.parse(raw) as Record<string, string>;
    const entries = Object.entries(table).filter(([k]) => k !== '_comment');
    expect(entries.length).toBeGreaterThanOrEqual(4);
    for (const [ref, digest] of entries) {
      expect(ref).toMatch(/^[a-z0-9.-]+\/[a-z0-9-]+\/[a-z0-9-]+:[\w.-]+$/i);
      expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it('image-digest-pins.json attributes the rewrite behavior to the script that actually exists', () => {
    const raw = readFileSync(join(ROOT, DIGEST_TABLE), 'utf8');
    const table = JSON.parse(raw) as Record<string, string>;
    // The comment may mention the old, nonexistent script name to EXPLAIN the
    // correction, but the verb describing what actually rewrites the
    // manifest must be attached to the real script (pin-known-images.sh),
    // never left attributed to the one that does not exist.
    expect(table._comment).toMatch(/pin-known-images\.sh[\s\S]{0,80}rewrites/);
    expect(table._comment).not.toMatch(/(?<!not )apply-pinned-manifest\.sh[\s\S]{0,80}rewrites/i);
    // And the real script must actually be present on disk.
    expect(statSync(join(ROOT, PIN_SCRIPT)).isFile()).toBe(true);
  });

  it('all shell scripts are executable', () => {
    for (const script of [CERT_MANAGER_SCRIPT, KNATIVE_SCRIPT, PIN_SCRIPT]) {
      const mode = statSync(join(ROOT, script)).mode;
      const execBits = mode % 512; // low 9 bits: rwxrwxrwx
      expect(execBits & 0o111).toBeGreaterThan(0);
    }
  });
});

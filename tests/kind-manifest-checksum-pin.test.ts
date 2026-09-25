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
 * #1413 review (round 1410): the earlier version of this file (a) hardcoded
 * a 2-workflow list instead of scanning for every kind-based workflow, (b)
 * asserted only STRING PRESENCE of `sha256sum -c` / `exit 1`, which a
 * defeated fail-closed check (`sha256sum -c ... || true`, a no-op
 * `--expect` comparison, or a bare curl-then-apply that never calls
 * `sha256sum -c` at all) would still satisfy. This version scans EVERY kind
 * workflow dynamically and, where the check is local-file-only (no network
 * required), proves the fail-closed BEHAVIOUR by actually running the
 * script against a tampered fixture and asserting exit code ≠ 0.
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
 * covered automatically rather than needing this file edited.
 */
function manifestInstallScripts(): string[] {
  return grepRepo('kubectl apply -f').filter((f) => f.endsWith('.sh') && !f.startsWith('.claude/'));
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
  for (const wf of grepRepo('kubectl apply -f').filter((f) => f.startsWith('.github/workflows/'))) {
    const doc = parse(readFileSync(join(ROOT, wf), 'utf8')) as WorkflowDoc;
    for (const [jobId, job] of Object.entries(doc.jobs ?? {})) {
      (job.steps ?? []).forEach((step, i) => {
        if (typeof step.run === 'string' && /kubectl apply -f|curl\b/.test(step.run)) {
          sources.push({ id: `${wf}#${jobId}[${i}]`, text: step.run });
        }
      });
    }
  }
  return sources;
}

/**
 * A `curl` piped DIRECTLY into `kubectl apply -f -` — there is no way to
 * checksum-verify a stream before it lands in `apply`, so this shape is
 * ALWAYS a violation regardless of any `sha256sum` elsewhere in the script.
 * Joins backslash line-continuations first so a multi-line pipe is still
 * seen as one logical line.
 */
function curlPipedDirectlyToApply(text: string): string[] {
  const joined = text.replace(/\\\s*\n\s*/g, ' ');
  const offenders: string[] = [];
  for (const line of joined.split('\n')) {
    if (/curl\b[^\n]*\|[^\n]*kubectl apply -f -/.test(line)) {
      offenders.push(line.trim());
    }
  }
  return offenders;
}

/**
 * Every `curl` invocation writing to a file (`-o`/`--output`, in ANY flag
 * order/spelling — `-fsSL`, `-sSL`, `-Ls`, etc.) that is followed by a
 * `kubectl apply -f` of that SAME output before a `sha256sum -c` mentioning
 * it appears. #1413 review round 2's exact bypasses: (a) a bare
 * curl-to-file-then-apply INLINED IN A WORKFLOW step (not a `.sh` file —
 * `allScriptSources()` now covers both), (b) a `curl -sSL` (missing `-f`,
 * which the old `curl -fsSL`-only regex could not match).
 */
function curlToFileWithoutChecksum(text: string): string[] {
  const joined = text.replace(/\\\s*\n\s*/g, ' ');
  const lines = joined.split('\n');
  const offenders: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/\|[^\n]*kubectl apply -f -/.test(lines[i])) continue; // handled by the pipe rule above
    const m = lines[i].match(/curl\s+[^|\n]*(?:-o|--output)\s+"?(\$?\{?[\w./${}:-]+)"?/);
    if (!m) continue;
    const outFile = m[1];
    let verified = false;
    let sawApply = false;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].includes('sha256sum -c')) {
        verified = true;
        break;
      }
      if (lines[j].includes('kubectl apply -f') && lines[j].includes(outFile)) {
        sawApply = true;
        break;
      }
      if (/curl\s+[^|\n]*(?:-o|--output)/.test(lines[j])) break; // next fetch — stop this window
    }
    if (sawApply && !verified) {
      offenders.push(
        `${lines[i].trim()}  (fetched ${outFile}, never checksum-verified before its apply)`,
      );
    }
  }
  return offenders;
}

/**
 * `sha256sum -c` (or a call to the `fetch()` checksum-verifying helper) with
 * its exit status thrown away via `|| true` / `|| :` (`:` is POSIX `true`) —
 * silently converts a checksum MISMATCH into success. #1413 review round 2:
 * the earlier regex matched only the literal string `true`, missing `:`, and
 * only looked at `sha256sum -c` lines, missing a defeat on the `fetch` call
 * SITE (as opposed to inside the helper's own definition).
 */
function checksumOrFetchBypassed(text: string): string[] {
  // Join backslash line-continuations first — a `fetch a b \` `c || true`
  // call site spans two physical lines, and the `|| true` living on the
  // CONTINUATION line must still be attributed to the `fetch` call it
  // defeats, not treated as an unrelated line with nothing to flag.
  const joined = text.replace(/\\\s*\n\s*/g, ' ');
  const offenders: string[] = [];
  for (const line of joined.split('\n')) {
    const isChecksumLine = /sha256sum -c/.test(line);
    const isFetchCallSite = /^\s*fetch\s+["'$]/.test(line);
    if ((isChecksumLine || isFetchCallSite) && /\|\|\s*(true\b|:(\s|$))/.test(line)) {
      offenders.push(line.trim());
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

  it('no kind workflow bare-applies a manifest URL — every install goes through a checksum-verified path', () => {
    const offenders: string[] = [];
    for (const wf of kindWorkflows()) {
      const text = readFileSync(join(ROOT, wf), 'utf8');
      if (/kubectl apply -f "?https?:/.test(text)) offenders.push(wf);
    }
    expect(offenders).toEqual([]);
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

  it('no manifest-install source anywhere (script OR workflow run: step) defeats its own checksum with `|| true` / `|| :`, on a checksum line or a fetch() call site', () => {
    // #1413 review round 2: the earlier version only matched the literal
    // string `true`, never POSIX `:`, and only looked at `sha256sum -c`
    // lines, never a `fetch ... || true` at a CALL SITE of the checksum-
    // verifying helper apply-knative-kourier.sh defines.
    const offenders: string[] = [];
    for (const src of allScriptSources()) {
      for (const bad of checksumOrFetchBypassed(src.text)) {
        offenders.push(`${src.id}: ${bad}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no curl is piped DIRECTLY into `kubectl apply -f -` — a stream can never be checksum-verified before it lands in apply', () => {
    const offenders: string[] = [];
    for (const src of allScriptSources()) {
      for (const bad of curlPipedDirectlyToApply(src.text)) {
        offenders.push(`${src.id}: ${bad}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no curl-to-file (ANY flag spelling, script OR workflow run: step) skips checksum verification before its apply', () => {
    // #1413 review round 2's exact bypasses: (a) a bare curl-to-file-then-
    // apply INLINED IN A WORKFLOW step, never extracted to a `.sh` file —
    // `allScriptSources()` now scans workflow `run:` blocks too; (b) a
    // `curl -sSL` (missing `-f`) that the old `curl -fsSL`-only regex could
    // not match — this scan is flag-agnostic.
    const offenders: string[] = [];
    for (const src of allScriptSources()) {
      for (const bad of curlToFileWithoutChecksum(src.text)) {
        offenders.push(`${src.id}: ${bad}`);
      }
    }
    expect(offenders).toEqual([]);
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

import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  it('no manifest-install script anywhere defeats its own checksum check with `|| true` (or similar)', () => {
    // A `sha256sum -c ... || true` (or `; true`) silently swallows a checksum
    // MISMATCH — the exact failure mode a checksum pin exists to catch. Scan
    // every script that applies a manifest, not just the two shared helpers.
    const offenders: string[] = [];
    for (const script of [...manifestInstallScripts(), NETPOL_DRILL_SCRIPT]) {
      const text = readFileSync(join(ROOT, script), 'utf8');
      for (const line of text.split('\n')) {
        if (/sha256sum -c/.test(line) && /\|\|\s*true|;\s*true\s*$/.test(line)) {
          offenders.push(`${script}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no curl-then-apply skips checksum verification — every `curl -fsSL -o <file>` in a manifest-install script is followed by a `sha256sum -c` on that same file before the next `kubectl apply -f`', () => {
    const offenders: string[] = [];
    for (const script of [...manifestInstallScripts(), NETPOL_DRILL_SCRIPT]) {
      const text = readFileSync(join(ROOT, script), 'utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!/curl -fsSL/.test(lines[i])) continue;
        // Look ahead (bounded window) for a checksum verify before the next apply.
        let sawChecksum = false;
        let sawApplyFirst = false;
        for (let j = i + 1; j < Math.min(i + 15, lines.length); j++) {
          if (/sha256sum -c/.test(lines[j])) {
            sawChecksum = true;
            break;
          }
          if (/kubectl apply -f/.test(lines[j])) {
            sawApplyFirst = true;
            break;
          }
        }
        if (!sawChecksum && sawApplyFirst) {
          offenders.push(`${script}:${i + 1}: ${lines[i].trim()}`);
        }
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

  it('the NetworkPolicy-enforcement drill checksum-verifies Calico before applying it', () => {
    const text = readFileSync(join(ROOT, NETPOL_DRILL_SCRIPT), 'utf8');
    expect(text).toContain('curl -fsSL');
    expect(text).toMatch(/sha256sum -c/);
    const shaIdx = text.indexOf('sha256sum -c');
    const applyIdx = text.indexOf('kubectl apply -f');
    expect(shaIdx).toBeGreaterThan(-1);
    expect(applyIdx).toBeGreaterThan(shaIdx);
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

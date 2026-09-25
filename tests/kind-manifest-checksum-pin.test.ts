import { describe, expect, it } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * #1289: checksum-pin the cert-manager/Knative/Kourier cluster manifests AND
 * digest-pin the mutable-tag IMAGES those manifests reference, across every
 * kind-based operator e2e workflow — `operator-e2e-nightly.yml` and
 * `operator-bundle-e2e.yml` used to `kubectl apply -f <url>` those manifests
 * directly, with NO checksum at all: a moved/edited release asset would have
 * applied silently, unlike `file-manager-platform-e2e-nightly.yml`'s own
 * fetch+verify pattern (#1381/#1292), which this generalizes into one shared,
 * reusable script pair so the two lanes cannot drift apart.
 *
 * `scripts/kind-manifests/apply-cert-manager.sh` and
 * `apply-knative-kourier.sh` are the single "fetch + checksum-verify +
 * image-digest-pin + apply" helper both workflows now call — checked
 * statically here (never executed against a real network from a test).
 */

const ROOT = join(import.meta.dirname, '..');
const WORKFLOWS = [
  '.github/workflows/operator-e2e-nightly.yml',
  '.github/workflows/operator-bundle-e2e.yml',
];

const CERT_MANAGER_SCRIPT = 'scripts/kind-manifests/apply-cert-manager.sh';
const KNATIVE_SCRIPT = 'scripts/kind-manifests/apply-knative-kourier.sh';
const PIN_SCRIPT = 'scripts/kind-manifests/pin-known-images.sh';
const DIGEST_TABLE = 'scripts/kind-manifests/image-digest-pins.json';

describe('kind-cluster cert-manager/Knative manifests are checksum + image-digest pinned (#1289)', () => {
  it('no workflow bare-applies a manifest URL — every cert-manager/Knative install goes through the shared scripts', () => {
    for (const wf of WORKFLOWS) {
      const text = readFileSync(join(ROOT, wf), 'utf8');
      expect(text).not.toMatch(/kubectl apply -f "?https?:/);
    }
  });

  it('every workflow that installs cert-manager calls the shared script', () => {
    for (const wf of WORKFLOWS) {
      const text = readFileSync(join(ROOT, wf), 'utf8');
      const occurrences = text.match(new RegExp(CERT_MANAGER_SCRIPT.replace(/[/.]/g, '\\$&'), 'g'));
      expect(occurrences?.length ?? 0).toBeGreaterThanOrEqual(1);
    }
  });

  it('every workflow that installs Knative Serving/Kourier calls the shared script', () => {
    for (const wf of WORKFLOWS) {
      const text = readFileSync(join(ROOT, wf), 'utf8');
      const occurrences = text.match(new RegExp(KNATIVE_SCRIPT.replace(/[/.]/g, '\\$&'), 'g'));
      expect(occurrences?.length ?? 0).toBeGreaterThanOrEqual(1);
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

  it('pin-known-images.sh fails closed on a pin-count mismatch (never silently applies an unpinned image)', () => {
    const text = readFileSync(join(ROOT, PIN_SCRIPT), 'utf8');
    expect(text).toContain('set -euo pipefail');
    expect(text).toMatch(/exit 1/);
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

  it('all shell scripts are executable', () => {
    for (const script of [CERT_MANAGER_SCRIPT, KNATIVE_SCRIPT, PIN_SCRIPT]) {
      const mode = statSync(join(ROOT, script)).mode;
      const execBits = mode % 512; // low 9 bits: rwxrwxrwx
      expect(execBits & 0o111).toBeGreaterThan(0);
    }
  });
});

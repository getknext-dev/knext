import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * AWS Marketplace-bound operator image (#1954).
 *
 * Marketplace rejects an image index that carries attestation (in-toto)
 * manifests; `operator-supply-chain.yml` builds with `provenance: mode=max`, so
 * the GHCR index does. Two scripts derive and prove the attestation-free
 * variant WITHOUT rebuilding:
 *
 *   hack/marketplace-index-build.sh   gated OCI layout -> new index, same platform manifests
 *   hack/marketplace-index-assert.sh  registry proof: no attestations + identical config/layers
 *
 * Both are exercised here against a synthetic buildx-shaped layout (a nested
 * index holding two platform manifests plus two attestation manifests), and a
 * fake `crane` that serves manifests from blob directories. Every negative case
 * is a way the Marketplace image could silently be wrong.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const HACK = resolve(REPO_ROOT, 'packages/kn-next-operator/hack');
const BUILD = resolve(HACK, 'marketplace-index-build.sh');
const ASSERT = resolve(HACK, 'marketplace-index-assert.sh');
const WORKFLOW = resolve(REPO_ROOT, '.github/workflows/operator-supply-chain.yml');

const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const OCI_CONFIG = 'application/vnd.oci.image.config.v1+json';

interface Desc {
  mediaType: string;
  digest: string;
  size: number;
  platform?: { architecture: string; os: string };
  annotations?: Record<string, string>;
}

function sha(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Writes content-addressed blobs into <dir>/blobs/sha256. */
class Layout {
  constructor(readonly dir: string) {
    mkdirSync(join(dir, 'blobs/sha256'), { recursive: true });
    writeFileSync(join(dir, 'oci-layout'), '{"imageLayoutVersion":"1.0.0"}');
  }
  put(content: Buffer | string, mediaType: string): Desc {
    const hex = sha(content);
    writeFileSync(join(this.dir, 'blobs/sha256', hex), content);
    return { mediaType, digest: `sha256:${hex}`, size: Buffer.byteLength(content) };
  }
  setNested(nested: Desc): void {
    writeFileSync(
      join(this.dir, 'index.json'),
      JSON.stringify({ schemaVersion: 2, manifests: [nested] }),
    );
  }
}

interface Fixture {
  layout: Layout;
  nested: Desc;
  platforms: Desc[];
  attestations: Desc[];
  layerDigests: Record<string, string>; // arch -> layer digest
}

/** A buildx-shaped multi-arch layout, optionally with the attestation entries. */
function makeGatedLayout(root: string, opts: { attestations?: boolean } = {}): Fixture {
  const layout = new Layout(join(root, 'gated'));
  const platforms: Desc[] = [];
  const attestations: Desc[] = [];
  const layerDigests: Record<string, string> = {};
  for (const architecture of ['amd64', 'arm64']) {
    const config = layout.put(JSON.stringify({ architecture, os: 'linux' }), OCI_CONFIG);
    const layer = layout.put(
      `layer-bytes-${architecture}`,
      'application/vnd.oci.image.layer.v1.tar+gzip',
    );
    layerDigests[architecture] = layer.digest;
    const manifest = layout.put(
      JSON.stringify({ schemaVersion: 2, mediaType: OCI_MANIFEST, config, layers: [layer] }),
      OCI_MANIFEST,
    );
    platforms.push({ ...manifest, platform: { architecture, os: 'linux' } });
    if (opts.attestations !== false) {
      const attConfig = layout.put('{}', OCI_CONFIG);
      const attLayer = layout.put(
        `{"predicateType":"slsa-${architecture}"}`,
        'application/vnd.in-toto+json',
      );
      const attManifest = layout.put(
        JSON.stringify({
          schemaVersion: 2,
          mediaType: OCI_MANIFEST,
          config: attConfig,
          layers: [
            {
              ...attLayer,
              annotations: { 'in-toto.io/predicate-type': 'https://slsa.dev/provenance/v0.2' },
            },
          ],
        }),
        OCI_MANIFEST,
      );
      attestations.push({
        ...attManifest,
        platform: { architecture: 'unknown', os: 'unknown' },
        annotations: {
          'vnd.docker.reference.type': 'attestation-manifest',
          'vnd.docker.reference.digest': manifest.digest,
        },
      });
    }
  }
  const nestedBody = JSON.stringify({
    schemaVersion: 2,
    mediaType: OCI_INDEX,
    manifests: [...platforms, ...attestations],
  });
  const nested = layout.put(nestedBody, OCI_INDEX);
  layout.setNested(nested);
  return { layout, nested, platforms, attestations, layerDigests };
}

function sh(cmd: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/**
 * A fake `crane`: `crane manifest <repo>@sha256:<hex>` prints the blob of that
 * name from the first directory that has it (FAKE_GATED_DIRS for the repo named
 * ".../gated", FAKE_MP_DIRS for any other); exit 1 if none (the "unreachable
 * registry / missing ref" case). The two repos are separate so a test can make
 * them disagree about what one digest contains, as a lying registry would.
 */
function fakeCrane(root: string): string {
  const path = join(root, 'fake-crane');
  writeFileSync(
    path,
    `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" = "manifest" ]] || { echo "fake crane: unsupported $1" >&2; exit 2; }
hex="\${2##*@sha256:}"
case "$2" in
  */gated@*) IFS=: read -ra dirs <<< "\${FAKE_GATED_DIRS}" ;;
  *) IFS=: read -ra dirs <<< "\${FAKE_MP_DIRS}" ;;
esac
for d in "\${dirs[@]}"; do
  if [[ -f "$d/$hex" ]]; then cat "$d/$hex"; exit 0; fi
done
echo "fake crane: not found $2" >&2
exit 1
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function build(src: string, dest: string) {
  return sh('bash', [BUILD, src, dest]);
}

function nestedOf(layoutDir: string): { mediaType: string; manifests: Desc[] } {
  const top = JSON.parse(readFileSync(join(layoutDir, 'index.json'), 'utf8'));
  expect(top.manifests).toHaveLength(1);
  const hex = (top.manifests[0].digest as string).replace('sha256:', '');
  return JSON.parse(readFileSync(join(layoutDir, 'blobs/sha256', hex), 'utf8'));
}

const tempRoots: string[] = [];
afterAll(() => {
  for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
});

function scratch(): string {
  const r = mkdtempSync(join(tmpdir(), 'mp-index-'));
  tempRoots.push(r);
  return r;
}

describe('marketplace-index-build.sh (#1954)', () => {
  it('drops every attestation manifest and keeps every platform manifest byte-identical', () => {
    const root = scratch();
    try {
      const fx = makeGatedLayout(root);
      const dest = join(root, 'mp');
      const r = build(fx.layout.dir, dest);
      expect(r.code).toBe(0);

      const idx = nestedOf(dest);
      expect(idx.mediaType).toBe(OCI_INDEX);
      expect(idx.manifests).toEqual(fx.platforms); // verbatim entries, same digests
      for (const m of idx.manifests) {
        expect(m.annotations?.['vnd.docker.reference.type']).toBeUndefined();
        expect(m.platform?.os).not.toBe('unknown');
      }
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it('writes a content-addressed index blob (the digest in index.json is the sha256 of its bytes)', () => {
    const root = scratch();
    try {
      const fx = makeGatedLayout(root);
      const dest = join(root, 'mp');
      expect(build(fx.layout.dir, dest).code).toBe(0);
      const top = JSON.parse(readFileSync(join(dest, 'index.json'), 'utf8'));
      const hex = top.manifests[0].digest.replace('sha256:', '');
      const bytes = readFileSync(join(dest, 'blobs/sha256', hex));
      expect(sha(bytes)).toBe(hex);
      expect(top.manifests[0].size).toBe(bytes.length);
      // and it differs from the gated index (otherwise nothing was stripped)
      expect(top.manifests[0].digest).not.toBe(fx.nested.digest);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it('makes every platform manifest, config and layer blob resolvable in the output layout', () => {
    const root = scratch();
    try {
      const fx = makeGatedLayout(root);
      const dest = join(root, 'mp');
      expect(build(fx.layout.dir, dest).code).toBe(0);
      for (const d of [...Object.values(fx.layerDigests), ...fx.platforms.map((p) => p.digest)]) {
        expect(existsSync(join(dest, 'blobs/sha256', d.replace('sha256:', '')))).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it('emits regular files, never symlinks (go-containerregistry rejects symlinked layout blobs)', () => {
    const root = scratch();
    try {
      const fx = makeGatedLayout(root);
      const dest = join(root, 'mp');
      expect(build(fx.layout.dir, dest).code).toBe(0);
      for (const f of readdirSync(join(dest, 'blobs/sha256'))) {
        expect(lstatSync(join(dest, 'blobs/sha256', f)).isSymbolicLink()).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it('never modifies the gated layout it reads from', () => {
    const root = scratch();
    try {
      const fx = makeGatedLayout(root);
      const before = readdirSync(join(fx.layout.dir, 'blobs/sha256')).sort();
      const indexBefore = readFileSync(join(fx.layout.dir, 'index.json'), 'utf8');
      expect(build(fx.layout.dir, join(root, 'mp')).code).toBe(0);
      expect(readdirSync(join(fx.layout.dir, 'blobs/sha256')).sort()).toEqual(before);
      expect(readFileSync(join(fx.layout.dir, 'index.json'), 'utf8')).toBe(indexBefore);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it('is a no-op strip (still succeeds) when the source has no attestations', () => {
    const root = scratch();
    try {
      const fx = makeGatedLayout(root, { attestations: false });
      const r = build(fx.layout.dir, join(root, 'mp'));
      expect(r.code).toBe(0);
      expect(r.out).toContain('dropped 0 attestation');
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it('fails loud on a malformed source: missing index.json, existing dest, non-index top entry', () => {
    const root = scratch();
    try {
      mkdirSync(join(root, 'empty'));
      expect(build(join(root, 'empty'), join(root, 'o1')).code).toBe(1);

      const fx = makeGatedLayout(root);
      mkdirSync(join(root, 'taken'));
      expect(build(fx.layout.dir, join(root, 'taken')).code).toBe(1);

      // top-level entry is an image manifest, not an index
      const bad = new Layout(join(root, 'bad'));
      const m = bad.put('{"schemaVersion":2}', OCI_MANIFEST);
      bad.setNested(m);
      expect(build(bad.dir, join(root, 'o3')).code).toBe(1);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it('refuses to produce an index with no platform manifests left', () => {
    const root = scratch();
    try {
      const only = new Layout(join(root, 'only-att'));
      const att = only.put('{"schemaVersion":2}', OCI_MANIFEST);
      const nested = only.put(
        JSON.stringify({
          schemaVersion: 2,
          mediaType: OCI_INDEX,
          manifests: [
            {
              ...att,
              platform: { architecture: 'unknown', os: 'unknown' },
              annotations: { 'vnd.docker.reference.type': 'attestation-manifest' },
            },
          ],
        }),
        OCI_INDEX,
      );
      only.setNested(nested);
      expect(build(only.dir, join(root, 'o')).code).toBe(1);
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});

describe('marketplace-index-assert.sh (#1954)', () => {
  const GATED_REF = 'ghcr.io/o/gated@sha256:';
  const MP_REF = 'ghcr.io/o/mp@sha256:';

  /** Builds gated + derived layouts and returns a runner for the assertion. */
  function setup(root: string) {
    const fx = makeGatedLayout(root);
    const mpDir = join(root, 'mp');
    expect(build(fx.layout.dir, mpDir).code).toBe(0);
    const mpDigest = JSON.parse(readFileSync(join(mpDir, 'index.json'), 'utf8')).manifests[0]
      .digest as string;
    const crane = fakeCrane(root);
    const gatedBlobs = join(fx.layout.dir, 'blobs/sha256');
    const run = (
      mpBlobsDir = join(mpDir, 'blobs/sha256'),
      mp = mpDigest,
      gated = fx.nested.digest,
    ) =>
      sh(
        'bash',
        [
          ASSERT,
          `${GATED_REF}${gated.replace('sha256:', '')}`,
          `${MP_REF}${mp.replace('sha256:', '')}`,
        ],
        {
          CRANE: crane,
          FAKE_GATED_DIRS: gatedBlobs,
          FAKE_MP_DIRS: mpBlobsDir,
        },
      );
    return { fx, mpDir, mpDigest, run, gatedBlobs };
  }

  it('PASSES for the index produced by marketplace-index-build.sh', () => {
    const root = scratch();
    try {
      const { run } = setup(root);
      const r = run();
      expect(r.err).toBe('');
      expect(r.code).toBe(0);
      expect(r.out).toContain('no attestation manifests');
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it('FAILS when the Marketplace ref is the gated index (attestations still present)', () => {
    const root = scratch();
    try {
      const { fx, run } = setup(root);
      const r = run(join(fx.layout.dir, 'blobs/sha256'), fx.nested.digest);
      expect(r.code).toBe(1);
      expect(r.err).toContain('attestation manifest');
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it('FAILS when only an unknown/unknown platform entry remains (annotation stripped)', () => {
    const root = scratch();
    try {
      const { fx, mpDir, run } = setup(root);
      const bad = new Layout(mpDir); // writes into the same blobs dir
      const idx = {
        schemaVersion: 2,
        mediaType: OCI_INDEX,
        manifests: [...fx.platforms, { ...fx.attestations[0], annotations: undefined }],
      };
      const d = bad.put(JSON.stringify(idx), OCI_INDEX);
      const r = run(join(mpDir, 'blobs/sha256'), d.digest);
      expect(r.code).toBe(1);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it('FAILS when a platform manifest carries an in-toto layer', () => {
    const root = scratch();
    try {
      const { fx, mpDir, run } = setup(root);
      const bad = new Layout(mpDir);
      const cfg = bad.put('{"architecture":"amd64","os":"linux"}', OCI_CONFIG);
      const layer = bad.put('x', 'application/vnd.in-toto+json');
      const m = bad.put(
        JSON.stringify({ schemaVersion: 2, mediaType: OCI_MANIFEST, config: cfg, layers: [layer] }),
        OCI_MANIFEST,
      );
      const idx = bad.put(
        JSON.stringify({
          schemaVersion: 2,
          mediaType: OCI_INDEX,
          manifests: [{ ...m, platform: { architecture: 'amd64', os: 'linux' } }, fx.platforms[1]],
        }),
        OCI_INDEX,
      );
      const r = run(join(mpDir, 'blobs/sha256'), idx.digest);
      expect(r.code).toBe(1);
      expect(r.err).toContain('in-toto layer');
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it('FAILS when a platform manifest differs from the gated one (different layer bits)', () => {
    const root = scratch();
    try {
      const { fx, mpDir, run } = setup(root);
      const bad = new Layout(mpDir);
      const cfg = bad.put('{"architecture":"amd64","os":"linux"}', OCI_CONFIG);
      const layer = bad.put('DIFFERENT-LAYER', 'application/vnd.oci.image.layer.v1.tar+gzip');
      const m = bad.put(
        JSON.stringify({ schemaVersion: 2, mediaType: OCI_MANIFEST, config: cfg, layers: [layer] }),
        OCI_MANIFEST,
      );
      const idx = bad.put(
        JSON.stringify({
          schemaVersion: 2,
          mediaType: OCI_INDEX,
          manifests: [{ ...m, platform: { architecture: 'amd64', os: 'linux' } }, fx.platforms[1]],
        }),
        OCI_INDEX,
      );
      const r = run(join(mpDir, 'blobs/sha256'), idx.digest);
      expect(r.code).toBe(1);
      expect(r.err).toContain('platform entries differ');
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it('FAILS when a platform is missing from the Marketplace index', () => {
    const root = scratch();
    try {
      const { fx, mpDir, run } = setup(root);
      const bad = new Layout(mpDir);
      const idx = bad.put(
        JSON.stringify({ schemaVersion: 2, mediaType: OCI_INDEX, manifests: [fx.platforms[0]] }),
        OCI_INDEX,
      );
      const r = run(join(mpDir, 'blobs/sha256'), idx.digest);
      expect(r.code).toBe(1);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it('FAILS when the same platform digest resolves to different layers in the two repos', () => {
    const root = scratch();
    try {
      const { fx, mpDir, run } = setup(root);
      const tampered = join(root, 'tampered');
      mkdirSync(tampered);
      const amd = fx.platforms[0].digest.replace('sha256:', '');
      const real = JSON.parse(readFileSync(join(fx.layout.dir, 'blobs/sha256', amd), 'utf8'));
      real.layers[0].digest = `sha256:${'a'.repeat(64)}`;
      writeFileSync(join(tampered, amd), JSON.stringify(real));
      const r = run(`${tampered}:${join(mpDir, 'blobs/sha256')}`);
      expect(r.code).toBe(1);
      expect(r.err).toContain('config/layer digests differ');
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it('FAILS (never passes) when the registry cannot be reached / the ref is missing', () => {
    const root = scratch();
    try {
      const { run } = setup(root);
      const empty = join(root, 'empty');
      mkdirSync(empty);
      const r = run(empty);
      expect(r.code).toBe(1);
      expect(r.err).toContain('could not fetch manifest');
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});

describe('operator-supply-chain.yml wires the Marketplace variant (#1954)', () => {
  const text = readFileSync(WORKFLOW, 'utf8');

  function step(name: string): string {
    const blocks = text.split(/\n(?= {6}- (?:name|uses):)/);
    const hit = blocks.find((b) => b.includes(`name: ${name}`));
    if (!hit) throw new Error(`no step named ${name}`);
    return hit;
  }

  it('builds the attestation-free layout from the gated OCI layout, and does not rebuild', () => {
    const s = step('Derive attestation-free Marketplace index (#1954)');
    expect(s).toContain('marketplace-index-build.sh operator-oci operator-oci-mp');
    expect(text.match(/docker\/build-push-action@/g)?.length).toBe(1);
    // the GHCR build keeps provenance
    expect(text).toMatch(/\n\s+provenance: mode=max\n/);
  });

  it('pushes, asserts, signs and tags only on version tags, after the Trivy gate', () => {
    for (const n of [
      'Push Marketplace index (version tags only, #1954)',
      'Assert Marketplace index has no attestations and identical bits (#1954)',
      'Sign + verify Marketplace index (version tags only, #1954)',
      'Tag the Marketplace index (version tags only, #1954)',
    ]) {
      const s = step(n);
      expect(s).toContain("steps.channel.outputs.is_version_tag == 'true'");
      expect(s).toContain("steps.trivy.outcome == 'success'");
    }
  });

  it('orders: gated sign+verify -> push -> assert -> sign -> mp tag -> gated vX.Y.Z tag (no release tag exists unless every Marketplace step passed)', () => {
    const at = (n: string) => text.indexOf(`name: ${n}`);
    const order = [
      'Verify operator image signature (cosign verify, publish channel)',
      'Push Marketplace index (version tags only, #1954)',
      'Assert Marketplace index has no attestations and identical bits (#1954)',
      'Sign + verify Marketplace index (version tags only, #1954)',
      'Tag the Marketplace index (version tags only, #1954)',
      'Tag the verified digest with the release version (version tags only, #1947)',
    ].map(at);
    for (const i of order) expect(i).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('pushes under a throwaway sha tag first, and only a late step applies the -mp version tag', () => {
    expect(step('Push Marketplace index (version tags only, #1954)')).toContain('GITHUB_SHA}-mp');
    const tag = step('Tag the Marketplace index (version tags only, #1954)');
    expect(tag).toContain('crane tag');
    expect(tag).toContain('-mp"');
    expect(text.match(/crane tag /g)?.length).toBe(2); // v<version> (#1947) and v<version>-mp
  });

  it('runs the assertion script against the pushed gated digest and the pushed Marketplace digest', () => {
    const s = step('Assert Marketplace index has no attestations and identical bits (#1954)');
    expect(s).toMatch(/\n\s+run: bash \S*marketplace-index-assert\.sh /);
    expect(s).toContain('steps.push.outputs.digest');
    expect(s).toContain('steps.push_mp.outputs.digest');
  });

  it('adds no new permissions, secrets or third-party actions', () => {
    const jobPerms = text.match(/permissions:\n\s+contents: write[\s\S]*?id-token: write[^\n]*/);
    expect(jobPerms).not.toBeNull();
    const usesLines = text.split('\n').filter((l) => /^\s+(- )?uses:/.test(l));
    for (const l of usesLines) expect(l).toMatch(/@[0-9a-f]{40} # v\d/);
    // the only secret is the built-in token
    const secrets = [...text.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]);
    expect(new Set(secrets)).toEqual(new Set(['GITHUB_TOKEN']));
  });
});

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseAllDocuments } from 'yaml';

/**
 * Every container image knext's database plane and the file-manager e2e data
 * plane reference must be fully qualified (registry host first) and, on the
 * default apply path, pinned by digest.
 *
 * CRI-O (OKE's runtime) has no default registry: `neondatabase/neon:8464` or
 * `redis:7-alpine` fails with ImageInspectError there, while Docker/containerd
 * silently add `docker.io/`. A reference is qualified when its first path
 * segment is a registry host: it contains a `.` or `:`, or is `localhost`
 * (the same rule the container runtimes use).
 *
 * This SCANS rather than enumerates: parsed YAML (every `image:` at any depth),
 * plus the shell scripts and Go sources that RENDER images (`image:` lines in
 * heredocs, `--image=`, `*_IMG` / `*_IMAGE` variables, Go `Image:` fields), so a
 * new manifest or a new script default cannot slip past. An unparseable
 * manifest FAILS rather than being skipped.
 */
const ROOT = join(import.meta.dir, '..');
const SZPG = join(ROOT, 'packages', 'scale-zero-pg');
const DEPLOY = join(SZPG, 'deploy');
const DATA_PLANE = join(ROOT, 'apps', 'file-manager', 'platform-e2e', 'data-plane.yaml');

/** `bakeoff/` is a throwaway comparison harness (locally built dev images, a vendored third-party operator bundle), not a deployable path. */
const SKIP_DIRS = new Set(['node_modules', 'bakeoff', '.git']);

function walk(dir: string, accept: RegExp, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, accept, out);
    else if (accept.test(e.name)) out.push(p);
  }
  return out;
}

/** True when `ref` names a registry host as its first path segment. */
function isQualified(ref: string): boolean {
  const slash = ref.indexOf('/');
  if (slash < 0) return false; // `redis:7-alpine`, `busybox`
  const first = ref.slice(0, slash);
  return first.includes('.') || first.includes(':') || first === 'localhost';
}

/** Placeholders and shell/Go interpolation are not image names. */
function isConcrete(ref: string): boolean {
  return ref.length > 0 && !/[$`{}]|__/.test(ref);
}

function yamlImages(file: string): string[] {
  const out: string[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (k === 'image' && typeof x === 'string') out.push(x);
        else visit(x);
      }
    }
  };
  for (const d of parseAllDocuments(readFileSync(file, 'utf8'))) {
    if (d.errors.length > 0) {
      throw new Error(`${file}: unparseable manifest: ${d.errors[0].message}`);
    }
    visit(d.toJS());
  }
  return out;
}

/** `IMG_NEON`, `PSQL_IMG`, `K6_IMAGE`… but not `IMAGE_SRC`-style provenance labels. */
const isImageVar = (name: string): boolean =>
  /(IMG|IMAGE)/.test(name) && !/_(SRC|SOURCE)$/.test(name);

const strip = (s: string): string => s.replace(/^["']|["']$/g, '');

/** Images a shell script renders: heredoc `image:`, `--image=`, `*_IMG`/`*_IMAGE` assignments (incl. `${V:-default}`), `set image n=ref`. */
function shellImages(file: string): string[] {
  const out: string[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (/^\s*#/.test(line)) continue;
    for (const m of line.matchAll(/^\s*-?\s*image:\s*(\S+)/g)) out.push(strip(m[1]));
    for (const m of line.matchAll(/--image=(\S+)/g)) out.push(strip(m[1]));
    for (const m of line.matchAll(/\b([A-Z][A-Z0-9_]*)=\s*"?\$\{[A-Z0-9_]+:-([^}"]+)\}"?/g)) {
      if (isImageVar(m[1])) out.push(strip(m[2]));
    }
    for (const m of line.matchAll(/\b([A-Z][A-Z0-9_]*)=\s*("[^"]*"|[^\s"'$]\S*)/g)) {
      if (isImageVar(m[1])) out.push(strip(m[2]));
    }
    for (const m of line.matchAll(/\bset image\b.*$/g)) {
      for (const r of m[0].matchAll(/\b[\w-]+="?([^\s"=]+\/[^\s"=]+)"?/g)) out.push(strip(r[1]));
    }
  }
  return out;
}

/** Go string defaults for images: `Image: "…"` struct fields and `env("…IMAGE…", "…")`. */
function goImages(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of src.matchAll(/\b\w*Image\w*:\s*"([^"]+)"/g)) out.push(m[1]);
  for (const m of src.matchAll(/env\("[A-Z_]*IMAGE[A-Z_]*",\s*"([^"]+)"/g)) out.push(m[1]);
  return out;
}

interface Hit {
  file: string;
  ref: string;
}

function collect(): Hit[] {
  const hits: Hit[] = [];
  const add = (file: string, refs: string[]) => {
    for (const ref of refs) if (isConcrete(ref)) hits.push({ file: relative(ROOT, file), ref });
  };
  for (const f of walk(SZPG, /\.ya?ml$/)) add(f, yamlImages(f));
  for (const f of walk(SZPG, /\.sh$/)) add(f, shellImages(f));
  for (const f of walk(SZPG, /\.go$/)) {
    if (!f.endsWith('_test.go')) add(f, goImages(f));
  }
  add(DATA_PLANE, yamlImages(DATA_PLANE));
  return hits;
}

describe('container images are fully qualified (CRI-O has no default registry)', () => {
  it('the qualification rule matches the runtime rule (negative controls)', () => {
    for (const bad of [
      'redis:7-alpine',
      'busybox',
      'neondatabase/neon:8464',
      'prom/prometheus:v2',
    ]) {
      expect(isQualified(bad)).toBe(false);
    }
    for (const good of [
      'docker.io/library/redis:7-alpine',
      'ghcr.io/getknext-dev/x@sha256:abc',
      'localhost/app:dev',
      'localhost:5000/app:dev',
      'registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.13.0',
    ]) {
      expect(isQualified(good)).toBe(true);
    }
  });

  it('scans a non-trivial number of image references (guard is not vacuous)', () => {
    const hits = collect();
    expect(hits.length).toBeGreaterThan(60);
    // every source kind is actually being read
    for (const needle of ['.yaml', '.sh', '.go']) {
      expect(hits.some((h) => h.file.endsWith(needle))).toBe(true);
    }
    expect(hits.some((h) => h.file.endsWith('data-plane.yaml'))).toBe(true);
  });

  it('no image reference lacks a registry host', () => {
    const bad = collect()
      .filter((h) => !isQualified(h.ref))
      .map((h) => `${h.file}: ${h.ref}`);
    expect(bad).toEqual([]);
  });
});

describe('default-path manifests pin images by digest', () => {
  const DEFAULT_PATH = [
    // optional/ overlays are explicit opt-ins, not the default apply path
    ...walk(DEPLOY, /\.ya?ml$/).filter((f) => !f.startsWith(join(DEPLOY, 'optional'))),
    // the warm-standby prototype and the demo manifests ship alongside as copy-pasteable examples
    ...walk(join(SZPG, 'warmstandby'), /\.ya?ml$/),
    ...walk(join(SZPG, 'demo', 'manifests'), /\.ya?ml$/),
    DATA_PLANE,
  ];

  it('covers the default apply path and the e2e data plane', () => {
    expect(DEFAULT_PATH.length).toBeGreaterThan(30);
  });

  it('every image: in them carries an @sha256: digest', () => {
    const bad = DEFAULT_PATH.flatMap((f) =>
      yamlImages(f)
        .filter(isConcrete)
        .filter((ref) => !/@sha256:[0-9a-f]{64}$/.test(ref))
        .map((ref) => `${relative(ROOT, f)}: ${ref}`),
    );
    expect(bad).toEqual([]);
  });
});

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAllDocuments } from 'yaml';

/**
 * scale-zero-pg must never expose Postgres publicly by default.
 *
 * `kubectl apply -f packages/scale-zero-pg/deploy/` (non-recursive) is the
 * default apply path. Every Service in it must be cluster-internal: no
 * `type: LoadBalancer`, no `type: NodePort`, no `nodePort`, no
 * `externalIPs`. Public exposure is an explicit opt-in overlay under
 * `deploy/optional/`, which `kubectl apply -f deploy/` never reaches.
 *
 * This SCANS the directory rather than enumerating files, and an
 * unparseable manifest FAILS rather than being skipped, so a new file
 * (or a broken one) cannot slip past.
 */
const DEPLOY = join(import.meta.dir, '..', 'packages', 'scale-zero-pg', 'deploy');
const MANIFEST = /\.(ya?ml|json)$/;

interface Doc {
  kind?: string;
  items?: Doc[];
  metadata?: { name?: string };
  spec?: {
    type?: string;
    externalIPs?: unknown;
    loadBalancerSourceRanges?: string[];
    ports?: { nodePort?: number; port?: number }[];
  };
}

function manifests(): string[] {
  return readdirSync(DEPLOY, { withFileTypes: true })
    .filter((e) => e.isFile() && MANIFEST.test(e.name))
    .map((e) => e.name)
    .sort();
}

function parseDocs(text: string, label: string): Doc[] {
  const out: Doc[] = [];
  for (const d of parseAllDocuments(text)) {
    if (d.errors.length > 0) {
      throw new Error(`${label}: unparseable manifest: ${d.errors[0].message}`);
    }
    const v = d.toJS() as Doc | null;
    if (!v) continue;
    out.push(v);
    if (Array.isArray(v.items)) out.push(...v.items);
  }
  return out;
}

function docsOf(file: string): Doc[] {
  return parseDocs(readFileSync(join(DEPLOY, file), 'utf8'), file);
}

function serviceViolations(docs: Doc[], file: string): string[] {
  const bad: string[] = [];
  for (const doc of docs) {
    if (doc.kind !== 'Service') continue;
    const name = `${file}: Service/${doc.metadata?.name ?? '?'}`;
    const type = doc.spec?.type ?? 'ClusterIP';
    if (type !== 'ClusterIP') bad.push(`${name} is type ${type}`);
    if (doc.spec?.externalIPs) bad.push(`${name} sets externalIPs`);
    if (doc.spec?.ports?.some((p) => p.nodePort !== undefined)) {
      bad.push(`${name} sets a nodePort`);
    }
  }
  return bad;
}

describe('scale-zero-pg default apply path is not publicly exposed', () => {
  it('scans a non-trivial set of manifests (guard is not vacuous)', () => {
    expect(manifests().length).toBeGreaterThan(20);
  });

  it('has no LoadBalancer / NodePort / externalIPs Service in deploy/*', () => {
    const all = manifests().flatMap((f) => serviceViolations(docsOf(f), f));
    expect(all).toEqual([]);
  });

  it('every manifest parses (unparseable must fail, not pass)', () => {
    for (const f of manifests()) expect(() => docsOf(f)).not.toThrow();
  });

  it('the detector flags LoadBalancer, NodePort, externalIPs and bad YAML', () => {
    const lb = parseDocs('kind: Service\nmetadata: {name: a}\nspec: {type: LoadBalancer}\n', 'x');
    expect(serviceViolations(lb, 'x')).toHaveLength(1);
    const np = parseDocs('kind: Service\nmetadata: {name: b}\nspec: {type: NodePort}\n', 'x');
    expect(serviceViolations(np, 'x')).toHaveLength(1);
    const ext = parseDocs(
      'kind: Service\nmetadata: {name: c}\nspec: {externalIPs: [1.2.3.4]}\n',
      'x',
    );
    expect(serviceViolations(ext, 'x')).toHaveLength(1);
    const ok = parseDocs('kind: Service\nmetadata: {name: d}\nspec: {type: ClusterIP}\n', 'x');
    expect(serviceViolations(ok, 'x')).toEqual([]);
    expect(() => parseDocs('kind: [unclosed\n', 'x')).toThrow(/unparseable/);
  });

  it('no deploy script creates a public Service (any spelling of LoadBalancer|NodePort)', () => {
    // YAML `type: X`, flags `--type=X` / `--type X`, JSON `"type":"X"` (any spacing/quotes,
    // incl. backslash-escaped), and `kubectl expose` (creates a Service; flagged on its own
    // because the type may be assembled from a variable).
    const T = '(?:LoadBalancer|NodePort)';
    const patterns = [
      new RegExp(`\\btype\\s*:\\s*["']?${T}\\b`),
      new RegExp(`--type(?:=|\\s+)["']?${T}\\b`),
      new RegExp(`\\\\*["']\\s*type\\s*\\\\*["']\\s*:\\s*\\\\*["']?${T}\\b`),
      /\bkubectl\b[^\n]*\bexpose\b/,
    ];
    const offenders = readdirSync(DEPLOY)
      .filter((n) => n.endsWith('.sh'))
      .filter((n) => {
        const text = readFileSync(join(DEPLOY, n), 'utf8');
        return patterns.some((re) => re.test(text));
      });
    expect(offenders).toEqual([]);
  });
});

describe('the public front door is an explicit, restricted opt-in', () => {
  const OPT = join(DEPLOY, 'optional', '28-gateway-public-lb.yaml');

  it('ships outside the default apply path, as LoadBalancer with source ranges', () => {
    const svc = parseDocs(readFileSync(OPT, 'utf8'), OPT).find((d) => d.kind === 'Service');
    expect(svc?.metadata?.name).toBe('pggw-lb');
    expect(svc?.spec?.type).toBe('LoadBalancer');
    expect(svc?.spec?.loadBalancerSourceRanges?.length).toBeGreaterThan(0);
    // never open to the world by default
    expect(svc?.spec?.loadBalancerSourceRanges).not.toContain('0.0.0.0/0');
  });

  it('exposes only the Postgres wire ports, never metrics (9090)', () => {
    const svc = parseDocs(readFileSync(OPT, 'utf8'), OPT).find((d) => d.kind === 'Service');
    expect(svc?.spec?.ports?.map((p) => p.port).sort()).toEqual([55432, 55434]);
  });
});

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAllDocuments } from 'yaml';

/**
 * `storage-init` (55) reads the durable generation ledger from the
 * `pageserver-generation` ConfigMap, which ONLY `57-pageserver-standby.yaml`
 * creates. The volume is `optional: true` so the pod schedules even when the
 * ConfigMap lags the Job within a single `kubectl apply -f deploy/`, so a
 * partial install (no 57) leaves the pod running and polling for a file that
 * will never appear.
 *
 * The wait is bounded and fails closed, but a failure that does not say WHERE
 * the ledger comes from reads as "waiting forever". These guards pin three
 * things:
 *   1. the ConfigMap storage-init mounts is really created by a default-path
 *      manifest (so the dependency is real, and renaming either side reds);
 *   2. the bounded-wait failure message names that manifest and the seeding
 *      script, so a partial install is told exactly what is missing;
 *   3. the docs list the minimal file set, including that ConfigMap.
 */
const SZPG = join(import.meta.dir, '..', 'packages', 'scale-zero-pg');
const DEPLOY = join(SZPG, 'deploy');
const LEDGER_CM = 'pageserver-generation';

interface K8sDoc {
  kind?: string;
  items?: K8sDoc[];
  metadata?: { name?: string };
  spec?: {
    template?: { spec?: { volumes?: { name?: string; configMap?: { name?: string } }[] } };
  };
}

function docsOf(file: string): K8sDoc[] {
  const out: K8sDoc[] = [];
  for (const d of parseAllDocuments(readFileSync(join(DEPLOY, file), 'utf8'))) {
    if (d.errors.length > 0) throw new Error(`${file}: unparseable: ${d.errors[0].message}`);
    const v = d.toJS() as K8sDoc | null;
    if (v) out.push(v);
  }
  return out;
}

/** Which default-path manifests (deploy/*.yaml) define a ConfigMap of this name. */
function definersOf(cm: string): string[] {
  return readdirSync(DEPLOY)
    .filter((f) => /\.ya?ml$/.test(f))
    .filter((f) => docsOf(f).some((d) => d.kind === 'ConfigMap' && d.metadata?.name === cm));
}

const storageInitText = readFileSync(join(DEPLOY, '55-storage-init.yaml'), 'utf8');

describe('storage-init ledger dependency is explicit', () => {
  it('mounts the pageserver-generation ConfigMap', () => {
    const job = docsOf('55-storage-init.yaml').find((d) => d.kind === 'Job');
    const mounted = job?.spec?.template?.spec?.volumes?.map((v) => v.configMap?.name);
    expect(mounted).toContain(LEDGER_CM);
  });

  it('that ConfigMap is created by exactly one default-path manifest: 57', () => {
    expect(definersOf(LEDGER_CM)).toEqual(['57-pageserver-standby.yaml']);
  });

  it('the bounded-wait failure names the manifest that creates the ConfigMap', () => {
    const refusing = storageInitText
      .split('\n')
      .find((l) => l.includes('REFUSING to attach') && l.includes('not present'));
    expect(refusing).toBeDefined();
    expect(refusing).toContain('57-pageserver-standby.yaml');
    expect(refusing).toContain(LEDGER_CM);
    expect(refusing).toContain('seed-ledger.sh');
    expect(refusing).toContain('exit 1');
  });

  it('the wait is bounded (a finite default try count, 2s apart)', () => {
    const m = /LEDGER_WAIT_TRIES:-(\d+)/.exec(storageInitText);
    expect(m).not.toBeNull();
    const tries = Number(m?.[1]);
    expect(tries).toBeGreaterThan(0);
    expect(tries).toBeLessThanOrEqual(120);
  });
});

describe('docs state the minimal install file set', () => {
  const doc = readFileSync(join(SZPG, 'docs', 'getting-started.md'), 'utf8');
  // Only the dedicated section counts: a stray mention elsewhere in the page must not satisfy the guard.
  const start = doc.indexOf('### Installing a subset');
  const section = start < 0 ? '' : doc.slice(start).split(/\n#{1,3} /)[0];

  it('has a dedicated "Installing a subset" section', () => {
    expect(start).toBeGreaterThanOrEqual(0);
  });

  it('lists the ledger ConfigMap manifest as required even without a standby', () => {
    const row = section.split('\n').find((l) => l.includes('57-pageserver-standby.yaml'));
    expect(row).toBeDefined();
    expect(row).toContain(LEDGER_CM);
    expect(row).toContain('even if you run no standby');
    expect(section).toContain('seed-ledger.sh');
  });

  it('names the storage-plane files a partial install must keep', () => {
    for (const f of [
      '00-namespace.yaml',
      '51-storage-broker.yaml',
      '52-safekeeper.yaml',
      '53-pageserver.yaml',
      '55-storage-init.yaml',
      '20-compute.yaml',
    ]) {
      expect(section).toContain(f);
    }
  });
});

/**
 * The CLI writes only `NextApp` and `BackendService` (ADR-0001 as amended by
 * ADR-0052 D3; CLAUDE.md section 4).
 *
 * A SCAN, not a list: it reads every `kubectl` argv literal under
 * `packages/kn-next/src/cli/` and `packages/grpc/` and classifies the verb.
 * Read verbs pass. A write verb must name `nextapp` or `backendservice`; an
 * `apply`/`create`/`replace` carries its kind in a manifest, so those sites are
 * matched against a short justified table (file + verb -> the kinds it may
 * send), and every `kind:` the sources can emit must be on that table or be
 * `NextApp` / `BackendService`. Every `kubectl apply` must pass
 * `--validate=strict` explicitly. A kubectl argv whose verb cannot be read
 * FAILS rather than passes, and a table entry that matches no site is stale
 * and fails too.
 *
 * Honest about what is true today: the table carries two EXCEPTIONS to "only
 * NextApp/BackendService" that predate this guard, both pinned below so a third
 * cannot appear unnoticed - the load-test Job (`knext loadtest` applies a k6
 * ConfigMap and Job, test tooling that holds no app state) and the access
 * review `knext ci-preflight` creates to ask "may I?" (stores nothing).
 */

import { describe, expect, it } from 'bun:test';
import {
  ALLOWED_KINDS,
  KIND_EXCEPTIONS,
  MANIFEST_WRITES,
  scanClusterWriteSource,
  scanClusterWriteTree,
} from '../scripts/lib/cli-cluster-write-scan.mjs';

const FILE = 'packages/kn-next/src/cli/fixture.ts';
const scan = (src: string, allow = MANIFEST_WRITES, file = FILE) =>
  scanClusterWriteSource(src, { file, allow, kindExceptions: KIND_EXCEPTIONS });
const rules = (src: string, allow = MANIFEST_WRITES, file = FILE) =>
  scan(src, allow, file).violations.map((v) => v.rule);

describe('cluster-write scan: RED fixtures', () => {
  it.each([
    ['a patch of another resource', 'x(["kubectl", "patch", "deployment", n, "-p", p]);'],
    ['a delete of a service', 'x(["kubectl", "delete", "ksvc", n]);'],
    ['a label of a configmap', 'x(["kubectl", "label", "configmap", n, "a=b"]);'],
    ['a scale', 'x(["kubectl", "scale", "deploy", n, "--replicas=0"]);'],
    ['a rollout', 'x(["kubectl", "rollout", "restart", "deploy", n]);'],
  ])('reds %s as a foreign write kind', (_label, src) => {
    expect(rules(src)).toContain('foreign-write-kind');
  });

  it('reads an argv that a function returns (the preflight builds its argv that way)', () => {
    expect(rules('function f() {\n  return ["kubectl", "delete", "ksvc", n];\n}')).toContain(
      'foreign-write-kind',
    );
    // ...and an index access after `return` is still not an array literal
    expect(scan('function g() {\n  return names[0];\n}').kubectlArgvCount).toBe(0);
  });

  it('reds a manifest write from a file that is not on the table', () => {
    expect(rules('x(["kubectl", "apply", "--validate=strict", "-f", p]);')).toContain(
      'unlisted-manifest-write',
    );
  });

  it('reds a create/replace manifest write from an unlisted file too', () => {
    expect(rules('x(["kubectl", "create", "-f", p]);')).toContain('unlisted-manifest-write');
    expect(rules('x(["kubectl", "replace", "-f", p]);')).toContain('unlisted-manifest-write');
  });

  it('reds an apply that does not pass --validate=strict, even from a listed file', () => {
    const allow = [{ file: FILE, verb: 'apply', kinds: ['NextApp'], reason: 'fixture' }];
    expect(rules('x(["kubectl", "apply", "-f", p]);', allow)).toContain('apply-not-strict');
    expect(rules('x(["kubectl", "apply", "--validate=ignore", "-f", p]);', allow)).toContain(
      'apply-not-strict',
    );
  });

  it('reds a server-side dry-run apply that is not strict (the preflight must be)', () => {
    const allow = [{ file: FILE, verb: 'apply', kinds: ['NextApp'], reason: 'fixture' }];
    expect(rules('x(["kubectl", "apply", "--dry-run=server", "-f", p]);', allow)).toContain(
      'apply-not-strict',
    );
  });

  it.each([
    ['a computed verb', 'x(["kubectl", verb, "nextapp"]);'],
    ['a spread right after the program', 'x(["kubectl", ...rest]);'],
    ['a flag before the verb', 'x(["kubectl", "--context", "prod", "delete", "ksvc", n]);'],
    ['a write verb with no readable resource', 'x(["kubectl", "delete", resource, n]);'],
    ['a write verb whose first argument is a flag', 'x(["kubectl", "delete", "-f", p]);'],
  ])('fails (does not pass) on an unparseable construct: %s', (_label, src) => {
    expect(rules(src)).toContain('unparseable-kubectl');
  });

  it('reds a kind the CLI is not allowed to emit', () => {
    expect(rules('const m = { kind: "Deployment", metadata: {} };')).toContain('foreign-kind');
    expect(rules('const y = `apiVersion: v1\nkind: Secret\nmetadata:`;')).toContain('foreign-kind');
  });

  it('does not let a table entry excuse a kind its row does not name', () => {
    const allow = [{ file: FILE, verb: 'apply', kinds: ['NextApp'], reason: 'fixture' }];
    const exceptions = { [FILE]: ['NextApp'] };
    const r = scanClusterWriteSource('const m = { kind: "Job" };', {
      file: FILE,
      allow,
      kindExceptions: exceptions,
    });
    expect(r.violations.map((v) => v.rule)).toContain('foreign-kind');
  });

  it('reports a table entry that matches no site as stale', () => {
    const allow = [{ file: FILE, verb: 'apply', kinds: ['NextApp'], reason: 'fixture' }];
    expect(scan('x(["kubectl", "get", "ns"]);', allow).unusedAllow).toHaveLength(1);
  });

  it('names the file and line', () => {
    const [v] = scan('const a = 1;\nx(["kubectl", "delete", "ksvc", n]);\n').violations;
    expect(v?.file).toBe(FILE);
    expect(v?.line).toBe(2);
  });
});

describe('cluster-write scan: GREEN fixtures', () => {
  it.each([
    ['get', 'x(["kubectl", "get", "nextapp", name, "-o", "json"]);'],
    ['get --raw', 'x(["kubectl", "get", "--raw", "/version"]);'],
    ['describe', 'x(["kubectl", "describe", "pod", p]);'],
    ['version', 'x(["kubectl", "version", "--client", "-o", "json"]);'],
    ['logs', 'x(["kubectl", "logs", "-n", ns, p]);'],
    ['auth can-i', 'x(["kubectl", "auth", "can-i", "create", "nextapps"]);'],
  ])('passes a read: %s', (_label, src) => {
    expect(scan(src).violations).toEqual([]);
  });

  it.each([
    ['patch nextapp', 'x(["kubectl", "patch", "nextapp", n, "--type", "merge", "-p", p]);'],
    ['patch backendservice', 'x(["kubectl", "patch", "backendservice", n, "-p", p]);'],
    ['delete nextapp', 'x(["kubectl", "delete", "nextapp", n, "--ignore-not-found"]);'],
    ['delete a qualified nextapps', 'x(["kubectl", "delete", "nextapps.apps.kn-next.dev", n]);'],
    ['delete bsvc', 'x(["kubectl", "delete", "bsvc", n]);'],
    [
      'a patch wrapped by withKubeContext',
      'x(withKubeContext(["kubectl", "patch", "nextapp", n, "-p", p], c));',
    ],
  ])('passes a write of an allowed kind: %s', (_label, src) => {
    expect(scan(src).violations).toEqual([]);
  });

  it('passes a strict apply from a listed file, and records it', () => {
    const allow = [{ file: FILE, verb: 'apply', kinds: ['NextApp'], reason: 'fixture' }];
    const r = scan('x(["kubectl", "apply", "--validate=strict", "-f", p, "-n", ns]);', allow);
    expect(r.violations).toEqual([]);
    expect(r.writes).toEqual([{ verb: 'apply', resource: undefined, file: FILE, line: 1 }]);
    expect(r.unusedAllow).toEqual([]);
  });

  it('a strict server-side dry-run apply is not a write but is still held to strict', () => {
    const allow = [{ file: FILE, verb: 'apply', kinds: ['NextApp'], reason: 'fixture' }];
    const r = scan(
      'x(["kubectl", "apply", "--dry-run=server", "--validate=strict", "-f", p]);',
      allow,
    );
    expect(r.violations).toEqual([]);
  });

  it('passes the allowed kinds, in an object literal or in YAML text', () => {
    expect(scan('const m = { kind: "NextApp" };').violations).toEqual([]);
    expect(scan('const m = { kind: "BackendService" };').violations).toEqual([]);
    expect(scan('const y = `kind: BackendService\nspec:`;').violations).toEqual([]);
  });

  it('ignores a kind named in a comment, and lower-case discriminators', () => {
    expect(
      scan('// kind: Deployment is not ours\nconst a = { kind: "deploy" };').violations,
    ).toEqual([]);
    expect(
      scan(" * kind: Secret in a doc comment\nconst b = { kind: 'verb' };").violations,
    ).toEqual([]);
  });

  it('a per-file kind exception admits exactly the kinds it names', () => {
    const exceptions = { [FILE]: ['Job'] };
    const ok = scanClusterWriteSource('const m = { kind: "Job" };', {
      file: FILE,
      allow: [],
      kindExceptions: exceptions,
    });
    expect(ok.violations).toEqual([]);
  });
});

describe('cluster-write scan: the real tree', () => {
  const result = scanClusterWriteTree();

  it('finds no foreign write, no unlisted manifest write, no non-strict apply, no unreadable kubectl', () => {
    expect(result.violations).toEqual([]);
  });

  it('is not vacuous: it saw the known writes and both allowed kinds', () => {
    const seen = new Set(
      result.writes.map((w: { verb: string; resource?: string }) =>
        `${w.verb} ${w.resource ?? ''}`.trim(),
      ),
    );
    expect(seen.has('patch nextapp')).toBe(true);
    expect(seen.has('delete nextapp')).toBe(true);
    expect(seen.has('apply')).toBe(true);
    expect(result.kinds).toContain('NextApp');
    expect(result.kinds).toContain('BackendService');
    expect(result.kubectlArgvCount).toBeGreaterThan(25);
  });

  it('the CLI applies a BackendService from @getknext/grpc and nothing else is new', () => {
    const grpcWrites = result.writes.filter((w: { file: string }) =>
      w.file.startsWith('packages/grpc/'),
    );
    expect(grpcWrites.map((w: { verb: string }) => w.verb)).toEqual(['apply']);
    expect(
      MANIFEST_WRITES.find(
        (e: { file: string }) => e.file === 'packages/grpc/src/deploy-function.ts',
      )?.kinds,
    ).toEqual(['BackendService']);
  });

  it('every kind the sources can emit is allowed or a pinned exception', () => {
    const exceptional = new Set(Object.values(KIND_EXCEPTIONS).flat());
    for (const k of result.kinds) {
      expect(ALLOWED_KINDS.has(k) || exceptional.has(k), k).toBe(true);
    }
  });

  it('pins the exceptions, so a new one is a deliberate edit of this guard', () => {
    expect([...new Set(Object.values(KIND_EXCEPTIONS).flat())].sort()).toEqual([
      'ConfigMap',
      'Job',
      'Role',
      'RoleBinding',
      'SelfSubjectAccessReview',
      'SelfSubjectRulesReview',
      'ServiceAccount',
    ]);
    expect([...ALLOWED_KINDS].sort()).toEqual(['BackendService', 'NextApp']);
  });

  it('no table entry is stale, and each says why it is safe', () => {
    expect(result.unusedAllow).toEqual([]);
    for (const e of MANIFEST_WRITES) {
      expect(e.reason.length, `${e.file} ${e.verb}`).toBeGreaterThan(20);
    }
  });
});

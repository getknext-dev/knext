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
  checkManifestKinds,
  KIND_EXCEPTIONS,
  KIND_UNREADABLE_WAIVERS,
  kindsOfSource,
  MANIFEST_WRITES,
  scanClusterWriteSource,
  scanClusterWriteTree,
  writeScopeFiles,
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

  it.each([
    [
      'kubectl behind env in an argv array',
      "runInherit(['env', 'KUBECONFIG=/x', 'kubectl', 'label', 'secret', 'x', 'a=b']);",
    ],
    [
      'kubectl behind sudo in an argv array',
      "runInherit(['sudo', 'kubectl', 'label', 'secret', 'x', 'a=b']);",
    ],
    [
      'kubectl behind sudo with a flag that takes a value',
      "runInherit(['sudo', '-u', 'root', 'kubectl', 'delete', 'ksvc', 'x']);",
    ],
    [
      'kubectl behind two wrappers',
      "runInherit(['env', 'X=1', 'sudo', 'kubectl', 'delete', 'ksvc', 'x']);",
    ],
    [
      'kubectl behind env given to execFileSync',
      "execFileSync('env', ['kubectl', 'delete', 'ksvc', 'x']);",
    ],
    ['kubectl behind xargs', "runInherit(['xargs', '-n1', 'kubectl', 'delete', 'ksvc']);"],
  ])('reds %s as a foreign write kind', (_label, src) => {
    expect(rules(src)).toContain('foreign-write-kind');
  });

  it.each([
    ['an assignment to a member', "m.kind = 'Secret';"],
    ['an optional-chained assignment', "m?.kind = 'Secret';"],
    ['a constant used as the value', "const K = 'Secret';\nconst m = ({ kind: K });"],
    ['a let-bound constant used as the value', "let K = 'Secret';\nconst m = ({ kind: K });"],
    ['a computed single-quote key', "const m = { ['kind']: 'Secret' };"],
    ['a computed double-quote key', 'const m = { ["kind"]: "Secret" };'],
    ['a computed template key and value', 'const m = { [`kind`]: `Secret` };'],
  ])('reds a foreign kind written as %s', (_label, src) => {
    expect(rules(src)).toContain('foreign-kind');
  });

  it.each([
    ['an identifier that is not a known constant', 'const m = { kind: someKind, spec: {} };'],
    ['a member expression value', 'const m = { kind: opts.kind };'],
    ['a function call value', 'const m = { kind: pick() };'],
    ['an assignment of an unknown identifier', 'm.kind = other;'],
    [
      'a reassigned let used as the value',
      "let K = 'NextApp';\nK = pick();\nconst m = { kind: K };",
    ],
  ])('fails (does not pass) on an unreadable kind: %s', (_label, src) => {
    expect(rules(src)).toContain('unparseable-kind');
  });

  it.each([
    ['a type annotation', 'interface M { readonly kind: MethodKind; }\ntype T = { kind: Foo };'],
    ['a comparison', "if (x.kind === 'Secret') {}\nif (x.kind !== 'Job') {}"],
    ['a lower-case discriminator', "const m = { kind: 'verb' }; m.kind = 'deploy';"],
    [
      'a known allowed constant',
      "const NEXTAPP_KIND = 'NextApp';\nconst m = { kind: NEXTAPP_KIND };",
    ],
    ['a destructured kind', 'const { kind } = node;'],
  ])('passes %s', (_label, src) => {
    expect(scan(src).violations).toEqual([]);
  });

  it('an unreadable-kind waiver admits exactly its count, and a changed count reds', () => {
    const glue = 'packages/grpc/src/glue-plugin.ts';
    expect(KIND_UNREADABLE_WAIVERS[glue].count).toBe(1);
    const one = 'const a = { kind: `${k}` };';
    const run = (src: string) =>
      scanClusterWriteSource(src, { file: glue, allow: [], kindExceptions: {} }).violations.map(
        (v: { rule: string }) => v.rule,
      );
    expect(run(one)).toEqual([]);
    expect(run(`${one}\n${one}`)).toContain('unparseable-kind'); // one more than waived
    expect(run('const a = 1;')).toContain('unparseable-kind'); // fewer than waived: stale
    // a file with no waiver gets none
    expect(rules(one)).toContain('unparseable-kind');
  });

  it('the kinds a source file can emit include those forms, so kindSources see them', () => {
    expect(kindsOfSource("m.kind = 'Secret';").map((k: { kind?: string }) => k.kind)).toEqual([
      'Secret',
    ]);
    expect(
      kindsOfSource("const K = 'Secret';\nconst m = ({ kind: K });").map(
        (k: { kind?: string }) => k.kind,
      ),
    ).toEqual(['Secret']);
    expect(
      kindsOfSource("const m = { ['kind']: 'Secret' };").map((k: { kind?: string }) => k.kind),
    ).toEqual(['Secret']);
    // ...and an entry whose source can emit one of them but does not declare it reds
    const entry = {
      file: 'a.ts',
      verb: 'apply',
      kinds: ['NextApp'],
      kindSources: ['b.ts'],
      reason: 'fixture entry',
    };
    const sources: Record<string, string> = {
      'b.ts': "const a = { kind: 'NextApp' };\nm.kind = 'Secret';",
    };
    const kindsOf = (f: string) =>
      kindsOfSource(sources[f] ?? '')
        .map((k: { kind?: string }) => k.kind)
        .filter((k: string | undefined): k is string => k !== undefined);
    expect(checkManifestKinds([entry], kindsOf).map((v) => v.rule)).toContain('undeclared-kind');
  });

  it.each([
    ['a quoted double-quote key', 'const m = { "kind": "Secret" };'],
    ['a quoted single-quote key', "const m = { 'kind': 'Secret' };"],
    ['a template literal value', 'const m = { kind: `Secret` };'],
    ['a YAML kind in a template literal', 'const y = `apiVersion: v1\nkind: Secret\n`;'],
  ])('reds a foreign kind written as %s', (_label, src) => {
    expect(rules(src)).toContain('foreign-kind');
  });

  it('fails (does not pass) on a kind built from a template with a hole', () => {
    expect(rules('const m = { kind: `${k}` };')).toContain('unparseable-kind');
  });

  it.each([
    ['kubectl by absolute path', 'x(["/usr/local/bin/kubectl", "delete", "ksvc", n]);'],
    ['kubectl kept in a constant', "const K = '/usr/bin/kubectl';\nx([K, 'delete', 'ksvc', n]);"],
    [
      'kubectl spawned by absolute path',
      "execFileSync('/usr/bin/kubectl', ['delete', 'ksvc', n]);",
    ],
    ['kubectl.exe', 'x(["kubectl.exe", "delete", "ksvc", n]);'],
    ['kubectl in a sh -c string', "x(['sh', '-c', 'kubectl label secret foo a=b']);"],
    ['kubectl in an exec string', "execSync('kubectl delete ksvc x');"],
    [
      'kubectl in a shell started with execFileSync',
      "execFileSync('sh', ['-c', 'kubectl label secret foo a=b']);",
    ],
    ['kubectl in a chained shell string', "execSync('kubectl get ns && kubectl delete ksvc x');"],
    [
      'a label whose selector value names the allowed kind',
      'x(["kubectl", "label", "-l", "nextapp", "secrets", "a=b"]);',
    ],
    [
      'a resource list that includes another kind',
      'x(["kubectl", "delete", "nextapp,secret", n]);',
    ],
    ['the slash form of another kind', 'x(["kubectl", "delete", "secret/foo"]);'],
  ])('reds %s as a foreign write kind', (_label, src) => {
    expect(rules(src)).toContain('foreign-write-kind');
  });

  it.each([
    ['a shell string with a computed verb', "execSync('kubectl $VERB nextapp x');"],
    ['kubectl behind env in a shell string', "execSync('env X=1 kubectl delete ksvc x');"],
    [
      'a template shell string with a hole that mentions kubectl',
      'execSync(`kubectl ${verb} nextapp x`);',
    ],
    ['an unknown flag before the resource', 'x(["kubectl", "delete", "--weird", "nextapp", n]);'],
    ['a computed program next to a write verb in sh -c', "x(['bash', '-c', cmd]);"],
  ])('fails (does not pass) on an unparseable construct: %s', (_label, src) => {
    expect(rules(src)).toContain('unparseable-kubectl');
  });

  it('counts manifest writes: a second apply in a file whose entry allows one reds', () => {
    const allow = [{ file: FILE, verb: 'apply', kinds: ['NextApp'], reason: 'fixture' }];
    const two =
      'x(["kubectl", "apply", "--validate=strict", "-f", a]);\n' +
      'x(["kubectl", "apply", "--validate=strict", "-f", b]);';
    expect(rules(two, allow)).toContain('unlisted-manifest-write');
  });

  it('counts manifest writes: an entry with count 2 admits two and reds a third', () => {
    const allow = [{ file: FILE, verb: 'apply', count: 2, kinds: ['NextApp'], reason: 'fixture' }];
    const one = 'x(["kubectl", "apply", "--validate=strict", "-f", a]);';
    expect(rules(`${one}\n${one}`, allow)).toEqual([]);
    expect(rules(`${one}\n${one}\n${one}`, allow)).toContain('unlisted-manifest-write');
  });

  it('counts manifest writes: an entry whose sites dropped below its count is stale', () => {
    const allow = [{ file: FILE, verb: 'apply', count: 2, kinds: ['NextApp'], reason: 'fixture' }];
    const one = 'x(["kubectl", "apply", "--validate=strict", "-f", a]);';
    expect(scan(one, allow).unusedAllow).toHaveLength(1);
  });

  it('compares the declared kinds with what the source files can emit', () => {
    const entry = {
      file: 'a.ts',
      verb: 'apply',
      kinds: ['NextApp'],
      kindSources: ['b.ts'],
      reason: 'fixture entry',
    };
    const kindsOf = (m: Record<string, string[]>) => (f: string) => m[f] ?? [];
    expect(checkManifestKinds([entry], kindsOf({ 'b.ts': ['NextApp'] }))).toEqual([]);
    // an undeclared kind is applied
    expect(
      checkManifestKinds([entry], kindsOf({ 'b.ts': ['NextApp', 'Secret'] })).map((v) => v.rule),
    ).toContain('undeclared-kind');
    // a declared kind the sources never emit
    expect(checkManifestKinds([entry], kindsOf({ 'b.ts': [] })).map((v) => v.rule)).toContain(
      'declared-kind-not-emitted',
    );
    // an entry that names no source cannot be compared: it fails
    expect(
      checkManifestKinds([{ ...entry, kindSources: [] }], kindsOf({})).map((v) => v.rule),
    ).toContain('undeclared-kind-source');
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

  it.each([
    [
      'a namespace flag before the resource',
      'x(["kubectl", "delete", "-n", "prod", "nextapp", n]);',
    ],
    ['the slash form of an allowed kind', 'x(["kubectl", "delete", "nextapp/foo"]);'],
    ['a label of an allowed kind', 'x(["kubectl", "label", "-n", ns, "nextapp", n, "a=b"]);'],
    ['an absolute-path kubectl read', 'x(["/usr/local/bin/kubectl", "get", "ns"]);'],
    ['kubectl get in a sh -c string', "x(['sh', '-c', 'kubectl get ns']);"],
    ['a shell string with no kubectl', "execSync('echo hello && ls');"],
  ])('passes %s', (_label, src) => {
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

  it('@getknext/grpc makes no cluster write itself: core applies the BackendService it builds', () => {
    const grpcWrites = result.writes.filter((w: { file: string }) =>
      w.file.startsWith('packages/grpc/'),
    );
    expect(grpcWrites).toEqual([]);
    const entry = MANIFEST_WRITES.find(
      (e: { file: string }) => e.file === 'packages/kn-next/src/cli/grpc-dispatch.ts',
    );
    expect(entry?.kinds).toEqual(['BackendService']);
    expect(entry?.kindSources).toEqual(['packages/grpc/src/backend-service.ts']);
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

  it('covers @getknext/grpc, core, the generators and every kind source the table names', () => {
    const files = writeScopeFiles();
    expect(files).toContain('packages/grpc/src/deploy-function.ts');
    expect(files).toContain('packages/grpc/src/backend-service.ts');
    expect(files).toContain('packages/kn-next/src/cli/grpc-dispatch.ts');
    expect(files).toContain('packages/kn-next/src/generators/loadtest-job.ts');
    for (const e of MANIFEST_WRITES) {
      for (const src of e.kindSources ?? []) expect(files, src).toContain(src);
    }
  });

  it('the tree scan cross-checks declared kinds against the source files', () => {
    // Declare a kind deploy.ts's manifest never carries: the scan must say so.
    const wrong = MANIFEST_WRITES.map((e) =>
      e.file === 'packages/kn-next/src/cli/deploy.ts' ? { ...e, kinds: ['NextApp', 'Job'] } : e,
    );
    const rules = scanClusterWriteTree(undefined, wrong).violations.map(
      (v: { rule: string }) => v.rule,
    );
    expect(rules).toContain('declared-kind-not-emitted');
  });

  it('no table entry is stale, and each says why it is safe', () => {
    expect(result.unusedAllow).toEqual([]);
    // sites are COUNTED: the table must account for every write the scan saw
    const seen = new Map<string, number>();
    for (const w of result.writes as { file: string; verb: string; resource?: string }[]) {
      if (w.resource !== undefined) continue;
      seen.set(`${w.file} ${w.verb}`, (seen.get(`${w.file} ${w.verb}`) ?? 0) + 1);
    }
    for (const e of MANIFEST_WRITES) {
      expect(seen.get(`${e.file} ${e.verb}`), `${e.file} ${e.verb}`).toBe(e.count ?? 1);
    }
    for (const e of MANIFEST_WRITES) {
      expect(e.reason.length, `${e.file} ${e.verb}`).toBeGreaterThan(20);
    }
  });
});

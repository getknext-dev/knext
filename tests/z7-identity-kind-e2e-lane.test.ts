import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { ROWS } from '../packages/grpc/e2e/z7-identity-kind/mutation-rows.mjs';

/**
 * GUARD TESTS for the Z7 identity-token kind e2e lane
 * (.github/workflows/z7-identity-kind-e2e.yml, packages/grpc/e2e/z7-identity-kind).
 *
 * The lane exists because the operator half of Z7 is proved on envtest only,
 * which has no kubelet, no Knative and no pods. A lane that is path-filtered and
 * not a required check protects nothing if its filter misses the code it
 * exercises, if its safety properties rot, or if a phase quietly stops running.
 * So, in four halves:
 *
 * 1. **The path filter covers what the lane consumes — scanned, not enumerated.**
 *    Every Z7 operator file (zone_signing_key*.go, backendservice*.go) found on
 *    disk, both function templates, the signer and the glue, and every repo path
 *    the workflow or the lane's scripts name must be matched by BOTH `paths:`
 *    lists, and the two lists must be the same list. A new Z7 file that no
 *    pattern covers reds here instead of landing with the lane never run.
 * 2. **The workflow is as safe as the rest of CI.** Read-only token, every action
 *    pinned to a full commit SHA with a version comment, no `continue-on-error`,
 *    no secrets, a bounded timeout, and it runs every phase (no PHASES override).
 * 3. **The harness never touches what it did not create.** No `kind delete`, no
 *    prune, no `set -x` (it handles private keys), no `patch --type=merge` of a
 *    Knative Service, and a namespace delete only behind the ownership label.
 * 4. **The lane proves what it claims.** The phases the issue's goals map to are
 *    all in the default list, in order; the Rust function is on in CI; the
 *    rotation asserts the order the operator promises (publish, wait the bound,
 *    switch, overlap, retire) and the leak scan fails closed on a vacuous run.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW = resolve(REPO_ROOT, '.github/workflows/z7-identity-kind-e2e.yml');
const LANE_DIR = resolve(REPO_ROOT, 'packages/grpc/e2e/z7-identity-kind');
const RUN_SH = resolve(LANE_DIR, 'run.sh');

interface Step {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
  env?: Record<string, unknown>;
  'continue-on-error'?: unknown;
}
interface Job {
  steps: Step[];
  'timeout-minutes'?: number;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  'continue-on-error'?: unknown;
}
interface Workflow {
  on: {
    pull_request: { paths: string[]; branches?: string[] };
    push: { paths: string[]; branches: string[] };
    workflow_dispatch?: unknown;
  };
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

const wfText = readFileSync(WORKFLOW, 'utf8');
const wf = parse(wfText) as Workflow;
const runSh = readFileSync(RUN_SH, 'utf8');
const steps = Object.values(wf.jobs).flatMap((j) => j.steps);

/** GitHub's path-filter glob: `**` crosses `/`, `*` does not. */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (c === '*') {
      re += '[^/]*';
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/** GitHub semantics: the LAST pattern that matches decides (a `!` pattern excludes). */
function filtered(paths: string[], file: string): boolean {
  let hit = false;
  for (const p of paths) {
    const negated = p.startsWith('!');
    if (globToRegExp(negated ? p.slice(1) : p).test(file)) hit = !negated;
  }
  return hit;
}

function filesIn(rel: string, pattern: RegExp): string[] {
  return readdirSync(resolve(REPO_ROOT, rel))
    .filter((f) => pattern.test(f))
    .map((f) => `${rel}/${f}`)
    .sort();
}

describe('the path filter covers what the lane consumes', () => {
  const pr = wf.on.pull_request.paths;
  const push = wf.on.push.paths;

  it('pull_request and push filter the same list', () => {
    expect(push).toEqual(pr);
  });

  it('runs on pull requests, on pushes to main and every integration line, and on demand', () => {
    expect(wf.on.push.branches).toContain('main');
    expect(wf.on.push.branches).toContain('integration/**');
    expect(wf.on.workflow_dispatch).toBeDefined();
    // A base-branch filter would skip stacked PRs and the integration lines.
    expect(wf.on.pull_request.branches).toBeUndefined();
  });

  it('matches every Z7 operator source file on disk (scanned: zone key, binding, controller)', () => {
    const dir = 'packages/kn-next-operator/internal/controller';
    const zoneKey = filesIn(dir, /^zone_signing_key.*\.go$/).filter((f) => !f.endsWith('_test.go'));
    const binding = filesIn(dir, /^backendservice.*\.go$/).filter((f) => !f.endsWith('_test.go'));
    expect(zoneKey.length).toBeGreaterThan(0);
    expect(binding.length).toBeGreaterThan(0);
    for (const f of [...zoneKey, ...binding]) {
      expect(filtered(pr, f), `${f} is not matched by the path filter`).toBe(true);
    }
  });

  it('matches the operator files the lane builds and the CRD and RBAC it installs', () => {
    for (const f of [
      'packages/kn-next-operator/internal/controller/nextapp_controller.go',
      'packages/kn-next-operator/internal/controller/setup.go',
      'packages/kn-next-operator/api/v1alpha1/backendservice_types.go',
      'packages/kn-next-operator/api/v1alpha1/nextapp_types.go',
      'packages/kn-next-operator/cmd/main.go',
      'packages/kn-next-operator/config/rbac/role.yaml',
      'packages/kn-next-operator/config/manager/manager.yaml',
      'packages/kn-next-operator/Dockerfile',
    ]) {
      expect(existsSync(resolve(REPO_ROOT, f)), `${f} no longer exists; update this list`).toBe(
        true,
      );
      expect(filtered(pr, f), `${f} is not matched by the path filter`).toBe(true);
    }
  });

  it('matches both function templates, the signer and the glue the zone is built from', () => {
    for (const f of [
      'templates/go/Dockerfile',
      'templates/go/internal/auth/verifier.go',
      'templates/go/proto/example/v1/example.proto',
      'templates/rust/Dockerfile',
      'templates/rust/src/auth.rs',
      'packages/grpc/src/signer.ts',
      'packages/grpc/src/glue.ts',
      'packages/grpc/src/runtime.ts',
      'packages/grpc/src/generate.ts',
      'packages/grpc/proto/knext/v1/options.proto',
    ]) {
      expect(existsSync(resolve(REPO_ROOT, f)), `${f} no longer exists; update this list`).toBe(
        true,
      );
      expect(filtered(pr, f), `${f} is not matched by the path filter`).toBe(true);
    }
  });

  it('matches the lane itself, its workflow, this guard and the install scripts it runs', () => {
    for (const f of [
      '.github/workflows/z7-identity-kind-e2e.yml',
      'packages/grpc/e2e/z7-identity-kind/run.sh',
      'packages/grpc/e2e/z7-identity-kind/probe.ts',
      'packages/grpc/e2e/z7-identity-kind/probe-lib.ts',
      'packages/grpc/e2e/z7-identity-kind/zone-caller/server.ts',
      'packages/grpc/e2e/z7-identity-kind/zone-caller/Dockerfile',
      'tests/z7-identity-kind-e2e-lane.test.ts',
      'scripts/kind-manifests/apply-knative-kourier.sh',
      '.github/actions/docker-hub-mirror/action.yml',
      'bun.lock',
    ]) {
      expect(existsSync(resolve(REPO_ROOT, f)), `${f} does not exist`).toBe(true);
      expect(filtered(pr, f), `${f} is not matched by the path filter`).toBe(true);
    }
  });

  it('matches every repo path the workflow and the lane scripts name (scanned half)', () => {
    const named =
      /(?:^|[\s"'(=:])((?:apps|packages|scripts|templates|crates|\.github)\/[A-Za-z0-9._\-/]*[A-Za-z0-9_-])/g;
    // The scripts root their paths at variables; expand them to repo-relative paths.
    const roots: Record<string, string> = {
      REPO: '',
      PKG: 'packages/grpc/',
      OPERATOR: 'packages/kn-next-operator/',
      HERE: 'packages/grpc/e2e/z7-identity-kind/',
    };
    const text = [
      ...steps.map((s) =>
        Object.values(s)
          .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
          .join('\n'),
      ),
      ...readdirSync(LANE_DIR).map((f) => {
        const p = resolve(LANE_DIR, f);
        if (!/\.(sh|ts)$/.test(f)) return '';
        // Code, not prose: a path in a comment is documentation, not a consumed input.
        return (
          readFileSync(p, 'utf8')
            .split('\n')
            // Also dropped: the lines that derive the roots with `/..`, which name no input.
            .filter((line) => !/^\s*(#|\/\/|\*|\/\*)/.test(line) && !line.includes('/..'))
            .join('\n')
        );
      }),
    ]
      .join('\n')
      .replace(/\$\{(REPO|PKG|OPERATOR|HERE)\}\//g, (_m, v: string) => ` ${roots[v]}`);
    const paths = [...new Set([...text.matchAll(named)].map((m) => m[1] as string))].filter((p) =>
      existsSync(resolve(REPO_ROOT, p)),
    );
    expect(paths.length).toBeGreaterThan(8);
    for (const p of paths) {
      // A directory is covered when something under it is; a file, when it is.
      const covered = filtered(pr, p) || filtered(pr, `${p}/x`) || filtered(pr, `${p}/x/y`);
      expect(covered, `${p} is named by the lane but no path pattern covers it`).toBe(true);
    }
  });
});

describe('the workflow is as safe as the rest of CI', () => {
  it('holds a read-only token and no secret', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
    for (const job of Object.values(wf.jobs)) {
      if (job.permissions) expect(job.permissions).toEqual({ contents: 'read' });
    }
    expect(wfText).not.toMatch(/\bsecrets\./);
    expect(wfText).not.toMatch(/id-token|pull_request_target/);
  });

  it('pins every action to a full commit SHA with a version comment', () => {
    const uses = wfText.split('\n').filter((l) => /^\s*-?\s*uses:/.test(l));
    expect(uses.length).toBeGreaterThan(3);
    for (const line of uses) {
      if (line.includes('uses: ./')) continue; // a local composite action
      expect(line, line).toMatch(/uses:\s+[\w./-]+@[0-9a-f]{40}\s+# v\d+(\.\d+)*/);
    }
  });

  it('has no continue-on-error anywhere: a red step is the lane failing', () => {
    const found: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (Array.isArray(node)) {
        for (const [i, n] of node.entries()) walk(n, `${path}[${i}]`);
      } else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (k === 'continue-on-error') found.push(`${path}.${k}`);
          walk(v, `${path}.${k}`);
        }
      }
    };
    walk(wf, 'workflow');
    expect(found).toEqual([]);
  });

  it('bounds the job and runs the lane with every phase and the Rust function', () => {
    for (const job of Object.values(wf.jobs)) {
      expect(typeof job['timeout-minutes']).toBe('number');
      expect(job['timeout-minutes'] as number).toBeLessThanOrEqual(75);
    }
    expect(wfText).not.toMatch(/\bPHASES\b/);
    const env = Object.values(wf.jobs).flatMap((j) => Object.entries(j.env ?? {}));
    expect(Object.fromEntries(env).Z7_WITH_RUST).toBe('1');
    const run = steps.map((s) => s.run ?? '').join('\n');
    expect(run).toContain('packages/grpc/e2e/z7-identity-kind/run.sh');
  });

  it('routes Docker Hub pulls through the mirror before the first pull', () => {
    const idx = steps.findIndex((s) => s.uses === './.github/actions/docker-hub-mirror');
    expect(idx).toBeGreaterThanOrEqual(0);
    const firstRun = steps.findIndex((s) => (s.run ?? '').includes('run.sh'));
    expect(idx).toBeLessThan(firstRun);
  });

  it('deletes the cluster it created, even on failure, and nothing else', () => {
    const teardown = steps.filter((s) => (s.run ?? '').includes('kind delete cluster'));
    expect(teardown).toHaveLength(1);
    expect((teardown[0] as Step).if).toMatch(/always\(\)/);
    expect((teardown[0] as Step).run).toContain('--name "${KIND_CLUSTER}"');
    expect(wfText).toContain('KIND_CLUSTER: z7-identity-e2e');
  });
});

describe('the harness never touches what it did not create', () => {
  it('fails on any error, never traces, and keeps its files private', () => {
    expect(runSh).toMatch(/^set -euo pipefail$/m);
    expect(runSh).toMatch(/^set \+x$/m);
    expect(runSh).toMatch(/^umask 077$/m);
    expect(runSh).not.toMatch(/\bset -[a-z]*x/);
    expect(runSh).not.toMatch(/bash -[a-z]*x/);
  });

  it('never deletes a cluster, prunes docker, or merge-patches a Knative Service', () => {
    expect(runSh).not.toMatch(/kind delete/);
    expect(runSh).not.toMatch(/docker (system|image|volume|builder|container) prune/);
    expect(runSh).not.toMatch(/patch\s+(ksvc|service\.serving|services\.serving)/);
    expect(runSh).not.toMatch(/--type[= ]merge[^\n]*ksvc|ksvc[^\n]*--type[= ]merge/);
  });

  it('talks to its own cluster only: a private kubeconfig, and the context is checked', () => {
    expect(runSh).toContain('export KUBECONFIG="${WORK}/kubeconfig"');
    expect(runSh).toMatch(/kubeconfig context is .* want kind-/);
    expect(runSh).not.toMatch(/kubectl config use-context/);
  });

  it('deletes a namespace only behind the ownership label this harness stamps', () => {
    const del = runSh.indexOf('delete namespace');
    expect(del).toBeGreaterThan(0);
    const guard = runSh.lastIndexOf('e2e.kn-next.dev/z7-owned', del);
    expect(guard, 'the ownership check must precede the delete').toBeGreaterThan(0);
    expect(runSh.slice(guard, del)).toMatch(/refusing to delete/);
    expect(runSh).toMatch(/label namespace "\$\{NS\}" e2e\.kn-next\.dev\/z7-owned=true/);
    // The only namespace the script ever deletes is the harness's own.
    const deletes = [...runSh.matchAll(/\bdelete namespace\s+("?)([^\s"]+)\1/g)].map((m) => m[2]);
    expect(deletes).toEqual(['${NS}']);
  });

  it('never prints a key: no echo of key material, and every Secret read is piped, captured or silenced', () => {
    expect(runSh).not.toMatch(/(echo|printf)[^\n]*(current|next|previous)\.key/);
    expect(runSh).not.toMatch(
      /(describe secret|get secrets? [^\n]*-o (yaml|jsonpath|go-template))/,
    );
    const code = runSh
      .replace(/\\\n\s*/g, ' ') // join continued lines
      .split('\n')
      .filter((l) => !/^\s*#/.test(l));
    const reads = code.filter((l) => /\bget secret\b/.test(l));
    expect(reads.length).toBeGreaterThan(2);
    for (const line of reads) {
      const piped = /-o json\s*\|/.test(line) || /json="\$\(.*-o json\)"/.test(line);
      const silenced = />\/dev\/null/.test(line);
      expect(piped || silenced, `a Secret is read with its output unguarded: ${line.trim()}`).toBe(
        true,
      );
    }
  });
});

describe('the lane proves what it claims', () => {
  it('runs the phases the issue maps to, in order, by default', () => {
    expect(runSh).toMatch(/^PHASES="\$\{PHASES:-up images deploy verify rotate leaks\}"$/m);
    const main = runSh.slice(
      runSh.lastIndexOf('# ---------------------------------------------------------------- main'),
    );
    expect(main).toContain('for phase in up images deploy verify rotate leaks');
  });

  it('binds a Go and a Rust function, and warm pods (min and max scale 1)', () => {
    expect(runSh).toContain('language: go');
    expect(runSh).toContain('language: rust');
    expect(runSh).toMatch(/minScale: 1\s+maxScale: 1/);
  });

  it('refuses each way a token can be wrong, next to a control', () => {
    for (const refusal of [
      'no token is refused',
      'a token that is not a JWT is refused',
      'a token signed by another key is refused',
      "a token claiming the zone's real kid, signed by another key, is refused",
      'a token minted for another function is refused',
      'a token minted for another RPC is refused',
      'an expired token is refused',
      "a token from another zone's issuer is refused",
      'none of the refused writes took effect',
    ]) {
      expect(runSh, refusal).toContain(refusal);
    }
    expect(runSh).toContain("control, a token from the zone's real key is accepted");
  });

  it('asserts the pod specs: no private key in a function, a directory volume, no subPath', () => {
    expect(runSh).toContain('"knext-zone-jwks"');
    expect(runSh).toContain('"knext-zone-signing-key"');
    expect(runSh).toContain('subPath');
    expect(runSh).toContain('signing-key');
    expect(runSh).toContain('PRIVATE KEY');
  });

  it('asserts the rotation in the order the operator promises', () => {
    const at = (needle: string) => {
      const i = runSh.indexOf(needle);
      expect(i, `${needle} is missing`).toBeGreaterThan(0);
      return i;
    };
    const order = [
      'rotate 1/5: request a rotation',
      'rotate 2/5: a WARM function accepts the staged key',
      'rotate 3/5: signing switches only after the propagation bound',
      'rotate 4/5: the zone',
      'rotate 5/5: retirement after the overlap',
    ].map(at);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The bound is checked against the operator's own timestamps, not only the wall clock.
    expect(runSh).toContain('signing-key-next-published-at');
    expect(runSh).toContain('signing-key-current-since');
    expect(runSh).toContain('the operator switched');
    // A warm function must accept the staged key BEFORE the switch.
    expect(runSh).toContain('propagation exceeded the ${BOUND} bound');
    // Nothing restarted, and the zone never failed a call.
    expect(runSh).toContain('was restarted or replaced during the rotation');
    expect(runSh).toContain('calls through the zone failed during the rotation');
    expect(runSh).toContain('too few to say nothing failed');
  });

  it('retires through the operator: a backdated stamp and an operator restart, stated as such', () => {
    expect(runSh).toContain('signing-key-switched-at=');
    expect(runSh).toContain('rollout restart deployment/kn-next-operator-controller-manager');
    expect(runSh).toMatch(/one-hour constant/);
  });

  it('fails the leak scan closed when it has nothing to scan for', () => {
    expect(runSh).toContain('the scan would prove nothing');
    expect(runSh).toContain('no operator log to scan');
    // An empty line as a grep pattern matches every line of every file: only a
    // real base64 body line may count, or the scan reds on nothing.
    expect(runSh).toMatch(/\[ "\$\{#line\}" -ge 40 \] \|\| continue/);
  });

  it('passes a kid as --kid=<value>: a base64url kid can start with "-" and parseArgs reads that as a flag', () => {
    // Seen on a control run: 1 kid in 64 starts with "-", and `--kid -q5z...` made
    // the probe exit before it sent anything.
    const uses = runSh.split('\n').filter((l) => /--kid\b/.test(l) && !/^\s*#/.test(l));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) expect(line, line).toMatch(/"--kid=\$\(/);
  });

  it('re-establishes a dropped gateway port-forward instead of failing an assertion on it', () => {
    // A long lane cannot depend on one `kubectl port-forward` surviving. The
    // retry covers only "no response" (probe exit 2, curl 000), never an answer.
    expect(runSh).toMatch(/ensure_forward\(\) \{/);
    expect(runSh).toMatch(/\[ "\$\{rc\}" = 2 \] \|\| return "\$\{rc\}"/);
    expect(runSh).toMatch(/\[ "\$\{out##\*\$'\\n'\}" = 000 \] \|\| break/);
    // Every forward it starts is recorded, and the cleanup stops them all.
    expect(runSh).toContain('echo "$!" >>"${PF_PIDS}"');
    expect(runSh).toMatch(/while read -r pid; do kill "\$\{pid\}"[^\n]*done <"\$\{PF_PIDS\}"/);
  });

  it('starts the port-forward as kubectl itself, so the pid it records is the one holding the port', () => {
    // `$!` of a backgrounded shell function is the function's subshell: killing
    // it leaves kubectl running, and an orphaned port-forward keeps a local port.
    const started = runSh.split('\n').filter((l) => /\bport-forward\b/.test(l) && /&\s*$/.test(l));
    expect(started.length).toBeGreaterThan(0);
    for (const line of started) expect(line, line).toMatch(/^\s*kubectl /);
  });

  it('names a same-pass switch as its own failure, not as a missing staged key', () => {
    // The operator takes a rotation request and stages the key in one write, so a
    // bound that is not waited shows as an already-switched signing key.
    expect(runSh).toContain('propagation bound ignored');
    expect(runSh).toContain('signing-key-rotation-nonce');
  });
});

describe('the mutation proof is anchored to the code it mutates', () => {
  // mutation-prove.mjs needs a cluster and 10 to 15 minutes per row. These
  // checks need neither: they catch the cheap way a proof rots, an anchor that
  // no longer occurs once, or a reason the lane no longer prints.
  const phases = ['up', 'images', 'deploy', 'verify', 'rotate', 'leaks'];

  it('has at least one row per property the lane claims', () => {
    expect(ROWS.map((r) => r.id)).toEqual(['M1', 'M2', 'M3', 'M4', 'M5', 'M6']);
    expect(new Set(ROWS.map((r) => r.name)).size).toBe(ROWS.length);
  });

  for (const row of ROWS) {
    it(`${row.id} ${row.name}: the anchor occurs exactly once and the mutation changes it`, () => {
      const src = readFileSync(resolve(REPO_ROOT, row.file), 'utf8');
      expect(src.split(row.anchor).length - 1, `${row.file}: ${row.anchor}`).toBe(1);
      expect(row.replacement).not.toBe(row.anchor);
    });

    it(`${row.id} ${row.name}: the lane can print the reason, and runs the phases that notice`, () => {
      expect(runSh, row.reason).toContain(row.reason);
      for (const p of row.phases.split(' ')) expect(phases).toContain(p);
    });
  }
});

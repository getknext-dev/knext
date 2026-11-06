import { describe, expect, it } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

/**
 * The cold-start bench harness (drive.py + cold-cycle.mjs) produces the OKE numbers
 * the cold-start ledger cites. It used to exist as two diverging copies with one
 * cluster's context, namespace, node IPs and scratch paths hard-coded. These tests
 * pin the single-copy layout, scan the harness code for cluster literals, and drive
 * the real drive.py against a fake `kubectl` on PATH (no cluster) to prove that
 * every setting comes from flags, environment or a config file.
 */

const ROOT = resolve(import.meta.dir, '..');
const DIR = join(ROOT, 'scripts/bench-cold-start-phases');
// Repo-relative paths are written out in full on purpose: the directory-scan guard in
// bench-cold-start-analyzers.test.ts treats a quoted occurrence of a script's path as
// "this script has a test".
const DRIVE = 'scripts/bench-cold-start-phases/drive.py';
const COLD_CYCLE = 'scripts/bench-cold-start-phases/cold-cycle.mjs';
const BENCHCONFIG = 'scripts/bench-cold-start-phases/benchconfig.py';
const ANALYZE = 'scripts/bench-cold-start-phases/analyze.py';
const VERIFY_ARMS = 'scripts/bench-cold-start-phases/gke/verify-arms.sh';
const FIXTURE = join(ROOT, 'tests/fixtures/bench-cold-start-phases');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

describe('one harness, no diverging copy', () => {
  it('has exactly one drive.py and one cold-cycle.mjs under the bench directory', () => {
    const files = walk(DIR).map((p) => relative(DIR, p));
    expect(files.filter((f) => f.endsWith('drive.py') && !f.includes('-drive.py'))).toEqual([
      'drive.py',
    ]);
    expect(files.filter((f) => f.endsWith('cold-cycle.mjs'))).toEqual(['cold-cycle.mjs']);
  });

  it('keeps cluster-specific literals out of the harness code', () => {
    // Scan the directory, not a list: a literal added to any harness script must go red.
    // Code files only; the YAML manifests under it are example cluster objects.
    const scanned = walk(DIR)
      .filter((p) => /\.(py|sh|mjs|js)$/.test(p))
      .map((p) => relative(ROOT, p));
    expect(scanned.length).toBeGreaterThanOrEqual(20);
    for (const f of [DRIVE, COLD_CYCLE, BENCHCONFIG, ANALYZE, VERIFY_ARMS]) {
      expect(scanned).toContain(f);
    }
    const forbidden: Array<[string, RegExp]> = [
      // Loopback and the unspecified bind address are not cluster literals.
      ['an IPv4 address', /\b(?!127\.0\.0\.1\b|0\.0\.0\.0\b)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/],
      ['a kubectl context name', /knext-oke-sa|knext-coldstart/],
      ['the bench namespace', /bench-cells/],
      ['a node-agent pod name', /\bagent-(?:118|169|1ws1|c8bn|fm3s)\b/],
      ['a GKE node name', /gke-knext-/],
    ];
    const hits: string[] = [];
    for (const rel of scanned) {
      const text = readFileSync(join(ROOT, rel), 'utf8');
      for (const [what, re] of forbidden) if (re.test(text)) hits.push(`${rel}: ${what}`);
    }
    expect(hits).toEqual([]);
  });
});

describe('example manifests declare their cluster-specific values', () => {
  // The YAML manifests record the cluster each study ran on (namespace, node name or IP, context).
  // The code scan above skips them by design, so the contract is that each one SAYS it is a
  // cluster-specific example, and the README says what to edit. Scanned, not listed.
  const CLUSTER_VALUE =
    /bench-cells|\b(?!127\.0\.0\.1\b|0\.0\.0\.0\b)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|gke-knext-|knext-oke-sa|knext-coldstart/;
  const MARKER = /^# CLUSTER-SPECIFIC EXAMPLE:/m;

  const manifests = walk(DIR).filter((p) => /\.ya?ml$/.test(p));

  it('finds the manifests it is meant to guard', () => {
    expect(manifests.length).toBeGreaterThanOrEqual(10);
  });

  it('marks every manifest that names a cluster value within its first 6 lines', () => {
    const unmarked: string[] = [];
    for (const p of manifests) {
      const text = readFileSync(p, 'utf8');
      if (!CLUSTER_VALUE.test(text)) continue;
      const head = text.split('\n').slice(0, 6).join('\n');
      if (!MARKER.test(head)) unmarked.push(relative(ROOT, p));
    }
    expect(unmarked).toEqual([]);
  });

  it('documents the manifests in the README and no longer claims scripts are unported', () => {
    const readme = readFileSync(join(DIR, 'README.md'), 'utf8');
    expect(readme).toContain('CLUSTER-SPECIFIC EXAMPLE');
    expect(readme).toMatch(/nodeName/);
    expect(readme).not.toMatch(/not yet driven by this config/);
  });
});

// ------------------------------------------------------------------ fake kubectl

const FAKE_KUBECTL = `#!/usr/bin/env python3
# A stateful fake: cordon state lives in a file next to the call log, so the driver's reads see its writes.
#   FAKE_NODES      [{name, pool, cordoned}]       the nodes (default n1/p1 and n2/p2, both open)
#   FAKE_AFTER      [{when, nth, node, cordoned}]  after the nth call containing 'when', someone else sets a cordon
#   FAKE_LOSE       'cordon n2'                    the call takes effect but reports failure (a lost response)
#   FAKE_IGNORE     'cordon n2'                    the call reports success but changes nothing
#   FAKE_CORDON_FAIL n1                            cordon/uncordon of that node fails
#   FAKE_GET_NODE_FAIL_AFTER 4                     every 'get node <name>' after the 4th fails (an API outage)
import json, os, sys
args = sys.argv[1:]
LOG = os.environ["FAKE_KUBECTL_LOG"]
with open(LOG, "a") as f:
    f.write(json.dumps(args) + "\\n")
joined = " ".join(args)
label = os.environ.get("FAKE_POOL_LABEL", "pool")
nodes = json.loads(os.environ.get("FAKE_NODES", "null")) or [
    {"name": "n1", "pool": "p1"}, {"name": "n2", "pool": "p2"}]
STATE = LOG + ".state"
state = json.load(open(STATE)) if os.path.exists(STATE) else {n["name"]: bool(n.get("cordoned")) for n in nodes}
calls = [l for l in open(LOG)]

def node_obj(n):
    return {"metadata": {"name": n["name"], "labels": {label: n["pool"]}},
            "spec": {"unschedulable": True} if state[n["name"]] else {}}

def finish(code=0):
    for h in json.loads(os.environ.get("FAKE_AFTER", "[]")):
        if sum(1 for l in calls if h["when"] in " ".join(json.loads(l))) == h["nth"] and h["when"] in joined:
            state[h["node"]] = h["cordoned"]
    json.dump(state, open(STATE, "w"))
    sys.exit(code)

verb = args[-2] if len(args) >= 2 else ""
if verb in ("cordon", "uncordon"):
    node = args[-1]
    if os.environ.get("FAKE_CORDON_FAIL") == node:
        sys.stderr.write("forbidden\\n")
        finish(1)
    if os.environ.get("FAKE_IGNORE") != verb + " " + node:
        state[node] = verb == "cordon"
    if os.environ.get("FAKE_LOSE") == verb + " " + node:
        sys.stderr.write("connection reset\\n")
        finish(1)
    finish(0)
elif "get nodes" in joined:
    print(json.dumps({"items": [node_obj(n) for n in nodes]}))
elif "get node " in joined:
    if "FAKE_GET_NODE_FAIL_AFTER" in os.environ and sum(
            1 for l in calls if "get node " in " ".join(json.loads(l))) > int(os.environ["FAKE_GET_NODE_FAIL_AFTER"]):
        sys.stderr.write("the server is currently unable to handle the request\\n")
        finish(1)
    name = args[args.index("node") + 1]
    print(json.dumps(node_obj(next(n for n in nodes if n["name"] == name))))
elif "--field-selector" in joined:
    node = joined.split("spec.nodeName=")[1].split()[0]
    seen = sum(1 for l in calls if "spec.nodeName=" + node in l)
    items = [{"metadata": {"namespace": "kube-system", "name": "dns-1", "labels": {}}}]
    if os.environ.get("FAKE_NEW_POD", "").startswith(node + ":") and seen > 1:
        ns, nm = os.environ["FAKE_NEW_POD"].split(":", 1)[1].split("/")
        items.append({"metadata": {"namespace": ns, "name": nm, "labels": {}}})
    items.append({"metadata": {"namespace": "bench", "name": "a1-pod",
                               "labels": {"serving.knative.dev/service": "a1"}}})
    items.append({"metadata": {"namespace": "kube-system", "name": "ds-" + str(seen),
                               "labels": {}, "ownerReferences": [{"kind": "DaemonSet"}]}})
    print(json.dumps({"items": items}))
elif "get pods" in joined:
    print(json.dumps({"items": []}))
elif " cat " in joined:
    import time
    time.sleep(float(os.environ.get("FAKE_SLEEP_CAT", "0")))
    print(os.environ.get("FAKE_CAT_JSON") or json.dumps(
        {"arm": "a1", "code": 200, "node": "n1", "marker": "ok", "watch": {"resp_end": 1}}))
finish(0)
`;

type Run = {
  code: number;
  out: string;
  err: string;
  calls: string[][];
  rows: unknown[];
  state: Record<string, boolean>;
};

function runDrive(
  argv: string[],
  opts: {
    env?: Record<string, string>;
    config?: object;
    timeout?: number;
    killSignal?: NodeJS.Signals;
  } = {},
): Run {
  const dir = mkdtempSync(join(tmpdir(), 'bench-harness-'));
  try {
    const bin = join(dir, 'bin');
    const log = join(dir, 'kubectl.log');
    const outFile = join(dir, 'out.jsonl');
    mkdirSync(bin);
    writeFileSync(join(bin, 'kubectl'), FAKE_KUBECTL);
    chmodSync(join(bin, 'kubectl'), 0o755);
    writeFileSync(log, '');
    // Always point at a config file so a developer's local bench-config.json can never
    // leak into the run.
    const cfgPath = join(dir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify(opts.config ?? {}));
    const env: Record<string, string> = {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      TMPDIR: dir,
      PYTHONDONTWRITEBYTECODE: '1',
      FAKE_KUBECTL_LOG: log,
      KNEXT_BENCH_CONFIG: cfgPath,
      ...opts.env,
    };
    const r = spawnSync(
      'python3',
      [join(ROOT, DRIVE), ...argv.map((a) => a.replace('$OUT', outFile))],
      { encoding: 'utf8', env, timeout: opts.timeout ?? 60_000, killSignal: opts.killSignal },
    );
    const calls = readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[]);
    const rows = existsSync(outFile)
      ? readFileSync(outFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
    const statePath = `${log}.state`;
    const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
    return { code: r.status ?? -1, out: r.stdout, err: r.stderr, calls, rows, state };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FAST = ['--settle=0', '--poll-interval=0'];
const base = (extra: string[] = []) => ['1', 'a1', '$OUT', ...FAST, ...extra];
const flat = (calls: string[][]) => calls.map((c) => c.join(' '));

describe('drive.py: settings come from flags, env or a config file', () => {
  it('with no settings at all, passes no context and no namespace to kubectl and uses the default pod and /tmp', () => {
    const r = runDrive(base());
    expect(r.code).toBe(0);
    expect(r.calls.length).toBeGreaterThan(0);
    for (const c of r.calls) {
      expect(c).not.toContain('--context');
      expect(c).not.toContain('-n');
    }
    const lines = flat(r.calls);
    expect(
      lines.some((l) =>
        /^cp \S+cold-cycle\.mjs phase-bench:\/tmp\/cold-cycle\.mjs -c harness$/.test(l),
      ),
    ).toBe(true);
    expect(
      lines.some((l) => l.includes('exec phase-bench -c harness') && l.includes('/tmp/run-')),
    ).toBe(true);
    expect(r.rows).toHaveLength(1);
  });

  it('applies --context, --namespace, --pod and --scratch-dir to every call', () => {
    const r = runDrive(
      base(['--context=ctx-x', '--namespace=ns-y', '--pod=pod-z', '--scratch-dir=/scratch/q']),
    );
    expect(r.code).toBe(0);
    for (const c of r.calls) {
      expect(c.slice(0, 4)).toEqual(['--context', 'ctx-x', '-n', 'ns-y']);
    }
    const lines = flat(r.calls);
    expect(lines.some((l) => l.endsWith('pod-z:/scratch/q/cold-cycle.mjs -c harness'))).toBe(true);
    const launch = lines.find((l) => l.includes('nohup'));
    expect(launch).toContain('exec pod-z -c harness');
    expect(launch).toContain('node /scratch/q/cold-cycle.mjs a1 > /scratch/q/run-');
    expect(launch).toContain('NS=ns-y');
    expect(launch).not.toContain('/tmp/');
  });

  it('reads the same settings from a config file', () => {
    const r = runDrive(base(), {
      config: { context: 'ctx-f', namespace: 'ns-f', harnessPod: 'pod-f', scratchDir: '/sf' },
    });
    expect(r.code).toBe(0);
    for (const c of r.calls) expect(c.slice(0, 4)).toEqual(['--context', 'ctx-f', '-n', 'ns-f']);
    expect(flat(r.calls).some((l) => l.includes('pod-f:/sf/cold-cycle.mjs'))).toBe(true);
  });

  it('ranks flag over environment over config file', () => {
    const cfg = { context: 'from-file', namespace: 'ns-file', harnessPod: 'pod-file' };
    const env = { KNEXT_BENCH_CONTEXT: 'from-env', KNEXT_BENCH_NAMESPACE: 'ns-env' };
    const r = runDrive(base(['--namespace=ns-flag']), { config: cfg, env });
    expect(r.code).toBe(0);
    // context: env beats file; namespace: flag beats env; pod: only the file sets it.
    for (const c of r.calls)
      expect(c.slice(0, 4)).toEqual(['--context', 'from-env', '-n', 'ns-flag']);
    expect(flat(r.calls).some((l) => l.includes('exec pod-file -c harness'))).toBe(true);
  });

  it('still honours the older PHASE_POD variable for the harness pod', () => {
    const r = runDrive(base(), { env: { PHASE_POD: 'phase-bench-2' } });
    expect(flat(r.calls).some((l) => l.includes('exec phase-bench-2 -c harness'))).toBe(true);
  });

  it('hands the node -> agent-pod map and the namespace to the in-cluster harness', () => {
    const r = runDrive(base(['--namespace=ns-y', '--agent-pods={"node-1":"agent-a"}']));
    const launch = flat(r.calls).find((l) => l.includes('nohup')) ?? '';
    expect(launch).toContain('NS=ns-y');
    expect(launch).toContain('AGENT_PODS=');
    expect(launch).toContain('node-1');
    expect(launch).toContain('agent-a');
  });

  it('rejects a config file with an unknown key instead of silently ignoring it', () => {
    const r = runDrive(base(), { config: { contxt: 'typo' } });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('contxt');
  });

  it('places an arm@pool spec by cordoning the other pools, then uncordons everything', () => {
    const r = runDrive(['1', 'a1@p1', '$OUT', ...FAST, '--pool-label=my/pool'], {
      env: { FAKE_POOL_LABEL: 'my/pool' },
    });
    expect(r.code).toBe(0);
    const verbs = r.calls
      .filter((c) => c.some((a) => a === 'cordon' || a === 'uncordon'))
      .map((c) =>
        c
          .filter((a) => a !== '--context')
          .slice(-2)
          .join(' '),
      );
    // wake placed on p1: cordon n2 (p2), uncordon n1 (p1); finally uncordon both.
    expect(verbs).toContain('cordon n2');
    expect(verbs).toContain('uncordon n1');
    expect(verbs.slice(-2).sort()).toEqual(['uncordon n1', 'uncordon n2']);
    expect(r.rows[0]).toMatchObject({ arm: 'a1@p1', pool: 'p1' });
  });

  it('does not touch node scheduling when no arm names a pool', () => {
    const r = runDrive(base());
    expect(flat(r.calls).some((l) => /cordon|get nodes/.test(l))).toBe(false);
  });
});

describe('drive.py: --place-mode=restore leaves every cordon as it found it', () => {
  type N = { name: string; pool: string; cordoned?: boolean };
  const run = (
    nodes: N[],
    extra: string[] = [],
    env: Record<string, string> = {},
    arms = 'a1@p1,a2@p2',
    timeout?: number,
  ) =>
    runDrive(['1', arms, '$OUT', ...FAST, '--pool-label=pool', '--place-mode=restore', ...extra], {
      env: { FAKE_NODES: JSON.stringify(nodes), ...env },
      timeout,
    });
  const cordonCalls = (r: Run) =>
    r.calls
      .filter((c) => c.some((a) => a === 'cordon' || a === 'uncordon'))
      .map((c) => c.slice(-2).join(' '));
  // Replays the cordon calls over the starting state and returns the end state.
  const endState = (nodes: N[], calls: string[]) => {
    const st = new Map(nodes.map((n) => [n.name, !!n.cordoned]));
    for (const c of calls) {
      const [verb, name] = c.split(' ');
      st.set(name, verb === 'cordon');
    }
    return Object.fromEntries(st);
  };
  const P_COR: N[] = [
    { name: 'n1', pool: 'p1', cordoned: true },
    { name: 'n2', pool: 'p2' },
  ];

  it('runs both wakes and ends with the node that started cordoned still cordoned', () => {
    const r = run(P_COR);
    expect(r.code).toBe(0);
    expect(r.rows).toHaveLength(2);
    expect(endState(P_COR, cordonCalls(r))).toEqual({ n1: true, n2: false });
  });

  it('never leaves the patched node open while the control is also open', () => {
    const r = run(P_COR);
    const st = new Map(P_COR.map((n) => [n.name, !!n.cordoned]));
    let sawOpen = false;
    for (const c of cordonCalls(r)) {
      const [verb, name] = c.split(' ');
      st.set(name, verb === 'cordon');
      // n1 is the patched node: whenever it is open, the control must be cordoned.
      if (st.get('n1') === false) {
        expect(st.get('n2')).toBe(true);
        sawOpen = true;
      }
    }
    expect(sawOpen).toBe(true);
  });

  it('puts the cordons back between wakes, so the patched node is closed once its wake ends', () => {
    const r = run(P_COR);
    const lines = cordonCalls(r);
    const open = lines.indexOf('uncordon n1');
    expect(open).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf('cordon n1', open)).toBeGreaterThan(open);
  });

  it('never touches a node outside the arms pools, even one cordoned by someone else', () => {
    const nodes: N[] = [...P_COR, { name: 'n3', pool: 'p3', cordoned: true }];
    const r = run(nodes);
    expect(r.code).toBe(0);
    expect(cordonCalls(r).some((l) => l.endsWith(' n3'))).toBe(false);
    expect(endState(nodes, cordonCalls(r))).toEqual({ n1: true, n2: false, n3: true });
  });

  it('refuses before any wake when a node outside the arms pools is schedulable', () => {
    const r = run([...P_COR, { name: 'n3', pool: 'p3' }]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('n3');
    expect(cordonCalls(r)).toEqual([]);
    expect(flat(r.calls).some((l) => l.includes('nohup'))).toBe(false);
  });

  it('refuses an arm without a pool, because restore mode pins by pool', () => {
    const r = run(P_COR, [], {}, 'a1@p1,a2');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('arm@pool');
  });

  it('stops with a non-zero exit and no wake when a cordon is refused, and undoes what it changed', () => {
    const r = run(P_COR, [], { FAKE_CORDON_FAIL: 'n1' });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('cannot uncordon n1');
    expect(r.rows).toHaveLength(0);
    // The refused call is in the log but changed nothing, so it is left out of the replay.
    const applied = cordonCalls(r).filter((l) => l !== 'uncordon n1');
    expect(cordonCalls(r)).toContain('cordon n2');
    expect(endState(P_COR, applied)).toEqual({ n1: true, n2: false });
  });

  it('tags every row with the block label', () => {
    const r = run(P_COR, ['--block=b3']);
    expect(r.rows.map((x) => (x as { block: string }).block)).toEqual(['b3', 'b3']);
  });

  it('records pods that appeared on the woken node and are not the arm, a DaemonSet or already there', () => {
    const r = run(P_COR, [], { FAKE_NEW_POD: 'n1:other/stray' });
    const first = r.rows[0] as { foreign_new_pods: string[] };
    expect(first.foreign_new_pods).toEqual(['other/stray']);
    const clean = run(P_COR);
    expect((clean.rows[0] as { foreign_new_pods: string[] }).foreign_new_pods).toEqual([]);
  });

  it('restores the cordons when it is terminated in the middle of a wake', () => {
    // The wake is stuck in a slow kubectl; the test's timeout sends SIGTERM to the driver.
    const r = run(P_COR, [], { FAKE_SLEEP_CAT: '5' }, 'a1@p1,a2@p2', 2000);
    expect(r.code).toBe(143);
    expect(r.rows).toHaveLength(0);
    // The patched node was opened for its wake; the exit path put it and the control back.
    expect(cordonCalls(r)).toContain('uncordon n1');
    expect(endState(P_COR, cordonCalls(r))).toEqual({ n1: true, n2: false });
  });

  // Runs the driver with the P_COR nodes and any extra flags, env and rounds.
  const go = (
    o: {
      rounds?: string;
      extra?: string[];
      env?: Record<string, string>;
      timeout?: number;
      killSignal?: NodeJS.Signals;
    } = {},
  ) =>
    runDrive(
      [
        o.rounds ?? '1',
        'a1@p1,a2@p2',
        '$OUT',
        ...FAST,
        '--pool-label=pool',
        '--place-mode=restore',
        ...(o.extra ?? []),
      ],
      {
        env: { FAKE_NODES: JSON.stringify(P_COR), ...o.env },
        timeout: o.timeout,
        killSignal: o.killSignal,
      },
    );
  // Fires at round 2's zero-pod check of a1 (the third a1 query): between two wakes, nodes at rest.
  const AT_REST = { when: 'service=a1', nth: 3 };

  it('stops, and leaves the control cordoned, when someone else cordons it between wakes', () => {
    const r = go({
      rounds: '2',
      env: { FAKE_AFTER: JSON.stringify([{ ...AT_REST, node: 'n2', cordoned: true }]) },
    });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('changed by someone else');
    expect(r.err).toContain('n2 is cordoned');
    expect(r.state.n2).toBe(true); // never uncordoned by the run
    expect(r.rows).toHaveLength(2); // only round 1 was made
  });

  it('stops, and does not re-cordon the patched node, when someone else uncordons it at rest', () => {
    const r = go({
      rounds: '2',
      env: { FAKE_AFTER: JSON.stringify([{ ...AT_REST, node: 'n1', cordoned: false }]) },
    });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('changed by someone else');
    expect(r.err).toContain('n1 is open');
    expect(r.state.n1).toBe(false); // left as the other party left it, not silently restored
    expect(r.rows).toHaveLength(2);
  });

  it('counts a cordon whose response was lost but took effect as done', () => {
    const r = go({ env: { FAKE_LOSE: 'uncordon n1' } });
    expect(r.code).toBe(0);
    expect(r.rows).toHaveLength(2);
    expect(r.state).toEqual({ n1: true, n2: false });
  });

  it('does not report a cordon as done when the call succeeded but changed nothing', () => {
    const r = go({ env: { FAKE_IGNORE: 'cordon n2' } });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('cannot cordon n2');
    expect(r.rows).toHaveLength(0);
  });

  it('refuses to start when the nodes are not in the state the operator says they should be', () => {
    const ok = go({ extra: ['--expect-state=n1:cordoned,n2:open'] });
    expect(ok.code).toBe(0);
    const bad = go({ extra: ['--expect-state=n1:open,n2:open'] });
    expect(bad.code).not.toBe(0);
    expect(bad.err).toContain('may have died mid-wake');
    expect(cordonCalls(bad)).toEqual([]);
    expect(bad.rows).toHaveLength(0);
  });

  it('restores the cordons on SIGHUP as it does on SIGTERM', () => {
    const r = go({ env: { FAKE_SLEEP_CAT: '5' }, timeout: 2000, killSignal: 'SIGHUP' });
    expect(r.code).toBe(129);
    expect(r.state).toEqual({ n1: true, n2: false });
  });

  it('refuses to run next to another restore-mode driver (one lock per workstation)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-lock-'));
    const lock = join(dir, 'drive.lock');
    const holder = spawn(
      'python3',
      [
        '-c',
        `import fcntl, sys, time\nf = open(sys.argv[1], 'w')\nfcntl.flock(f, fcntl.LOCK_EX)\ntime.sleep(8)`,
        lock,
      ],
      { stdio: 'ignore' },
    );
    try {
      Bun.sleepSync(500);
      const r = go({ extra: [`--lock-file=${lock}`] });
      expect(r.code).not.toBe(0);
      expect(r.err).toContain('another restore-mode driver');
      expect(cordonCalls(r)).toEqual([]);
    } finally {
      holder.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops at once, with a message, when a foreign pod appears on a named pool, and restores', () => {
    const r = go({
      extra: ['--abort-on-foreign=p1'],
      env: { FAKE_NEW_POD: 'n1:other/stray' },
    });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('FOREIGN POD on pool p1: other/stray');
    expect(r.err).toContain('stopping: foreign pod');
    expect(r.rows).toHaveLength(1); // the wake is on disk before the stop
    expect(r.state).toEqual({ n1: true, n2: false });
    // Not named: it is printed but the run goes on.
    const other = go({ extra: ['--abort-on-foreign=p2'], env: { FAKE_NEW_POD: 'n1:other/stray' } });
    expect(other.code).toBe(0);
    expect(other.err).toContain('FOREIGN POD on pool p1');
  });

  it('stops mid-run when failed wakes pass the fraction of the planned wakes', () => {
    const fail = '{"arm":"a1","error":"harness produced no result in 240 s"}';
    const r = go({ extra: ['--abort-failed-fraction=0.1'], env: { FAKE_CAT_JSON: fail } });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('stopping: 1 failed wakes of 2 planned');
    expect(r.rows).toHaveLength(1);
    expect(r.state).toEqual({ n1: true, n2: false });
    const good = '{"arm":"a1","node":"n1","watch":{"first_byte":5}}';
    const ok = go({ extra: ['--abort-failed-fraction=0.1'], env: { FAKE_CAT_JSON: good } });
    expect(ok.code).toBe(0);
  });

  it('reports an API outage during the restore with the exact recovery commands, not a traceback', () => {
    // 2 reads in the check, 1 after each of the 2 changes: the 5th read is the first one in the restore.
    const r = go({ env: { FAKE_GET_NODE_FAIL_AFTER: '4' } });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('RESTORE FAILED');
    expect(r.err).toContain('could not read or change it');
    expect(r.err).toContain('Rest state to set by hand: kubectl cordon n1; kubectl uncordon n2');
    expect(r.err).not.toContain('Traceback');
    expect(r.state).toEqual({ n1: false, n2: true }); // P open, S closed: exactly what the message fixes
  });

  it('reports an outage that starts before the first placement, with no traceback either', () => {
    const r = go({ env: { FAKE_GET_NODE_FAIL_AFTER: '0' } });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('driver error: CalledProcessError');
    expect(r.err).toContain('Rest state to set by hand');
    expect(r.err).not.toContain('Traceback');
    expect(r.rows).toHaveLength(0);
  });

  it('makes 4 cordon writes per P window, which is what the runbook multiplies', () => {
    const r = go({ rounds: '2' });
    expect(r.code).toBe(0);
    const writes = cordonCalls(r);
    const windows = writes.filter((l) => l === 'uncordon n1').length; // P opens once per window
    expect(windows).toBe(2);
    expect(writes).toHaveLength(4 * windows);
    // The runbook's totals follow from it: windows per block = rounds + warm-up rounds.
    const rb = readFileSync(
      join(ROOT, 'scripts/bench-cold-start-phases/ceiling/RUNBOOK.md'),
      'utf8',
    );
    expect(rb).toContain('4 cordon writes each');
    const perBlock = 30 + 2;
    expect(rb).toContain(
      `${2 * perBlock} P windows, 4 cordon writes each, ${4 * 2 * perBlock} writes`,
    );
    expect(rb).toMatch(/drive\.py 30/);
    expect(rb).toContain('`2`\n   in place of `30`');
  });

  it('keeps the default all-pools mode unchanged', () => {
    const r = runDrive(['1', 'a1@p1', '$OUT', ...FAST]);
    expect(r.code).toBe(0);
    expect(r.rows[0]).not.toHaveProperty('foreign_new_pods');
  });
});

describe('cold-cycle.mjs: in-cluster settings', () => {
  function printConfig(env: Record<string, string>) {
    const r = spawnSync('node', [join(ROOT, COLD_CYCLE), '--print-config', 'a1'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', ...env },
    });
    return { code: r.status ?? -1, json: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr };
  }

  it('takes the namespace, agent map and agent label from the environment', () => {
    const r = printConfig({
      NS: 'ns-y',
      AGENT_PODS: '{"node-1":"agent-a"}',
      AGENT_LABEL: 'role=probe',
    });
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      namespace: 'ns-y',
      agentPods: { 'node-1': 'agent-a' },
      agentLabel: 'role=probe',
      arm: 'a1',
    });
  });

  it('defaults to no agent map and the phase-agent label, with no namespace literal', () => {
    const r = printConfig({ NS: 'ns-y' });
    expect(r.json).toMatchObject({ agentPods: {}, agentLabel: 'app=phase-agent' });
  });
});

describe('analyze.py: namespace filter is a flag, not a literal', () => {
  function analyze(extra: string[]) {
    const r = spawnSync(
      'python3',
      [
        join(ROOT, ANALYZE),
        join(FIXTURE, 'run.jsonl'),
        `--autoscaler=${join(FIXTURE, 'autoscaler.jsonl')}`,
        `--activator=${join(FIXTURE, 'activator.jsonl')}`,
        ...extra,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: '1',
          KNEXT_BENCH_CONFIG: join(FIXTURE, 'empty-config.json'),
        },
      },
    );
    return r.stdout;
  }

  it('--namespace keeps only that namespace; another namespace yields no control-plane rows', () => {
    const mine = analyze(['--namespace=bench-cells']);
    const none = analyze(['--namespace=nowhere']);
    expect(mine).toContain('0 autoscaler decides 0->1');
    expect(none).not.toContain('autoscaler decides');
    expect(none).toContain('### base (n=4)');
  });

  it('without a namespace the filter is off: lines under any namespace are joined by revision name', () => {
    // var-00002 has one autoscaler line under another namespace; only the unfiltered
    // run can see it. (Filtered runs above exclude it.)
    const filtered = analyze(['--namespace=bench-cells']);
    const open = analyze([]);
    const varRow = (t: string) =>
      t
        .split('### var')[1]
        ?.split('\n')
        .find((l) => l.startsWith('| 0 autoscaler')) ?? '';
    expect(varRow(open)).not.toBe(varRow(filtered));
  });
});

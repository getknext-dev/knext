// Thin kubectl wrapper pinned to the spike's private kind kubeconfig. Every
// call checks the context, so nothing here can reach a remote cluster.
import { spawnSync } from 'node:child_process';

export const NS = 'z2';
export const CONTEXT = 'kind-knext-z2-coldstart';
const KUBECONFIG = process.env.Z2_KUBECONFIG;
if (!KUBECONFIG) throw new Error('set Z2_KUBECONFIG');

export function kubectl(args: string[], input?: string): string {
  const r = spawnSync('kubectl', ['--context', CONTEXT, ...args], {
    env: { ...process.env, KUBECONFIG },
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`kubectl ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

export function applyJson(obj: unknown): void {
  kubectl(['apply', '--validate=strict', '-f', '-'], JSON.stringify(obj));
}

type PodList = {
  items: {
    metadata: { name: string; deletionTimestamp?: string; labels?: Record<string, string> };
  }[];
};

function livePods(selector: string): PodList['items'] {
  const list = JSON.parse(
    kubectl(['get', 'pods', '-n', NS, '-l', selector, '-o', 'json']),
  ) as PodList;
  // A Terminating pod is out of the endpoints and cannot serve the request, so
  // only non-terminating pods make a service "warm".
  return list.items.filter((p) => !p.metadata.deletionTimestamp);
}

/** Non-terminating pods backing a Knative Service. */
export function podCount(svc: string): number {
  return livePods(`serving.knative.dev/service=${svc}`).length;
}

/** Non-terminating Knative-managed pods in the namespace, by service. */
export function allKnPods(): string[] {
  return livePods('serving.knative.dev/service').map(
    (p) => p.metadata.labels?.['serving.knative.dev/service'] ?? p.metadata.name,
  );
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run curl inside the driver pod; curl itself times the request. */
export function curl(url: string, maxTimeS = 90): { ms: number; code: number; body: string } {
  const out = kubectl([
    'exec',
    '-n',
    NS,
    'z2-driver',
    '--',
    'curl',
    '-s',
    '-m',
    String(maxTimeS),
    '-w',
    '\n__Z2__ %{time_total} %{http_code}',
    url,
  ]);
  const idx = out.lastIndexOf('\n__Z2__ ');
  const body = out.slice(0, idx);
  const [, t, code] = out
    .slice(idx + 1)
    .trim()
    .split(' ');
  return { ms: Number(t) * 1000, code: Number(code), body };
}

export function svcUrl(name: string, path = ''): string {
  return `http://${name}.${NS}.svc.cluster.local${path}`;
}

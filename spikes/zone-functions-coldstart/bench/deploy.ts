// Deploy the Z2 function services and the zone clones.
//
// Functions: plain cluster-local Knative Services (the BackendService CRD is
// Z8 and does not exist yet). Each language is deployed twice from ONE image:
// "-h1" names the container port http1, "-h2" names it h2c, which is how
// Knative decides the protocol queue-proxy and the activator speak to it.
//
// Zones: `zone-node` and `zone-bun` come from `kn-next deploy` (stage-zone.sh).
// Every other zone is a clone of those NextApp CRs (same digest-pinned image)
// that only changes the name and env, so the operator renders it identically.
//
// Usage: bun deploy.ts   (env Z2_KUBECONFIG, FN_GO_IMAGE, FN_RUST_IMAGE)
import { applyJson, kubectl, NS } from './k';

export const FNS = ['fn-go-h1', 'fn-go-h2', 'fn-rust-h1', 'fn-rust-h2'] as const;
export const GATEWAYS = ['node', 'bun'] as const;

function fnService(
  name: string,
  image: string,
  portName: 'http1' | 'h2c',
  extraAnnotations: Record<string, string> = {},
) {
  return {
    apiVersion: 'serving.knative.dev/v1',
    kind: 'Service',
    metadata: {
      name,
      namespace: NS,
      labels: { 'networking.knative.dev/visibility': 'cluster-local' },
    },
    spec: {
      template: {
        metadata: {
          annotations: {
            'autoscaling.knative.dev/min-scale': '0',
            'autoscaling.knative.dev/max-scale': '1',
            ...extraAnnotations,
          },
        },
        spec: {
          containerConcurrency: 0,
          containers: [
            {
              image,
              ports: [{ name: portName, containerPort: 8080 }],
              resources: { requests: { cpu: '100m', memory: '32Mi' }, limits: { memory: '64Mi' } },
            },
          ],
        },
      },
    },
  };
}

function cloneZone(from: string, name: string, env: Record<string, string>) {
  const src = JSON.parse(kubectl(['get', 'nextapp', from, '-n', NS, '-o', 'json']));
  return {
    apiVersion: src.apiVersion,
    kind: src.kind,
    metadata: { name, namespace: NS },
    spec: { ...src.spec, env: { ...(src.spec.env ?? {}), ...env } },
  };
}

if (import.meta.main) {
  const goImage = process.env.FN_GO_IMAGE;
  const rustImage = process.env.FN_RUST_IMAGE;
  if (!goImage || !rustImage) throw new Error('set FN_GO_IMAGE and FN_RUST_IMAGE (digest refs)');
  const only = process.argv[2];

  if (!only || only === 'fns') {
    applyJson(fnService('fn-go-h1', goImage, 'http1'));
    applyJson(fnService('fn-go-h2', goImage, 'h2c'));
    applyJson(fnService('fn-rust-h1', rustImage, 'http1'));
    applyJson(fnService('fn-rust-h2', rustImage, 'h2c'));
  }
  if (!only || only === 'zones') {
    for (const gw of GATEWAYS) {
      const base = `zone-${gw}`;
      applyJson(cloneZone(base, `zone-${gw}-d`, { FN_NAMESPACE: NS }));
      for (const fn of FNS) {
        applyJson(
          cloneZone(base, `zone-${gw}-wa-${fn.replace('fn-', '')}`, {
            FN_NAMESPACE: NS,
            WAKE_AHEAD: '1',
            BOUND_FUNCTIONS: fn,
          }),
        );
      }
    }
  }
  console.log('applied');
}

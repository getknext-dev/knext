/**
 * cr-builder.ts — NextApp CR renderer (no bun / no cluster side-effects)
 *
 * This module is intentionally free of any bun/shell imports so it can be
 * tested under vitest/Node and imported by deploy.ts without coupling the
 * CR-rendering logic to the exec layer.
 *
 * ADR-0001: the CLI's job is build → push → apply the NextApp CR.
 * The operator reconciles everything else (ksvc, SA, PVC, KafkaSource).
 */

import YAML from 'yaml';
import type { KnativeNextConfig } from '../config';

/**
 * Builds a NextApp CR object from a KnativeNextConfig and a resolved image ref.
 * The image MUST be digest-pinned (the operator enforces this at reconcile time).
 *
 * Invariants preserved (A1-cli discipline):
 * - scale-to-zero: scaling.minScale defaults to 0
 * - bytecode cache: cache.enableBytecodeCache=true when provider=redis
 * - NODE_COMPILE_CACHE wiring: operator reads cache.enableBytecodeCache
 */
export function buildNextAppCRObject(
  config: KnativeNextConfig,
  image: string,
  namespace: string,
): Record<string, unknown> {
  // Scaling — preserve minScale:0 (scale-to-zero invariant)
  const minScale = config.scaling?.minScale ?? 0;
  const maxScale = config.scaling?.maxScale ?? 10;
  const scaling = {
    minScale,
    maxScale,
    ...(config.scaling ? {} : {}),
  };

  // Resources — from config.scaling (legacy field names match ResourcesSpec)
  const resources =
    config.scaling?.cpuRequest ||
    config.scaling?.memoryRequest ||
    config.scaling?.cpuLimit ||
    config.scaling?.memoryLimit
      ? {
          cpuRequest: config.scaling.cpuRequest ?? '250m',
          memoryRequest: config.scaling.memoryRequest ?? '512Mi',
          cpuLimit: config.scaling.cpuLimit ?? '1000m',
          memoryLimit: config.scaling.memoryLimit ?? '1Gi',
        }
      : undefined;

  // Storage spec
  const storage = config.storage
    ? {
        provider: config.storage.provider,
        bucket: config.storage.bucket,
        ...(config.storage.region ? { region: config.storage.region } : {}),
        ...(config.storage.endpoint ? { endpoint: config.storage.endpoint } : {}),
      }
    : undefined;

  // Cache spec — enable bytecode cache when Redis is configured
  // (operator uses cache.enableBytecodeCache to provision PVC + NODE_COMPILE_CACHE)
  const cache = config.cache
    ? {
        provider: config.cache.provider,
        url: config.cache.provider === 'redis' ? config.cache.url : '',
        ...(config.cache.provider === 'redis' && config.cache.keyPrefix
          ? { keyPrefix: config.cache.keyPrefix }
          : {}),
        // Enable bytecode cache by default when Redis is available —
        // this is what triggers the PVC + NODE_COMPILE_CACHE env var in the operator
        enableBytecodeCache: config.cache.provider === 'redis',
      }
    : undefined;

  // Revalidation spec
  const revalidation =
    config.queue && config.queue.provider === 'kafka'
      ? {
          queue: 'kafka',
          kafkaBrokerUrl: config.queue.brokerUrl,
        }
      : undefined;

  // Secrets spec — map SecretsConfig → SecretsSpec
  const secrets = config.secrets
    ? {
        ...(config.secrets.envFrom?.length ? { envFrom: config.secrets.envFrom } : {}),
        ...(config.secrets.envMap
          ? {
              envMap: Object.fromEntries(
                Object.entries(config.secrets.envMap).map(([k, v]) => [
                  k,
                  { secretName: v.name, secretKey: v.key ?? k },
                ]),
              ),
            }
          : {}),
      }
    : undefined;

  // Observability spec
  const observability = config.observability?.enabled ? { enabled: true } : undefined;

  // Runtime
  const runtime = config.runtime ?? undefined;

  const spec: Record<string, unknown> = {
    image,
    scaling,
    ...(resources ? { resources } : {}),
    ...(storage ? { storage } : {}),
    ...(cache ? { cache } : {}),
    ...(revalidation ? { revalidation } : {}),
    ...(config.secrets ? { secrets } : {}),
    ...(observability ? { observability } : {}),
    ...(config.healthCheckPath ? { healthCheckPath: config.healthCheckPath } : {}),
    ...(runtime ? { runtime } : {}),
  };

  return {
    apiVersion: 'apps.kn-next.dev/v1alpha1',
    kind: 'NextApp',
    metadata: {
      name: config.name,
      namespace,
    },
    spec,
  };
}

/**
 * Renders a NextApp CR as a YAML string.
 * Pure function — no I/O, no shell calls.
 */
export function renderNextAppCR(
  config: KnativeNextConfig,
  image: string,
  namespace: string,
): string {
  const crObject = buildNextAppCRObject(config, image, namespace);
  return YAML.stringify(crObject);
}

/**
 * ExecFn is the exec-boundary type injected into dryRunDeploy.
 * In production this wraps bun's `$`; in tests it is a spy.
 */
export type ExecFn = (cmd: string) => Promise<unknown>;

/**
 * dryRunDeploy renders the NextApp CR YAML and returns it WITHOUT
 * executing any cluster or shell commands.
 *
 * @param config   - kn-next config
 * @param image    - resolved, digest-pinned image ref
 * @param namespace - target k8s namespace
 * @param execFn   - injected exec boundary (spy target in tests; never called in dry-run)
 * @returns CR YAML string
 */
export async function dryRunDeploy(
  config: KnativeNextConfig,
  image: string,
  namespace: string,
  execFn?: ExecFn,
): Promise<string> {
  // execFn is intentionally unused in dry-run mode.
  // Its presence as a parameter allows tests to spy and assert 0 calls.
  void execFn;
  return renderNextAppCR(config, image, namespace);
}

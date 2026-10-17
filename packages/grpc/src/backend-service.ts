/**
 * The `BackendService` custom resource, as `knext deploy function` emits it.
 *
 * ADR-0052 D3 (amended): the `BackendService` CR is the only deployment path
 * for a zone function and the operator the only reconciler; the CLI may build
 * and apply that CR, exactly as it does `NextApp`, and nothing else.
 *
 * What the CLI writes is the function half of the binding: `spec.zone` names
 * the owning `NextApp`. The operator resolves it and sets the
 * `ownerReference` itself, so the CLI never emits one (ADR-0004 Amendment 2).
 * The spec has no `serviceAccountName`: the function always runs as an
 * operator-owned ServiceAccount, and a strict apply refuses a stray one.
 *
 * Pure: no I/O, no cluster calls. The apply lives in `deploy-function.ts`.
 */

import { checkFunctionName, GrpcUsageError } from './config';
import { parseVersion } from './semver';

/** Same group and version as `NextApp` (`packages/kn-next-operator/api/v1alpha1`). */
export const BACKEND_SERVICE_API_VERSION = 'apps.kn-next.dev/v1alpha1';
export const BACKEND_SERVICE_KIND = 'BackendService';

export interface BackendServiceScalingInput {
  readonly minScale?: number;
  readonly maxScale?: number;
  readonly containerConcurrency?: number;
}

export interface BackendServiceInput {
  /** The function's name; also the object's name and the `<NAME>_SERVICE_URL` stem. */
  readonly name: string;
  readonly namespace: string;
  /** The owning `NextApp` in the same namespace. */
  readonly zone: string;
  /** The function image, pinned by digest. */
  readonly image: string;
  readonly language: string;
  readonly port?: number;
  readonly protoVersion?: string;
  readonly wakeAhead?: boolean;
  readonly scaling?: BackendServiceScalingInput;
}

export interface BackendServiceCR {
  readonly apiVersion: typeof BACKEND_SERVICE_API_VERSION;
  readonly kind: typeof BACKEND_SERVICE_KIND;
  readonly metadata: { readonly name: string; readonly namespace: string };
  readonly spec: {
    readonly zone: string;
    readonly image: string;
    readonly language: string;
    readonly port?: number;
    readonly protoVersion?: string;
    readonly wakeAhead?: boolean;
    readonly scaling?: BackendServiceScalingInput;
  };
}

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const DIGEST = /@sha256:[0-9a-f]{64}$/;

/** Returns the problem with `image`, or `undefined`. A tag-only ref and `:latest` are refused. */
export function checkImageDigest(image: string): string | undefined {
  if (!DIGEST.test(image)) {
    return (
      `image "${image}" is not pinned by digest: use <registry>/<repo>@sha256:<64 hex digits> ` +
      '(a tag-only reference and :latest are refused, as for a zone)'
    );
  }
  return undefined;
}

function label(kind: string, value: string): void {
  if (value.length === 0 || value.length > 63 || !DNS_LABEL.test(value)) {
    throw new GrpcUsageError(
      `${kind} "${value}" is not a valid name: use lowercase letters, digits and '-' (at most 63 characters)`,
    );
  }
}

function intIn(kind: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new GrpcUsageError(`${kind} must be a whole number from ${min} to ${max}`);
  }
}

/** Validate `input` and build the CR. Throws {@link GrpcUsageError}; nothing is written. */
export function buildBackendServiceCR(input: BackendServiceInput): BackendServiceCR {
  const nameProblem = checkFunctionName(input.name);
  if (nameProblem) throw new GrpcUsageError(nameProblem);
  label('namespace', input.namespace);
  label('zone', input.zone);
  const imageProblem = checkImageDigest(input.image);
  if (imageProblem) throw new GrpcUsageError(imageProblem);
  if (input.port !== undefined) intIn('port', input.port, 1, 65535);
  if (input.protoVersion !== undefined && !parseVersion(input.protoVersion)) {
    throw new GrpcUsageError(
      `proto version "${input.protoVersion}" is not a semantic version (MAJOR.MINOR.PATCH)`,
    );
  }
  const s = input.scaling;
  if (s?.minScale !== undefined) intIn('minScale', s.minScale, 0, Number.MAX_SAFE_INTEGER);
  if (s?.maxScale !== undefined) intIn('maxScale', s.maxScale, 0, Number.MAX_SAFE_INTEGER);
  if (s?.containerConcurrency !== undefined) {
    intIn('containerConcurrency', s.containerConcurrency, 0, 1000);
  }
  if (s?.minScale !== undefined && s.maxScale !== undefined && s.maxScale !== 0) {
    if (s.minScale > s.maxScale) {
      throw new GrpcUsageError('minScale must not exceed maxScale');
    }
  }

  return {
    apiVersion: BACKEND_SERVICE_API_VERSION,
    kind: BACKEND_SERVICE_KIND,
    metadata: { name: input.name, namespace: input.namespace },
    spec: {
      zone: input.zone,
      image: input.image,
      language: input.language,
      ...(input.port === undefined ? {} : { port: input.port }),
      ...(input.protoVersion === undefined ? {} : { protoVersion: input.protoVersion }),
      ...(input.wakeAhead === undefined ? {} : { wakeAhead: input.wakeAhead }),
      ...(s === undefined ? {} : { scaling: s }),
    },
  };
}

/**
 * The CR as text. JSON, which `kubectl apply -f` reads as a manifest and which
 * is also valid YAML, so core's preflight parses the same file.
 */
export function renderBackendServiceCR(cr: BackendServiceCR): string {
  return `${JSON.stringify(cr, null, 2)}\n`;
}

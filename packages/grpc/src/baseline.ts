/**
 * Where `buf breaking` gets the contract to compare against.
 *
 * Two kinds of baseline:
 *
 * - **A buf input** — a directory, an image file, or a git reference such as
 *   `.git#branch=main,subdir=proto`. Passed to buf unchanged. This is what CI
 *   and local runs use today.
 * - **The deployed contract** — `deployed:<namespace>/<name>`, the contract a
 *   running function serves, as recorded in its `BackendService` status. That
 *   status field does not exist yet, so this kind goes through the
 *   {@link DeployedBaselineSource} seam, and with no source wired in it fails
 *   loudly instead of quietly passing.
 *   TODO(#2052): wire a source that reads the served contract from the live
 *   `BackendService` status once the operator records it.
 */

export interface DeployedRef {
  readonly namespace: string;
  readonly name: string;
}

/** Turns a deployed function into a buf input holding the contract it serves. */
export interface DeployedBaselineSource {
  resolve(ref: DeployedRef): Promise<string>;
}

export class BaselineUnavailableError extends Error {
  override name = 'BaselineUnavailableError';
}

const DEPLOYED_PREFIX = 'deployed:';
const K8S_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Resolve a `--against` value to the buf input `buf breaking` compares with. */
export async function resolveBaseline(
  spec: string,
  deployed?: DeployedBaselineSource,
): Promise<string> {
  if (!spec.startsWith(DEPLOYED_PREFIX)) return spec;
  const [namespace, name, ...rest] = spec.slice(DEPLOYED_PREFIX.length).split('/');
  if (!namespace || !name || rest.length > 0 || !K8S_NAME.test(namespace) || !K8S_NAME.test(name)) {
    throw new BaselineUnavailableError(
      `"${spec}" is not a deployed baseline: use deployed:<namespace>/<name>`,
    );
  }
  if (!deployed) {
    throw new BaselineUnavailableError(
      `reading the deployed contract of ${namespace}/${name} is not available yet. ` +
        'Compare against a directory or a git reference instead, for example ' +
        '--against ".git#branch=main,subdir=proto".',
    );
  }
  return deployed.resolve({ namespace, name });
}

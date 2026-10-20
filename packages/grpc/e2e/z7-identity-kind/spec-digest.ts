/**
 * Prints the spec digest (ADR-0004 Amendment 4) of the BackendService `spec` read
 * from stdin, using the CLI's own implementation (packages/grpc/src/spec-digest.ts).
 * The kind lane pins the digest of the spec it finds on the cluster with it, so
 * the lane also proves that the CLI's digest and the operator's agree on a real
 * apiserver object, not only on the shared vectors.
 *
 *   kubectl get backendservice fn -o json | jq -c .spec | bun spec-digest.ts
 */
import { backendSpecDigest } from '../../src/spec-digest';

const spec = JSON.parse(await Bun.stdin.text()) as Record<string, unknown>;
console.log(backendSpecDigest(spec));

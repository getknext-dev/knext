/**
 * The exec-plugin / cloud-credential kubeconfig refusal (#1533, ADR-0061).
 *
 * One classifier, reused by `init-ci --push-secret`, the action preflight and
 * `doctor --ci-kubeconfig`. Tested once here, structurally: a YAML kubeconfig
 * carrying an `exec:` or `auth-provider:` user entry must be refused with the
 * EXACT sentence #1533 specifies, and a plain bearer-token kubeconfig (the
 * shape `kn-next init-ci` mints) must be accepted.
 */
import { describe, expect, it } from "bun:test";
import {
    CLOUD_CREDENTIAL_REFUSAL,
    classifyKubeconfigSafety,
} from "../cli/ci/kubeconfig-safety";

const TOKEN_KUBECONFIG = `
apiVersion: v1
kind: Config
clusters:
  - name: my-cluster
    cluster:
      server: https://10.0.0.1:6443
      certificate-authority-data: ZmFrZS1jYQ==
users:
  - name: knext-deployer
    user:
      token: eyJhbGciOiJSUzI1NiIsImtpZCI6IkY3In0.faketoken.sig
contexts:
  - name: knext-deployer
    context:
      cluster: my-cluster
      user: knext-deployer
      namespace: acme
current-context: knext-deployer
`;

const EXEC_KUBECONFIG = `
apiVersion: v1
kind: Config
clusters:
  - name: my-cluster
    cluster:
      server: https://10.0.0.1:6443
users:
  - name: admin
    user:
      exec:
        apiVersion: client.authentication.k8s.io/v1beta1
        command: aws
        args: ["eks", "get-token", "--cluster-name", "prod"]
contexts:
  - name: admin
    context:
      cluster: my-cluster
      user: admin
current-context: admin
`;

const AUTH_PROVIDER_KUBECONFIG = `
apiVersion: v1
kind: Config
clusters:
  - name: my-cluster
    cluster:
      server: https://10.0.0.1:6443
users:
  - name: admin
    user:
      auth-provider:
        name: gcp
contexts: []
`;

describe("classifyKubeconfigSafety (#1533)", () => {
    it("accepts a plain bearer-token kubeconfig — the shape init-ci mints", () => {
        const v = classifyKubeconfigSafety(TOKEN_KUBECONFIG);
        expect(v.ok).toBe(true);
        expect(v.reason).toBeUndefined();
    });

    it("refuses an exec-plugin kubeconfig with the EXACT sentence", () => {
        const v = classifyKubeconfigSafety(EXEC_KUBECONFIG);
        expect(v.ok).toBe(false);
        expect(v.reason).toBe(CLOUD_CREDENTIAL_REFUSAL);
    });

    it("refuses an auth-provider kubeconfig with the EXACT sentence", () => {
        const v = classifyKubeconfigSafety(AUTH_PROVIDER_KUBECONFIG);
        expect(v.ok).toBe(false);
        expect(v.reason).toBe(CLOUD_CREDENTIAL_REFUSAL);
    });

    it("catches exec/auth-provider on a NON-current user entry, not just the active one", () => {
        // Several contexts, only one current; the dangerous user is unused
        // TODAY but one `kubectl config use-context` away from being live.
        const multi = `
apiVersion: v1
kind: Config
users:
  - name: knext-deployer
    user:
      token: abc
  - name: admin
    user:
      exec:
        command: gcloud
contexts: []
`;
        const v = classifyKubeconfigSafety(multi);
        expect(v.ok).toBe(false);
        expect(v.reason).toBe(CLOUD_CREDENTIAL_REFUSAL);
    });

    it("does not false-positive on the substring 'exec' in unrelated text", () => {
        // A cluster/context NAME containing "exec" must never trip a
        // text-matching implementation; this is why the classifier parses
        // YAML and inspects structure instead of grepping.
        const named = `
apiVersion: v1
kind: Config
clusters:
  - name: exec-prod-cluster
    cluster:
      server: https://10.0.0.1:6443
users:
  - name: knext-deployer
    user:
      token: abc
contexts:
  - name: exec-context
    context:
      cluster: exec-prod-cluster
      user: knext-deployer
current-context: exec-context
`;
        expect(classifyKubeconfigSafety(named).ok).toBe(true);
    });

    it("fails CLOSED on unparseable YAML — an unreadable kubeconfig is not evidence of safety", () => {
        const v = classifyKubeconfigSafety("{ this: is not [valid yaml");
        expect(v.ok).toBe(false);
        expect(v.reason).toBeTruthy();
    });

    it("accepts a kubeconfig with no users at all rather than throwing", () => {
        expect(
            classifyKubeconfigSafety("apiVersion: v1\nkind: Config\n").ok,
        ).toBe(true);
    });
});

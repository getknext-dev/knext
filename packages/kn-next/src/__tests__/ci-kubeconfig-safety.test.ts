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
import {
    LEAK_SENTINEL_PREFIX,
    MALFORMED_TOKEN_KUBECONFIGS,
} from "./helpers/malformed-kubeconfigs";

/** The ONLY shape a parse failure may take: fixed text + optional line number. */
const INVALID_YAML_REASON =
    /^could not parse this file as a kubeconfig \(invalid YAML(?: near line \d+)?\)\. Its contents are not shown\.$/;

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

/**
 * Round 2 (review of #1557). kubectl decodes kubeconfigs with go-yaml, which
 * RESOLVES YAML merge keys (`<<`). A classifier that parses without merge
 * support keeps `<<` as a literal key and never sees the `exec:` kubectl
 * will run — measured: `kubectl config view --raw` prints the exec block for
 * both forms below.
 */
const MERGE_HEAD = [
    "apiVersion: v1",
    "kind: Config",
    "clusters:",
    "- name: c",
    "  cluster: {server: https://1.2.3.4}",
    "contexts:",
    "- name: x",
    "  context: {cluster: c, user: u}",
    "current-context: x",
].join("\n");

describe("classifyKubeconfigSafety — YAML merge keys and depth (round 2)", () => {
    it("refuses exec injected through a `<<: *anchor` merge key", () => {
        const src =
            "x: &a\n  exec: {command: aws, apiVersion: client.authentication.k8s.io/v1, interactiveMode: Never}\n" +
            `${MERGE_HEAD}\nusers:\n- name: u\n  user:\n    <<: *a\n`;
        const v = classifyKubeconfigSafety(src);
        expect(v.ok).toBe(false);
        expect(v.reason).toBe(CLOUD_CREDENTIAL_REFUSAL);
    });

    it("refuses exec injected through an inline `<<: {exec: …}` merge key", () => {
        const src = `${MERGE_HEAD}\nusers:\n- name: u\n  user:\n    <<: {exec: {command: aws, apiVersion: client.authentication.k8s.io/v1, interactiveMode: Never}}\n`;
        const v = classifyKubeconfigSafety(src);
        expect(v.ok).toBe(false);
        expect(v.reason).toBe(CLOUD_CREDENTIAL_REFUSAL);
    });

    it("refuses auth-provider injected through a merge-key sequence `<<: [*a]`", () => {
        const src =
            "x: &a\n  auth-provider: {name: gcp}\n" +
            `${MERGE_HEAD}\nusers:\n- name: u\n  user:\n    <<: [*a]\n`;
        expect(classifyKubeconfigSafety(src).ok).toBe(false);
    });

    it("refuses the camelCase `authProvider` key too (client-go's Go field name)", () => {
        const src = `${MERGE_HEAD}\nusers:\n- name: u\n  user:\n    authProvider: {name: gcp}\n`;
        expect(classifyKubeconfigSafety(src).ok).toBe(false);
    });

    it("refuses an exec key nested at ANY depth under a user entry", () => {
        const src = `${MERGE_HEAD}\nusers:\n- name: u\n  user:\n    token: abc\n    extra:\n      deeper:\n        exec: {command: aws}\n`;
        expect(classifyKubeconfigSafety(src).ok).toBe(false);
    });

    it("terminates on a self-referencing alias cycle under a user entry", () => {
        const src = `${MERGE_HEAD}\nusers:\n- name: u\n  user: &loop\n    token: abc\n    self: *loop\n`;
        expect(classifyKubeconfigSafety(src).ok).toBe(true);
    });

    it("still accepts a merge key that brings in only a token", () => {
        const src =
            "x: &a\n  token: abc\n" +
            `${MERGE_HEAD}\nusers:\n- name: u\n  user:\n    <<: *a\n`;
        expect(classifyKubeconfigSafety(src).ok).toBe(true);
    });

    it("accepts a client-certificate kubeconfig — an x509 pair runs no cloud CLI", () => {
        const src = `${MERGE_HEAD}\nusers:\n- name: u\n  user:\n    client-certificate-data: Zm9v\n    client-key-data: YmFy\n`;
        expect(classifyKubeconfigSafety(src).ok).toBe(true);
    });
});

/**
 * Round 2: the `yaml` library's error message quotes the failing source line.
 * When the typo sits on or next to `token:`, that quote IS the credential. The
 * refusal must be a fixed sentence plus at most a line NUMBER — never source
 * text and never the parser's own message.
 */
describe("classifyKubeconfigSafety — a malformed kubeconfig never echoes its contents (round 2)", () => {
    for (const [name, src] of Object.entries(MALFORMED_TOKEN_KUBECONFIGS)) {
        it(`${name}: refused with the fixed sentence, no token bytes`, () => {
            const v = classifyKubeconfigSafety(src);
            expect(v.ok).toBe(false);
            expect(v.reason ?? "").not.toContain(LEAK_SENTINEL_PREFIX);
            expect(v.reason).toMatch(INVALID_YAML_REASON);
        });
    }

    it("gives the line NUMBER of the fault, so the user can still find it", () => {
        const v = classifyKubeconfigSafety(
            MALFORMED_TOKEN_KUBECONFIGS.tab ?? "",
        );
        expect(v.reason).toContain("near line 6");
    });
});

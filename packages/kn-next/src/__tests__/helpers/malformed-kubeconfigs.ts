/**
 * Malformed kubeconfigs whose syntax error sits ON or NEXT TO the `token:`
 * line (review of #1557, round 2). The `yaml` library's error message quotes
 * the failing source line, so any refusal that relays the parser's message
 * relays the token with it. Shared by every surface that reports a refusal:
 * the classifier, `init-ci --push-secret`, `doctor --ci-kubeconfig` (table and
 * JSON) and the action's kubeconfig step.
 */
export const LEAK_SENTINEL = "eyJSUPERSECRETTOKENVALUE0123456789";

/** A prefix of the sentinel — catches a PARTIAL quote of the token too. */
export const LEAK_SENTINEL_PREFIX = "eyJSUP";

export const MALFORMED_TOKEN_KUBECONFIGS: Readonly<Record<string, string>> = {
    bad_indent: `apiVersion: v1\nkind: Config\nusers:\n- name: u\n  user:\n    token: ${LEAK_SENTINEL}\n   client-key-data: x\n`,
    tab: `apiVersion: v1\nkind: Config\nusers:\n- name: u\n  user:\n\ttoken: ${LEAK_SENTINEL}\n`,
    unclosed_quote: `apiVersion: v1\nkind: Config\nusers:\n- name: u\n  user:\n    token: "${LEAK_SENTINEL}\n`,
    dup_key: `apiVersion: v1\nkind: Config\nusers:\n- name: u\n  user:\n    token: ${LEAK_SENTINEL}\n    token: ${LEAK_SENTINEL}\n`,
};

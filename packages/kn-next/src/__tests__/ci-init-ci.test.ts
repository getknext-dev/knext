/**
 * ADR-0049 — what `knext init-ci` generates (#874).
 *
 * The generated files are the entire client-facing surface of stage 1: a
 * workflow they will read, and an RBAC manifest they will `kubectl apply`
 * without necessarily understanding every line. So the properties asserted here
 * are the ones a reader would have to check by hand and mostly will not.
 *
 * Structural assertions go through a YAML parser rather than string matching.
 * A manifest that "contains the right text" and does not parse is still a
 * manifest nobody can apply, and grepping for `- delete` cannot tell a verb
 * from a comment.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, parseAllDocuments } from "yaml";
import { classifyCredentialScope } from "../cli/ci/credential-scope";
import {
    initCi,
    MINTED_KUBECONFIG_PATH,
    mintKubeconfigCommands,
    nextSteps,
    RBAC_PATH,
    REQUIRED_SECRETS,
    renderRbacManifest,
    renderWorkflow,
    skippedFileMessage,
    WORKFLOW_PATH,
} from "../cli/ci/init-ci";

const rbacDocs = (ns: string) =>
    parseAllDocuments(renderRbacManifest(ns)).map((d) => d.toJS());

describe("the generated RBAC manifest (#874)", () => {
    it("parses as three documents: ServiceAccount, Role, RoleBinding", () => {
        const kinds = rbacDocs("acme").map((d) => d.kind);
        expect(kinds).toEqual(["ServiceAccount", "Role", "RoleBinding"]);
    });

    it("is namespaced throughout — no cluster-scoped object anywhere", () => {
        // A ClusterRole here would silently widen the grant to every namespace,
        // and it is the single easiest mistake to make in an RBAC generator
        // because ClusterRole/Role differ by one word.
        for (const doc of rbacDocs("acme")) {
            expect(doc.kind).not.toMatch(/^Cluster/);
            expect(doc.metadata.namespace).toBe("acme");
        }
        expect(rbacDocs("acme")[2].roleRef.kind).toBe("Role");
    });

    it("grants nothing but nextapps, and never delete", () => {
        const role = rbacDocs("acme")[1];
        expect(role.rules).toHaveLength(1);
        expect(role.rules[0].apiGroups).toEqual(["apps.kn-next.dev"]);
        expect(role.rules[0].resources).toEqual(["nextapps"]);
        expect(role.rules[0].verbs).not.toContain("delete");
        expect(role.rules[0].verbs).not.toContain("*");
    });

    it("binds the Role to the ServiceAccount it also creates", () => {
        // A RoleBinding pointing at a subject that does not exist applies
        // cleanly and grants nothing, so the failure surfaces much later as an
        // unexplained 403 during a deploy.
        const [sa, , binding] = rbacDocs("acme");
        expect(binding.subjects).toHaveLength(1);
        expect(binding.subjects[0].name).toBe(sa.metadata.name);
        expect(binding.subjects[0].kind).toBe("ServiceAccount");
        expect(binding.roleRef.name).toBe(rbacDocs("acme")[1].metadata.name);
    });

    it("generates a credential its OWN preflight accepts", () => {
        // The end-to-end property. If the generator and the classifier drift,
        // every client hits a refusal on the credential knext told them to
        // create — and the natural fix, in a hurry, is to widen the Role.
        const role = rbacDocs("acme")[1];
        expect(classifyCredentialScope(role.rules).ok).toBe(true);
    });
});

describe("the generated workflow (#874)", () => {
    const wf = () => parse(renderWorkflow("."));

    it("parses, and runs one deploy job", () => {
        expect(Object.keys(wf().jobs)).toEqual(["deploy"]);
    });

    it("takes no write permission it does not need", () => {
        // `contents: write` on a deploy workflow would let a compromised step
        // push to the repository. The deploy credential is the kubeconfig
        // secret, not the GitHub token.
        expect(wf().permissions.contents).toBe("read");
        expect(wf().permissions["id-token"]).toBeUndefined();
    });

    it("serialises deploys per ref rather than cancelling them", () => {
        // Two concurrent applies of the same resource race, and the loser
        // silently wins on the next reconcile — so the cluster ends up running
        // whichever build finished second, not whichever commit is newer.
        // cancel-in-progress would abort a deploy mid-apply instead.
        const c = wf().concurrency;
        expect(c["cancel-in-progress"]).toBe(false);
        expect(c.group).toContain("github.ref");
    });

    it("documents every secret it asks for, and why", () => {
        // A user who cannot see why a permission is wanted cannot consent to
        // it. Scanned from the one list, so adding a secret without a reason
        // fails rather than shipping an undocumented ask.
        const text = renderWorkflow(".");
        for (const s of REQUIRED_SECRETS) {
            expect(text).toContain(s.name);
            expect(text).toContain(s.why);
        }
    });

    it("passes secrets by reference, never inlining a value", () => {
        const text = renderWorkflow(".");
        for (const s of REQUIRED_SECRETS) {
            if (s.name === "KNEXT_REGISTRY_TOKEN") continue; // has a fallback
            expect(text).toContain(`secrets.${s.name}`);
        }
    });
});

describe("initCi writes both files (#874)", () => {
    const tempRoots: string[] = [];
    afterAll(() => {
        for (const d of tempRoots) rmSync(d, { recursive: true, force: true });
    });
    const scratch = () => {
        const dir = mkdtempSync(join(tmpdir(), "knext-initci-"));
        tempRoots.push(dir);
        return dir;
    };

    it("writes the workflow and the RBAC manifest", () => {
        const root = scratch();
        const r = initCi(root, { namespace: "acme", appDir: "." });
        expect(r.written.sort()).toEqual([RBAC_PATH, WORKFLOW_PATH].sort());
        expect(existsSync(join(root, WORKFLOW_PATH))).toBe(true);
        expect(existsSync(join(root, RBAC_PATH))).toBe(true);
    });

    it("refuses to clobber an edited workflow, and says so", () => {
        // The client will have edited this file. A generator that overwrites it
        // to "help" is one you cannot safely re-run, which means nobody re-runs
        // it and the RBAC never gets regenerated either.
        const root = scratch();
        initCi(root, { namespace: "acme", appDir: "." });
        writeFileSync(join(root, WORKFLOW_PATH), "# edited by hand\n");
        const again = initCi(root, { namespace: "acme", appDir: "." });
        expect(again.skipped).toContain(WORKFLOW_PATH);
        expect(readFileSync(join(root, WORKFLOW_PATH), "utf8")).toBe(
            "# edited by hand\n",
        );
    });

    it("#1535: a second run's skipped files each get their own named, actionable message", () => {
        const root = scratch();
        initCi(root, { namespace: "acme", appDir: "." });
        const second = initCi(root, { namespace: "acme", appDir: "." });
        expect(second.skipped.sort()).toEqual(
            [WORKFLOW_PATH, RBAC_PATH].sort(),
        );
        for (const f of second.skipped) {
            expect(skippedFileMessage(f)).toContain(f);
            expect(skippedFileMessage(f)).toContain("--force");
        }
    });

    it("overwrites only when explicitly forced", () => {
        const root = scratch();
        initCi(root, { namespace: "acme", appDir: "." });
        writeFileSync(join(root, WORKFLOW_PATH), "# edited\n");
        const forced = initCi(root, {
            namespace: "acme",
            appDir: ".",
            force: true,
        });
        expect(forced.written).toContain(WORKFLOW_PATH);
        expect(readFileSync(join(root, WORKFLOW_PATH), "utf8")).toContain(
            "knext",
        );
    });

    it("carries the namespace into the manifest it writes, not just the args", () => {
        const root = scratch();
        initCi(root, { namespace: "prod-eu", appDir: "apps/web" });
        const docs = parseAllDocuments(
            readFileSync(join(root, RBAC_PATH), "utf8"),
        ).map((d) => d.toJS());
        expect(docs.every((d) => d.metadata.namespace === "prod-eu")).toBe(
            true,
        );
        expect(
            parse(readFileSync(join(root, WORKFLOW_PATH), "utf8")).jobs.deploy
                .steps[1].with["working-directory"],
        ).toBe("apps/web");
    });
});

describe("mintKubeconfigCommands — knext mints nothing itself (#1533, ADR-0061)", () => {
    it("carries the namespace and the ServiceAccount name, never a placeholder", () => {
        const cmds = mintKubeconfigCommands("prod-eu");
        const text = cmds.join("\n");
        expect(text).toContain("knext-deployer");
        expect(text).toContain("prod-eu");
        expect(text).toContain(MINTED_KUBECONFIG_PATH);
    });

    it("uses only kubectl — never a cloud CLI (ADR-0061 tripwire 2)", () => {
        const text = mintKubeconfigCommands("acme").join("\n");
        for (const cloudCli of ["aws ", "gcloud ", "az ", "oci ", "eksctl "]) {
            expect(text).not.toContain(cloudCli);
        }
    });

    it("mints a bound token via `kubectl create token`, not a stored Secret", () => {
        // A ServiceAccount TOKEN SECRET is long-lived and never expires; a
        // TokenRequest-minted token (`kubectl create token`) is bound and
        // time-limited — the safer default this command set uses.
        const text = mintKubeconfigCommands("acme").join("\n");
        expect(text).toContain("kubectl create token knext-deployer");
    });

    it("nextSteps embeds the actual mint commands, not a vague instruction", () => {
        const steps = nextSteps("acme");
        for (const cmd of mintKubeconfigCommands("acme")) {
            expect(steps).toContain(cmd);
        }
        // And documents the --push-secret shortcut.
        expect(steps).toContain("--push-secret");
    });
});

describe("mint recipe — round 2 of #1557", () => {
    /** The guard line, executed under bash exactly as printed. */
    function runCaGuard(caData: string) {
        const guard = mintKubeconfigCommands("acme").find((c) =>
            c.startsWith('[ -n "$CA_DATA" ]'),
        );
        expect(guard).toBeDefined();
        return spawnSync("bash", ["-c", guard ?? "exit 99"], {
            encoding: "utf8",
            env: { ...process.env, CA_DATA: caData },
        });
    }

    it("warns when the source kubeconfig has no embedded CA (a CA file, or TLS verification skipped)", () => {
        const r = runCaGuard("");
        expect(r.status).toBe(0);
        expect(r.stderr).toContain("warning:");
        expect(r.stderr).toContain("EMPTY certificate authority");
    });

    it("is silent when the CA is embedded", () => {
        const r = runCaGuard("ZmFrZS1jYQ==");
        expect(r.status).toBe(0);
        expect(r.stderr).toBe("");
    });

    it("the guard runs right after CA_DATA is read, before anything is written", () => {
        const cmds = mintKubeconfigCommands("acme");
        const read = cmds.findIndex((c) => c.startsWith("CA_DATA="));
        const guard = cmds.findIndex((c) => c.startsWith('[ -n "$CA_DATA" ]'));
        const write = cmds.findIndex((c) => c.includes("set-cluster"));
        expect(read).toBeGreaterThanOrEqual(0);
        expect(guard).toBe(read + 1);
        expect(guard).toBeLessThan(write);
    });

    it("nextSteps states the token's one-year lifetime and how to re-mint it", () => {
        const steps = nextSteps("acme");
        expect(steps).toContain("expires after one year");
        expect(steps).toContain("--duration=8760h");
        // Round 4 of #1557 (R3-B1): renewal is "re-run the whole recipe",
        // never just the TOKEN= and patch lines — that shape is what left
        // the OLD token in place while exiting 0.
        expect(steps).toMatch(/re-run the WHOLE recipe/);
        expect(steps).not.toMatch(
            /re-run the TOKEN= and KNEXT_KUBECONFIG_TEXT= lines/,
        );
    });
});

/**
 * Round 3 of #1557 (N4, round-1 N5): `kubectl config set-credentials
 * --token="$TOKEN"` puts the bearer token in that process's OWN argv, which
 * `ps`/`/proc/<pid>/cmdline` show to any other local user for the life of the
 * process — kubectl has no stdin/file form for `--token` (verified against
 * `kubectl config set-credentials --help`), unlike `--certificate-authority`
 * (which this recipe already feeds via `/dev/stdin`). The fix patches the
 * token into the file using only bash BUILTINS (`$(<file)`, `${VAR/…/…}`,
 * `printf`) — none of which fork+exec, so the token never becomes any
 * process's argument.
 */
describe("mint recipe — the token never reaches a child process's argv (round 3 of #1557, N4)", () => {
    it("no command in the recipe passes $TOKEN as a kubectl (or any) CLI argument", () => {
        for (const cmd of mintKubeconfigCommands("acme")) {
            // The token is only ever consumed as "$TOKEN" inside a bash
            // BUILTIN construct (a $'...' ANSI-C string, or a bare command
            // substitution) — never as `--token=`, `--flag $TOKEN`, or any
            // other shape that hands it to a forked/exec'd process's argv.
            if (!cmd.includes("$TOKEN")) continue;
            expect(cmd).not.toMatch(/--token[= ]/);
            // Every command that touches $TOKEN must be the patch line,
            // identified by its use of the bash-builtin parameter expansion.
            expect(cmd).toContain("${KNEXT_KUBECONFIG_TEXT/users: null/");
        }
    });

    it("no kubectl invocation in the recipe carries --token", () => {
        for (const cmd of mintKubeconfigCommands("acme")) {
            if (!cmd.startsWith("kubectl ")) continue;
            expect(cmd).not.toContain("--token");
        }
    });

    it("end to end: the patch line turns `users: null` into a real token entry", () => {
        // Hermetic — no real `kubectl` binary required (this suite fakes
        // kubectl everywhere else, `kubectl-seam.test.ts` even mocks the OS
        // boundary for it). The precursor content below is EXACTLY what the
        // three real `kubectl config set-cluster` / `set-context` /
        // `use-context` calls leave on disk before `set-credentials` ever
        // runs — verified once, out of band, against a real kubectl: it
        // always marshals a nil user slice as the trailing `users: null`.
        const dir = mkdtempSync(join(tmpdir(), "knext-mint-recipe-"));
        try {
            const out = join(dir, MINTED_KUBECONFIG_PATH);
            const token = "eyJhbGciOiJSUzI1NiJ9.fake-e2e-token.sig";
            writeFileSync(
                out,
                [
                    "apiVersion: v1",
                    "clusters:",
                    "- cluster:",
                    "    certificate-authority-data: ZmFrZQ==",
                    "    server: https://example.com",
                    "  name: knext-deployer",
                    "contexts:",
                    "- context:",
                    "    cluster: knext-deployer",
                    "    namespace: acme",
                    "    user: knext-deployer",
                    "  name: knext-deployer",
                    "current-context: knext-deployer",
                    "kind: Config",
                    "preferences: {}",
                    "users: null",
                    "",
                ].join("\n"),
            );
            const patchLine = mintKubeconfigCommands("acme")
                .at(-1)
                ?.replaceAll(MINTED_KUBECONFIG_PATH, out);
            expect(patchLine).toBeDefined();
            const r = spawnSync(
                "bash",
                ["-c", `set -euo pipefail\n${patchLine}`],
                {
                    encoding: "utf8",
                    env: { ...process.env, TOKEN: token },
                },
            );
            expect(r.status, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).toBe(
                0,
            );
            const parsed = parse(readFileSync(out, "utf8")) as {
                users: Array<{ name: string; user: { token: string } }>;
                clusters: unknown;
                "current-context": string;
            };
            expect(parsed.users).toEqual([
                { name: "knext-deployer", user: { token } },
            ]);
            // Untouched by the patch: it only replaces `users: null`.
            expect(parsed["current-context"]).toBe("knext-deployer");
            expect(parsed.clusters).toBeDefined();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

/**
 * Round 4 of #1557 (R3-B1): round 3's patch line only wrote a token when the
 * file still had `users: null` — true for a fresh mint, but NOT for renewal,
 * which runs on a file that already has a `users:` entry. The substitution
 * matched nothing, exited 0, and left the OLD token in place while the user
 * believed they had rotated it. The fix is two halves: the patch line now
 * fails CLOSED when the anchor is missing, and the recipe deletes its own
 * output file first so re-running the WHOLE thing (the documented renewal
 * path) always starts from a fresh anchor.
 */
describe("mint recipe — renewal fails closed instead of keeping the old token (round 4 of #1557, R3-B1)", () => {
    it("the recipe's first command removes its own output file (so a full re-run cannot inherit a stale users: entry)", () => {
        const cmds = mintKubeconfigCommands("acme");
        expect(cmds[0]).toBe(`rm -f -- "${MINTED_KUBECONFIG_PATH}"`);
    });

    it("applying the patch line to a file that already has a users: entry fails non-zero, and leaves the old token untouched", () => {
        const dir = mkdtempSync(join(tmpdir(), "knext-mint-renewal-"));
        try {
            const out = join(dir, MINTED_KUBECONFIG_PATH);
            const oldToken =
                "eyJhbGciOiJSUzI1NiJ9.OLD_TOKEN_BEFORE_RENEWAL.sig";
            const precursor = [
                "apiVersion: v1",
                "clusters:",
                "- cluster:",
                "    certificate-authority-data: ZmFrZQ==",
                "    server: https://example.com",
                "  name: knext-deployer",
                "contexts:",
                "- context:",
                "    cluster: knext-deployer",
                "    namespace: acme",
                "    user: knext-deployer",
                "  name: knext-deployer",
                "current-context: knext-deployer",
                "kind: Config",
                "preferences: {}",
                "users:",
                "- name: knext-deployer",
                "  user:",
                `    token: ${oldToken}`,
                "",
            ].join("\n");
            writeFileSync(out, precursor);
            const patchLine = mintKubeconfigCommands("acme")
                .at(-1)
                ?.replaceAll(MINTED_KUBECONFIG_PATH, out);
            expect(patchLine).toBeDefined();
            const newToken = "eyJhbGciOiJSUzI1NiJ9.NEW_TOKEN_AFTER_RENEWAL.sig";
            const r = spawnSync("bash", ["-c", `${patchLine}`], {
                encoding: "utf8",
                env: { ...process.env, TOKEN: newToken },
            });
            // Never exits 0 with the old token still in place — that is the
            // exact defect: silently "succeeding" while renewing nothing.
            expect(r.status).not.toBe(0);
            expect(r.stderr).toContain("users: entry");
            const after = readFileSync(out, "utf8");
            expect(after).toContain(oldToken);
            expect(after).not.toContain(newToken);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    /**
     * A hermetic fake `kubectl` implementing only the four subcommands this
     * recipe calls — no real cluster, no real binary. `set-cluster` is the
     * one call that actually writes the (relative) `--kubeconfig=` path, the
     * same way the real three `kubectl config` calls leave `users: null` on
     * disk before the patch line ever runs; `set-context`/`use-context` are
     * no-ops, and `create token` prints a token fixed per invocation so the
     * "renewed" run can be told apart from the "first mint" run.
     */
    function writeFakeKubectl(binDir: string) {
        const kubectl = join(binDir, "kubectl");
        writeFileSync(
            kubectl,
            [
                "#!/usr/bin/env bash",
                "set -euo pipefail",
                'if [ "$1" = "config" ] && [ "$2" = "view" ]; then',
                '  case "$*" in',
                '    *server*) echo "https://example.invalid" ;;',
                '    *) echo "ZmFrZS1jYQ==" ;;',
                "  esac",
                "  exit 0",
                "fi",
                'if [ "$1" = "config" ] && [ "$2" = "set-cluster" ]; then',
                '  out=""',
                '  for a in "$@"; do',
                '    case "$a" in',
                '      --kubeconfig=*) out="${a#--kubeconfig=}" ;;',
                "    esac",
                "  done",
                "  cat > \"$out\" <<'YAML'",
                "apiVersion: v1",
                "clusters:",
                "- cluster:",
                "    certificate-authority-data: ZmFrZQ==",
                "    server: https://example.invalid",
                "  name: knext-deployer",
                "contexts:",
                "- context:",
                "    cluster: knext-deployer",
                "    namespace: acme",
                "    user: knext-deployer",
                "  name: knext-deployer",
                "current-context: knext-deployer",
                "kind: Config",
                "preferences: {}",
                "users: null",
                "YAML",
                "  exit 0",
                "fi",
                'if [ "$1" = "config" ] && { [ "$2" = "set-context" ] || [ "$2" = "use-context" ]; }; then',
                "  exit 0",
                "fi",
                'if [ "$1" = "create" ] && [ "$2" = "token" ]; then',
                '  echo "$FAKE_KUBECTL_NEW_TOKEN"',
                "  exit 0",
                "fi",
                'echo "fake-kubectl: unhandled invocation: $*" >&2',
                "exit 1",
                "",
            ].join("\n"),
        );
        chmodSync(kubectl, 0o755);
    }

    it("re-running the WHOLE recipe over an existing file ends with the new token and no trace of the old one", () => {
        const dir = mkdtempSync(join(tmpdir(), "knext-mint-full-rerun-"));
        try {
            const binDir = join(dir, "bin");
            const oldToken = "eyJhbGciOiJSUzI1NiJ9.TOKEN_BEFORE_RENEWAL.sig";
            const newToken = "eyJhbGciOiJSUzI1NiJ9.TOKEN_AFTER_RENEWAL.sig";
            writeFileSync(
                join(dir, MINTED_KUBECONFIG_PATH),
                [
                    "apiVersion: v1",
                    "clusters:",
                    "- cluster:",
                    "    certificate-authority-data: ZmFrZQ==",
                    "    server: https://example.invalid",
                    "  name: knext-deployer",
                    "contexts:",
                    "- context:",
                    "    cluster: knext-deployer",
                    "    namespace: acme",
                    "    user: knext-deployer",
                    "  name: knext-deployer",
                    "current-context: knext-deployer",
                    "kind: Config",
                    "preferences: {}",
                    "users:",
                    "- name: knext-deployer",
                    "  user:",
                    `    token: ${oldToken}`,
                    "",
                ].join("\n"),
            );
            mkdirSync(binDir, { recursive: true });
            writeFakeKubectl(binDir);
            const recipe = mintKubeconfigCommands("acme").join("\n");
            const r = spawnSync(
                "bash",
                ["-c", `set -euo pipefail\n${recipe}`],
                {
                    encoding: "utf8",
                    cwd: dir,
                    env: {
                        ...process.env,
                        PATH: `${binDir}:${process.env.PATH}`,
                        FAKE_KUBECTL_NEW_TOKEN: newToken,
                    },
                },
            );
            expect(r.status, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).toBe(
                0,
            );
            const after = readFileSync(
                join(dir, MINTED_KUBECONFIG_PATH),
                "utf8",
            );
            expect(after).toContain(newToken);
            expect(after).not.toContain(oldToken);
            const parsed = parse(after) as {
                users: Array<{ name: string; user: { token: string } }>;
            };
            expect(parsed.users).toEqual([
                { name: "knext-deployer", user: { token: newToken } },
            ]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("skippedFileMessage (#1535)", () => {
    it("names the file and points at --force — one actionable sentence", () => {
        expect(skippedFileMessage(WORKFLOW_PATH)).toBe(
            `${WORKFLOW_PATH} already exists — left alone (use --force to overwrite)`,
        );
    });
});

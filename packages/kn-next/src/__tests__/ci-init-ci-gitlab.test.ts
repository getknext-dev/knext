/**
 * `knext init-ci --provider gitlab` (#1534) — the GitLab CI/CD counterpart of
 * `ci-init-ci.test.ts` (the GitHub template). Two layers, matching the C3
 * (#1557) precedent for the GitHub Action's own preflight tests:
 *
 *   1. STRUCTURAL — the rendered `.gitlab-ci.yml` parses, and the two
 *      preflight jobs exist, are correctly ordered (`needs`), and are not
 *      skippable (no `allow_failure: true`).
 *   2. HERMETIC EXECUTION — the generated `script:` lines for each preflight
 *      job, run under bash with `$KNEXT_CLI` pointed at this checkout's own
 *      CLI (bun running the TS source directly — no built dist, no network,
 *      no real kubectl) and a fake kubectl on PATH: an exec-plugin kubeconfig
 *      refuses before any kubectl call, and a credential broader than the
 *      published Role refuses via the SАME hazard spot-check
 *      `kn-next-action-preflight-hazard-and-kubeconfig.test.ts` exercises.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { CI_ROLE_RULES } from "../cli/ci/credential-scope";
import { GITLAB_CI_PATH, renderGitlabPipeline } from "../cli/ci/init-ci-gitlab";

// Each credential-preflight run submits ~40 access reviews, one fake-kubectl
// process each (same shape as kn-next-action-preflight-hazard-and-kubeconfig.
// test.ts, which needs the same bump).
setDefaultTimeout(30_000);

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEPLOY_TS = join(PKG_ROOT, "src", "cli", "deploy.ts");

interface GitlabJob {
    stage: string;
    image?: string;
    needs?: string[];
    allow_failure?: boolean;
    rules?: unknown;
    script?: unknown;
}

function pipeline(): {
    stages: string[];
    jobs: Record<string, GitlabJob>;
} {
    const doc = parse(renderGitlabPipeline(".")) as Record<string, unknown>;
    const { stages, ...rest } = doc as { stages: string[] };
    const jobs: Record<string, GitlabJob> = {};
    for (const [k, v] of Object.entries(rest)) {
        // Hidden jobs (YAML anchors declared as `.name:`) are templates, not
        // real jobs — GitLab itself never schedules them.
        if (k.startsWith(".")) continue;
        jobs[k] = v as GitlabJob;
    }
    return { stages, jobs };
}

describe("the generated GitLab pipeline — structure (#1534)", () => {
    it("parses as YAML with a preflight stage before deploy", () => {
        const { stages } = pipeline();
        expect(stages.indexOf("preflight")).toBeGreaterThanOrEqual(0);
        expect(stages.indexOf("deploy")).toBeGreaterThan(
            stages.indexOf("preflight"),
        );
    });

    it("has both preflight jobs, in the preflight stage", () => {
        const { jobs } = pipeline();
        expect(jobs["kubeconfig-check"]?.stage).toBe("preflight");
        expect(jobs["credential-preflight"]?.stage).toBe("preflight");
    });

    it("credential-preflight depends on kubeconfig-check (exec refusal before any kubectl call)", () => {
        const { jobs } = pipeline();
        expect(jobs["credential-preflight"]?.needs).toContain(
            "kubeconfig-check",
        );
    });

    it("deploy depends on BOTH preflight jobs", () => {
        const { jobs } = pipeline();
        expect(jobs.deploy?.needs).toContain("kubeconfig-check");
        expect(jobs.deploy?.needs).toContain("credential-preflight");
    });

    it("deploy is in its own stage, after preflight", () => {
        const { jobs } = pipeline();
        expect(jobs.deploy?.stage).toBe("deploy");
    });

    it("neither preflight job sets allow_failure: true — not skippable", () => {
        const { jobs } = pipeline();
        for (const name of ["kubeconfig-check", "credential-preflight"]) {
            expect(jobs[name]?.allow_failure).not.toBe(true);
        }
    });

    it("documents every required secret/variable, and why", () => {
        const text = renderGitlabPipeline(".");
        expect(text).toContain("KNEXT_KUBECONFIG");
        expect(text).toContain("KNEXT_NAMESPACE");
        expect(text).toContain("KNEXT_REGISTRY");
        expect(text).toContain("Masked");
        expect(text).toContain("Protected");
    });

    it("carries the app directory into the deploy job, not just the args", () => {
        const doc = parse(renderGitlabPipeline("apps/web")) as {
            deploy: { script: string[] };
        };
        expect(doc.deploy.script.join("\n")).toContain("cd apps/web");
    });
});

/** Recursively flatten a GitLab `script:` array — a YAML alias to another
 * sequence (the `*knext_kubeconfig`/`*knext_kubectl_install` anchors) parses
 * as a NESTED array, which GitLab itself flattens at pipeline-processing
 * time. Mirrored here so the extracted script runs the same steps GitLab
 * would actually execute. */
function flattenScript(script: unknown): string[] {
    if (!Array.isArray(script)) return [];
    return script.flatMap((line) =>
        Array.isArray(line) ? flattenScript(line) : [String(line)],
    );
}

const made: string[] = [];
function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    made.push(dir);
    return dir;
}
afterEach(() => {
    for (const dir of made.splice(0))
        rmSync(dir, { recursive: true, force: true });
});

const EXEC_KUBECONFIG = [
    "apiVersion: v1",
    "kind: Config",
    "users:",
    "  - name: admin",
    "    user:",
    "      exec:",
    "        command: aws",
    "contexts: []",
    "",
].join("\n");

const TOKEN_KUBECONFIG = [
    "apiVersion: v1",
    "kind: Config",
    "clusters:",
    "- cluster:",
    "    server: https://example.invalid",
    "  name: knext-deployer",
    "contexts:",
    "- context:",
    "    cluster: knext-deployer",
    "    namespace: acme",
    "    user: knext-deployer",
    "  name: knext-deployer",
    "current-context: knext-deployer",
    "users:",
    "  - name: knext-deployer",
    "    user:",
    "      token: abc",
    "",
].join("\n");

/** Run a job's flattened `script:` under bash, with `$KNEXT_CLI` pointed at
 * THIS checkout's own CLI (bun running the TS source — no dist build, no
 * network). `$CI_PROJECT_DIR` stands in for the GitLab-provided workspace. */
function runJobScript(
    job: GitlabJob | undefined,
    projectDir: string,
    env: Record<string, string>,
) {
    const lines = flattenScript(job?.script);
    expect(lines.length).toBeGreaterThan(0);
    const script = lines.join("\n");
    return spawnSync("bash", ["-c", `set -euo pipefail\n${script}`], {
        cwd: projectDir,
        encoding: "utf8",
        env: {
            ...process.env,
            CI_PROJECT_DIR: projectDir,
            // bun (this test runner) executes a .ts file directly — no build
            // step, no network, the real dispatcher and the real rule modules.
            KNEXT_CLI: `${process.execPath} ${DEPLOY_TS}`,
            ...env,
        },
    });
}

describe("the generated pipeline's preflight jobs, executed hermetically (#1534)", () => {
    const { jobs } = pipeline();

    it("kubeconfig-check refuses an exec-plugin kubeconfig with the exact ADR-0061 sentence, before any kubectl call", () => {
        const dir = tempDir("knext-gitlab-kc-");
        const encoded = Buffer.from(EXEC_KUBECONFIG, "utf8").toString("base64");
        const r = runJobScript(jobs["kubeconfig-check"], dir, {
            KNEXT_KUBECONFIG: encoded,
        });
        expect(r.status).not.toBe(0);
        // `doctor`'s table prints to stdout (a human-readable row, not a
        // logger error stream) — asserted on whichever stream actually
        // carries it, scanned rather than assumed.
        expect(`${r.stdout}${r.stderr}`).toContain(
            "This kubeconfig needs cloud-account credentials on the runner.",
        );
    });

    it("kubeconfig-check passes a plain bearer-token kubeconfig", () => {
        const dir = tempDir("knext-gitlab-kc-ok-");
        const encoded = Buffer.from(TOKEN_KUBECONFIG, "utf8").toString(
            "base64",
        );
        const r = runJobScript(jobs["kubeconfig-check"], dir, {
            KNEXT_KUBECONFIG: encoded,
        });
        expect(r.status, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).toBe(0);
    });
});

/** A fake kubectl answering like a webhook-authorized cluster — same shape as
 * `kn-next-action-preflight-hazard-and-kubeconfig.test.ts`'s fixture: the
 * rules review is `incomplete`/empty, and access reviews answer per GRANTS. */
const FAKE_KUBECTL_JS = `
import { readFileSync } from 'node:fs';
const body = JSON.parse(readFileSync(0, 'utf8'));
if (body.kind === 'SelfSubjectRulesReview') {
  process.stdout.write(JSON.stringify({ status: { incomplete: true, resourceRules: [] } }));
  process.exit(0);
}
const a = body.spec.resourceAttributes;
const res = a.subresource ? a.resource + '/' + a.subresource : a.resource;
const m = (g, v) => g === '*' || g === v;
const allowed = (process.env.GRANTS || '').split(',').filter(Boolean).some((s) => {
  const [g, r, v, ns] = s.split('|');
  return m(g, a.group) && m(r, res) && m(v, a.verb) && (ns === '*' || (a.namespace !== undefined && a.namespace === ns));
});
process.stdout.write(JSON.stringify({ status: { allowed } }));
`;

function fakeKubectlBin(): string {
    const dir = tempDir("knext-gitlab-fake-kubectl-");
    writeFileSync(join(dir, "fake-kubectl.mjs"), FAKE_KUBECTL_JS);
    const bin = join(dir, "kubectl");
    writeFileSync(
        bin,
        `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(dir, "fake-kubectl.mjs"))} "$@"\n`,
    );
    chmodSync(bin, 0o755);
    return dir;
}

const NS = "acme";
const ROLE_GRANTS = CI_ROLE_RULES[0].verbs
    .map((v) => `apps.kn-next.dev|nextapps|${v}|${NS}`)
    .join(",");

describe("credential-preflight, executed hermetically against a fake kubectl (#1534)", () => {
    const { jobs } = pipeline();

    it("passes a credential granted exactly the published Role", () => {
        const dir = tempDir("knext-gitlab-cp-ok-");
        writeFileSync(join(dir, "kubeconfig-plain"), TOKEN_KUBECONFIG);
        const encoded = Buffer.from(TOKEN_KUBECONFIG, "utf8").toString(
            "base64",
        );
        const bin = fakeKubectlBin();
        const r = runJobScript(jobs["credential-preflight"], dir, {
            KNEXT_KUBECONFIG: encoded,
            KNEXT_NAMESPACE: NS,
            GRANTS: ROLE_GRANTS,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
        });
        expect(r.status, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).toBe(0);
        expect(r.stdout).toContain("correctly scoped");
    });

    it("refuses a credential granted more than the published Role (e.g. reading secrets)", () => {
        const dir = tempDir("knext-gitlab-cp-bad-");
        const encoded = Buffer.from(TOKEN_KUBECONFIG, "utf8").toString(
            "base64",
        );
        const bin = fakeKubectlBin();
        const r = runJobScript(jobs["credential-preflight"], dir, {
            KNEXT_KUBECONFIG: encoded,
            KNEXT_NAMESPACE: NS,
            GRANTS: `${ROLE_GRANTS},|secrets|get|${NS}`,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
        });
        expect(r.status).not.toBe(0);
        expect(r.stderr).toContain("far outside what knext needs");
    });
});

it("GITLAB_CI_PATH is .gitlab-ci.yml — the file GitLab actually reads", () => {
    expect(GITLAB_CI_PATH).toBe(".gitlab-ci.yml");
});

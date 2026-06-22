/**
 * loadtest-job.ts — k6 load-test generators (#30, salvaged from PR #10).
 *
 * Pure functions: a k6 JS script + a Kubernetes ConfigMap/Job manifest pair that
 * runs the script in-cluster against a Knative ksvc URL. Retargeted from the old
 * vinext admin app to the Knative serving URL.
 *
 * The load test is a MANUAL/NIGHTLY runbook (`scripts/load-test.sh`,
 * `apps/file-manager/docs/loadtest-runbook.md`) — NOT a PR gate. Only the
 * generator output shape is unit-tested. The `scale-to-zero` scenario ties to
 * the cold-start bench (`coldstart-bench-kind.md`).
 *
 * No bun/shell imports here so it stays vitest-testable.
 */

export type LoadTestType = "smoke" | "load" | "spike" | "scale-to-zero";

/**
 * generateK6Script returns a runnable k6 script targeting `targetUrl`.
 * `type` selects the executor/stage profile.
 */
export function generateK6Script(
    targetUrl: string,
    type: LoadTestType,
): string {
    let options = "";

    switch (type) {
        case "smoke":
            options = `{
    vus: 1,
    duration: '1m',
}`;
            break;
        case "load":
            options = `{
    stages: [
        { duration: '30s', target: 50 },
        { duration: '2m', target: 50 },
        { duration: '30s', target: 0 },
    ],
}`;
            break;
        case "spike":
            options = `{
    stages: [
        { duration: '10s', target: 10 },
        { duration: '1m', target: 200 },
        { duration: '10s', target: 10 },
    ],
}`;
            break;
        case "scale-to-zero":
            // Wake the ksvc with a burst, wait past Knative's scale-to-zero
            // window, then hit it again to exercise a cold start.
            options = `{
    scenarios: {
        cold_start: {
            executor: 'shared-iterations',
            vus: 10,
            iterations: 100,
            maxDuration: '30s',
        },
        after_scale_down: {
            executor: 'shared-iterations',
            vus: 10,
            iterations: 100,
            maxDuration: '30s',
            startTime: '5m', // wait for scale-to-zero before the second burst
        },
    },
}`;
            break;
    }

    return `import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = ${options};

export default function () {
    const res = http.get('${targetUrl}');
    check(res, {
        'status was 200': (r) => r.status === 200,
        'transaction time OK': (r) => r.timings.duration < 200,
    });
    sleep(1);
}
`;
}

/**
 * generateLoadTestManifests returns `[configMap, job]` YAML strings:
 *   - a ConfigMap holding the k6 script as a block scalar (`test.js: |`)
 *   - a Job that runs `grafana/k6` against the mounted script.
 *
 * When `prometheusUrl` is set, the Job exports results via k6's
 * experimental Prometheus remote-write output.
 */
export function generateLoadTestManifests(
    appName: string,
    namespace: string,
    targetUrl: string,
    type: LoadTestType,
    prometheusUrl?: string,
): [string, string] {
    const scriptContent = generateK6Script(targetUrl, type);
    const runId = Date.now().toString();
    const jobName = `k6-${appName}-${type}-${runId}`;

    // Indent every script line by 4 spaces so it nests under `test.js: |`.
    // (The salvage branch used a literal "\\n" here, producing a broken,
    // single-line ConfigMap — fixed to split on a real newline.)
    const indentedScript = scriptContent
        .split("\n")
        .map((line) => (line.length ? `    ${line}` : ""))
        .join("\n");

    const configMapManifest = `apiVersion: v1
kind: ConfigMap
metadata:
  name: k6-script-${jobName}
  namespace: ${namespace}
data:
  test.js: |
${indentedScript}
`;

    // k6 Prometheus remote-write env (experimental output). Only wired when a
    // Prometheus URL is provided — otherwise k6 writes results to stdout only.
    const promEnv = prometheusUrl
        ? `
        - name: K6_PROMETHEUS_RW_SERVER_URL
          value: "${prometheusUrl}/api/v1/write"`
        : "";
    const k6Args = prometheusUrl
        ? `["run", "--out", "experimental-prometheus-rw", "/scripts/test.js"]`
        : `["run", "/scripts/test.js"]`;

    const jobManifest = `apiVersion: batch/v1
kind: Job
metadata:
  name: ${jobName}
  namespace: ${namespace}
  labels:
    app: k6-loadtest
    target: ${appName}
spec:
  ttlSecondsAfterFinished: 3600
  template:
    metadata:
      labels:
        app: k6-loadtest
        target: ${appName}
    spec:
      restartPolicy: Never
      containers:
        - name: k6
          image: grafana/k6:0.49.0
          args: ${k6Args}
          volumeMounts:
            - name: k6-script
              mountPath: /scripts
          env:${promEnv || " []"}
      volumes:
        - name: k6-script
          configMap:
            name: k6-script-${jobName}
`;

    return [configMapManifest, jobManifest];
}

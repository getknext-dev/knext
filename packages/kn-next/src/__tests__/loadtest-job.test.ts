import { describe, expect, it } from "vitest";
import {
    generateK6Script,
    generateLoadTestManifests,
} from "../generators/loadtest-job";

/**
 * #30 — k6 load-test harness (salvaged from PR #10, retargeted to the Knative
 * ksvc URL). Pure generators: a k6 script + a ConfigMap/Job manifest pair. The
 * load test itself is a manual/nightly runbook, NOT a PR gate — these tests gate
 * only the generator output shape.
 */

const URL = "http://app.default.example.com";

describe("generateK6Script", () => {
    it("emits a runnable k6 script targeting the given URL", () => {
        const script = generateK6Script(URL, "smoke");
        expect(script).toContain("import http from 'k6/http'");
        expect(script).toContain(`http.get('${URL}')`);
        expect(script).toContain("export const options");
        expect(script).toContain("export default function");
    });

    it("smoke scenario uses a single VU", () => {
        const script = generateK6Script(URL, "smoke");
        expect(script).toContain("vus: 1");
    });

    it("load scenario ramps via stages", () => {
        const script = generateK6Script(URL, "load");
        expect(script).toContain("stages:");
        expect(script).toContain("target: 50");
    });

    it("spike scenario bursts to a high target", () => {
        const script = generateK6Script(URL, "spike");
        expect(script).toContain("target: 200");
    });

    it("scale-to-zero scenario has a cold-start and an after-scale-down burst", () => {
        const script = generateK6Script(URL, "scale-to-zero");
        expect(script).toContain("cold_start");
        expect(script).toContain("after_scale_down");
        // The second burst must start AFTER Knative's scale-to-zero window.
        expect(script).toContain("startTime: '5m'");
    });
});

describe("generateLoadTestManifests", () => {
    it("returns a ConfigMap and a Job manifest", () => {
        const [configMap, job] = generateLoadTestManifests(
            "app",
            "default",
            URL,
            "smoke",
        );
        expect(configMap).toContain("kind: ConfigMap");
        expect(job).toContain("kind: Job");
        expect(job).toContain("image: grafana/k6");
    });

    it("embeds the k6 script in the ConfigMap with correct YAML indentation (no literal \\n)", () => {
        const [configMap] = generateLoadTestManifests(
            "app",
            "default",
            URL,
            "smoke",
        );
        // The salvage branch had a `.split("\\n")` bug that left a literal
        // backslash-n in the manifest. Assert the script is real multi-line YAML.
        expect(configMap).not.toContain("\\n");
        expect(configMap).toContain("test.js: |");
        // Each script line is indented under the `test.js: |` block scalar.
        expect(configMap).toContain("    import http from 'k6/http'");
    });

    it("namespaces both manifests to the target namespace", () => {
        const [configMap, job] = generateLoadTestManifests(
            "app",
            "team-a",
            URL,
            "load",
        );
        expect(configMap).toContain("namespace: team-a");
        expect(job).toContain("namespace: team-a");
    });

    it("labels the Job with the target app for discovery", () => {
        const [, job] = generateLoadTestManifests(
            "myapp",
            "default",
            URL,
            "load",
        );
        expect(job).toContain("target: myapp");
    });

    it("does NOT wire Prometheus remote-write env when no URL is given", () => {
        const [, job] = generateLoadTestManifests(
            "app",
            "default",
            URL,
            "smoke",
        );
        expect(job).not.toContain("K6_PROMETHEUS_RW_SERVER_URL");
    });

    it("wires Prometheus remote-write env when a URL is given", () => {
        const [, job] = generateLoadTestManifests(
            "app",
            "default",
            URL,
            "smoke",
            "http://prometheus.monitoring:9090",
        );
        expect(job).toContain("K6_PROMETHEUS_RW_SERVER_URL");
        expect(job).toContain("http://prometheus.monitoring:9090/api/v1/write");
    });
});

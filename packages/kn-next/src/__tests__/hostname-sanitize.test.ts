/**
 * HOSTNAME sanitization for the spawned standalone server (#178).
 *
 * next@16.2.x standalone: the router's initUrl uses the configured HOSTNAME
 * verbatim (server/lib/router-utils/resolve-routes.js) while the
 * middleware-visible request URL is normalized by NextURL (loopback IPs →
 * 'localhost', server/web/next-url.js). Any HOSTNAME whose string differs
 * from the middleware-visible origin makes getRelativeURL classify a
 * same-origin middleware rewrite as EXTERNAL → the server proxies the
 * rewrite back to itself (extra hop, loop risk, ECONNREFUSED/500 when the
 * loopback stack disagrees). Verified matrix (fixture repro, PR #177 + #178):
 *   - HOSTNAME=127.0.0.1        → origin mismatch → self-proxy (the #174 500s)
 *   - HOSTNAME=<pod-name>       → binds ONLY the pod IP → Knative queue-proxy
 *                                 (127.0.0.1:USER_PORT) gets ECONNREFUSED
 *   - HOSTNAME=<unresolvable>   → crash on boot (getaddrinfo ENOTFOUND)
 *   - HOSTNAME="" / unset / 0.0.0.0 → benign (0.0.0.0 bind, consistent origin)
 *
 * kubelet sets HOSTNAME=<pod-name> and Docker sets HOSTNAME=<container-id>,
 * so the child env MUST be sanitized regardless of what the parent got.
 * The original value is preserved as KNEXT_POD_NAME for observability
 * (otel host.name) — sanitizing must not silently drop the pod identity.
 */

import { hostname as kernelHostname } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildChildEnv } from "../adapters/env";
import { resolveOtelOptions } from "../adapters/otel-config";

const SAVED: Record<string, string | undefined> = {};
const KEYS = [
    "HOSTNAME",
    "KNEXT_POD_NAME",
    "PORT",
    "KUBERNETES_SERVICE_HOST",
] as const;

beforeEach(() => {
    for (const k of KEYS) {
        SAVED[k] = process.env[k];
        delete process.env[k];
    }
});

afterEach(() => {
    for (const k of KEYS) {
        if (SAVED[k] === undefined) delete process.env[k];
        else process.env[k] = SAVED[k];
    }
});

describe("buildChildEnv: HOSTNAME sanitized for the standalone child (#178)", () => {
    it("kubelet pod-name HOSTNAME is emptied (child falls through to 0.0.0.0 bind)", () => {
        process.env.HOSTNAME = "myapp-00001-deployment-7f9c-xk2lp";
        const env = buildChildEnv();
        // Explicitly EMPTY, not merely deleted: spawn env is built fresh here,
        // but "" documents intent and survives naive `{ ...env }` copies.
        expect(env.HOSTNAME).toBe("");
    });

    it("operator-injected HOSTNAME=0.0.0.0 is emptied (equivalent bind, consistent origin)", () => {
        process.env.HOSTNAME = "0.0.0.0";
        expect(buildChildEnv().HOSTNAME).toBe("");
    });

    it("loopback HOSTNAME=127.0.0.1 is emptied (the #174 self-proxy trigger)", () => {
        process.env.HOSTNAME = "127.0.0.1";
        expect(buildChildEnv().HOSTNAME).toBe("");
    });

    it("unset HOSTNAME still yields an explicit empty value", () => {
        expect(buildChildEnv().HOSTNAME).toBe("");
    });

    it("preserves the pod identity as KNEXT_POD_NAME for observability", () => {
        process.env.HOSTNAME = "myapp-00001-deployment-7f9c-xk2lp";
        expect(buildChildEnv().KNEXT_POD_NAME).toBe(
            "myapp-00001-deployment-7f9c-xk2lp",
        );
    });

    it("does NOT stash meaningless bind addresses (0.0.0.0 / empty) as pod identity", () => {
        process.env.HOSTNAME = "0.0.0.0";
        expect(buildChildEnv().KNEXT_POD_NAME).toBeUndefined();
        process.env.HOSTNAME = "";
        expect(buildChildEnv().KNEXT_POD_NAME).toBeUndefined();
        delete process.env.HOSTNAME;
        expect(buildChildEnv().KNEXT_POD_NAME).toBeUndefined();
    });

    // #184 review nit: the skip-list was only 0.0.0.0/falsy — loopback values
    // got stashed as KNEXT_POD_NAME and leaked into otel host.name.
    it.each([
        "127.0.0.1",
        "127.0.53.53",
        "::1",
        "::",
        "localhost",
        "LOCALHOST",
    ])("does NOT stash bind/loopback HOSTNAME=%s as pod identity (#184)", (value) => {
        process.env.HOSTNAME = value;
        expect(buildChildEnv().KNEXT_POD_NAME).toBeUndefined();
    });

    it("a real pod-name HOSTNAME still passes through as KNEXT_POD_NAME (#184)", () => {
        process.env.HOSTNAME = "myapp-00001-deployment-7f9c-xk2lp";
        expect(buildChildEnv().KNEXT_POD_NAME).toBe(
            "myapp-00001-deployment-7f9c-xk2lp",
        );
        // "127." must match as a PREFIX of an IP-shaped value only in spirit —
        // a name merely starting with "127" and no dot-segment ambiguity is fine,
        // but anything under 127. is loopback space. Assert the non-loopback name.
        process.env.HOSTNAME = "pod-127-suffix";
        expect(buildChildEnv().KNEXT_POD_NAME).toBe("pod-127-suffix");
    });

    it("never clobbers an explicitly-set KNEXT_POD_NAME (e.g. downward-API wiring)", () => {
        process.env.HOSTNAME = "container-id-abcdef";
        process.env.KNEXT_POD_NAME = "myapp-00001-deployment-7f9c-xk2lp";
        expect(buildChildEnv().KNEXT_POD_NAME).toBe(
            "myapp-00001-deployment-7f9c-xk2lp",
        );
    });

    it("explicit overrides still win last (public API unchanged)", () => {
        process.env.HOSTNAME = "pod-name";
        expect(buildChildEnv({ HOSTNAME: "10.1.2.3" }).HOSTNAME).toBe(
            "10.1.2.3",
        );
    });

    it("keeps the PORT default behavior", () => {
        expect(buildChildEnv().PORT).toBe("3000");
        process.env.PORT = "8080";
        expect(buildChildEnv().PORT).toBe("8080");
    });
});

describe("buildChildEnv: kernel-hostname fallback on the operator path (#184)", () => {
    // The operator injects HOSTNAME=0.0.0.0 (bind override, #178) and CANNOT
    // inject KNEXT_POD_NAME via the downward API: valueFrom.fieldRef in ksvc
    // env is feature-gated on stock Knative (kubernetes.podspec-fieldref,
    // Disabled by default — knative serving pkg/apis/config/features.go) and
    // the validation webhook rejects the Service. The pod identity that DOES
    // survive is the kernel hostname: kubelet sets the pod's OS hostname to
    // the pod name, and the env-var override does not touch it. So inside
    // Kubernetes we fall back to os.hostname().
    it("falls back to os.hostname() when in k8s and HOSTNAME is a bind address", () => {
        process.env.KUBERNETES_SERVICE_HOST = "10.96.0.1";
        process.env.HOSTNAME = "0.0.0.0";
        expect(buildChildEnv().KNEXT_POD_NAME).toBe(kernelHostname());
    });

    it("falls back to os.hostname() when in k8s and HOSTNAME is unset", () => {
        process.env.KUBERNETES_SERVICE_HOST = "10.96.0.1";
        expect(buildChildEnv().KNEXT_POD_NAME).toBe(kernelHostname());
    });

    it("does NOT use the kernel hostname outside Kubernetes", () => {
        process.env.HOSTNAME = "0.0.0.0";
        expect(buildChildEnv().KNEXT_POD_NAME).toBeUndefined();
    });

    it("an explicit KNEXT_POD_NAME still wins over the kernel fallback", () => {
        process.env.KUBERNETES_SERVICE_HOST = "10.96.0.1";
        process.env.HOSTNAME = "0.0.0.0";
        process.env.KNEXT_POD_NAME = "wired-pod-name";
        expect(buildChildEnv().KNEXT_POD_NAME).toBe("wired-pod-name");
    });

    it("a real pod-name HOSTNAME wins over the kernel fallback (parent env is authoritative)", () => {
        process.env.KUBERNETES_SERVICE_HOST = "10.96.0.1";
        process.env.HOSTNAME = "myapp-00001-deployment-7f9c-xk2lp";
        expect(buildChildEnv().KNEXT_POD_NAME).toBe(
            "myapp-00001-deployment-7f9c-xk2lp",
        );
    });
});

describe("otel host.name survives HOSTNAME sanitization (#178)", () => {
    it("host.name resolves from KNEXT_POD_NAME when HOSTNAME is emptied", () => {
        const opts = resolveOtelOptions({
            OTEL_TRACING_ENABLED: "true",
            HOSTNAME: "",
            KNEXT_POD_NAME: "myapp-00001-deployment-7f9c-xk2lp",
        });
        expect(opts?.resourceAttributes["host.name"]).toBe(
            "myapp-00001-deployment-7f9c-xk2lp",
        );
    });

    it("host.name still falls back to HOSTNAME (non-knext runtimes)", () => {
        const opts = resolveOtelOptions({
            OTEL_TRACING_ENABLED: "true",
            HOSTNAME: "some-pod",
        });
        expect(opts?.resourceAttributes["host.name"]).toBe("some-pod");
    });

    it("KNEXT_POD_NAME wins over a bind-address HOSTNAME", () => {
        const opts = resolveOtelOptions({
            OTEL_TRACING_ENABLED: "true",
            HOSTNAME: "0.0.0.0",
            KNEXT_POD_NAME: "real-pod-name",
        });
        expect(opts?.resourceAttributes["host.name"]).toBe("real-pod-name");
    });
});

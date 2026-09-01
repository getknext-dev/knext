/**
 * doctor.ts — probeManifest's anonymous-token dance (#198) and the doctorMain
 * entry. probeManifest HEADs a registry manifest, and on a 401 performs the
 * ghcr/docker-hub token flow (realm+service → Bearer → retry). These mock fetch
 * to drive each status mapping. doctorMain is exercised with --help/--json/table
 * (kubectl is absent in the sandbox, so the gate degrades to warn+SKIP, exit 0).
 */

import { afterEach, describe, expect, it, jest, spyOn } from "bun:test";
import { doctorMain, probeManifest } from "../cli/doctor";

/**
 * bun's `typeof fetch` carries a `preconnect` property; a bare async arrow does
 * not, so `spyOn(globalThis, 'fetch').mockImplementation(async () => …)` is not
 * assignable under `@types/bun`. This attaches the missing member instead of
 * casting, so the callback's own parameter and return types stay checked — a
 * cast would silence a genuinely wrong stub too.
 */
const fetchImpl = (fn: (...a: Parameters<typeof fetch>) => Promise<Response>) =>
    Object.assign(fn, { preconnect: globalThis.fetch.preconnect });

function res(init: {
    status: number;
    ok?: boolean;
    wwwAuth?: string;
    json?: unknown;
}) {
    return {
        status: init.status,
        ok: init.ok ?? (init.status >= 200 && init.status < 300),
        headers: {
            get: (h: string) =>
                h === "www-authenticate" ? (init.wwwAuth ?? null) : null,
        },
        json: async () => init.json ?? {},
    } as unknown as Response;
}

afterEach(() => jest.restoreAllMocks());

describe("probeManifest — anonymous token flow (#198)", () => {
    it("does the realm/service → Bearer → retry dance and returns 'ok'", async () => {
        const calls: string[] = [];
        spyOn(globalThis, "fetch").mockImplementation(
            fetchImpl(async (url) => {
                const u = String(url);
                calls.push(u);
                if (u.includes("/manifests/") && calls.length === 1) {
                    return res({
                        status: 401,
                        wwwAuth:
                            'Bearer realm="https://ghcr.io/token",service="ghcr.io"',
                    });
                }
                if (u.startsWith("https://ghcr.io/token")) {
                    return res({ status: 200, json: { token: "abc" } });
                }
                return res({ status: 200 }); // authorized retry
            }),
        );

        expect(await probeManifest("ghcr.io/acme/app:v1")).toBe("ok");
        // HEAD (401) → token → HEAD (Bearer) = 3 fetches.
        expect(calls).toHaveLength(3);
        expect(calls[1]).toContain("service=ghcr.io");
        expect(calls[1]).toContain("scope=repository");
    });

    it("returns 'auth-required' when the token endpoint itself fails", async () => {
        spyOn(globalThis, "fetch").mockImplementation(
            fetchImpl(async (url) => {
                const u = String(url);
                if (u.includes("/manifests/")) {
                    return res({
                        status: 401,
                        wwwAuth: 'Bearer realm="https://ghcr.io/token"',
                    });
                }
                return res({ status: 500 }); // token fetch fails → no retry
            }),
        );
        expect(await probeManifest("ghcr.io/acme/app:v1")).toBe(
            "auth-required",
        );
    });

    it("maps a 404 to 'not-found' and a 403 to 'auth-required'", async () => {
        const notFound = spyOn(globalThis, "fetch").mockResolvedValue(
            res({ status: 404 }),
        );
        expect(await probeManifest("ghcr.io/acme/app:v1")).toBe("not-found");
        notFound.mockResolvedValue(res({ status: 403 }));
        expect(await probeManifest("ghcr.io/acme/app:v1")).toBe(
            "auth-required",
        );
    });

    it("maps an unexpected 5xx (no auth challenge) to 'unreachable'", async () => {
        spyOn(globalThis, "fetch").mockResolvedValue(res({ status: 500 }));
        expect(await probeManifest("ghcr.io/acme/app:v1")).toBe("unreachable");
    });
});

describe("doctorMain", () => {
    it("returns 0 for --help", async () => {
        expect(await doctorMain(["--help"])).toBe(0);
    });

    // HERMETIC: inject fakes for kubectl + the registry probe. The earlier
    // version ran the REAL kubectlRunner + probeManifest ("whatever the
    // sandbox's cluster state") — in CI that meant ~7s of kubectl/registry
    // connection timeouts, flaking the 5s test budget. Unit tests must never
    // depend on the host's cluster or network.
    const fakeDeps = {
        kubectl: (_args: readonly string[]) => ({
            ok: false,
            stdout: "",
            stderr: "kubectl: command not found",
        }),
        probeImage: async (_image: string) => "ok" as const,
    };

    it("runs the human-table report and returns a valid exit code", async () => {
        // kubectl absent → the gate degrades to warn+SKIP; doctorMain must
        // still resolve to a 0|1 code without throwing (exercises the injected
        // runner path + formatDoctorTable).
        expect([0, 1]).toContain(await doctorMain([], fakeDeps));
    });

    it("runs the --json report and returns a valid exit code", async () => {
        expect([0, 1]).toContain(await doctorMain(["--json"], fakeDeps));
    });
});

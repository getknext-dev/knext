/**
 * `knext status` — surface the NextApp CR's honest conditions (Workstream C).
 *
 * The operator reports rich truth on the CR (Ready with reasons incl.
 * IngressNotProgrammed, Degraded, DatabaseReady Provisioned|Bound, Reconciling,
 * status.url / databaseSecretName) — this command renders it at the terminal
 * instead of forcing a kubectl-describe.
 *
 * READ-ONLY by construction (ADR-0001): the only cluster call is a
 * `kubectl get nextapp <app> -o json`. All cluster I/O goes through the same
 * injectable kubectl runner doctor.ts uses, so every test here is hermetic.
 *
 * Fixtures covered: healthy, IngressNotProgrammed stall, database-bound,
 * degraded, missing CR, unreachable cluster, old-operator sparse status.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { KubectlFn } from "../cli/doctor";
import {
    ENVMAP_COLLISION_INFORMATIONAL_REASONS,
    extractStatus,
    humanizeAge,
    parseStatusArgs,
    renderStatusHuman,
    runStatus,
    type StatusDeps,
    type StatusOptions,
    statusModelToJson,
} from "../cli/status";

// ---------------------------------------------------------------------------
// Fixtures — canned NextApp CRs mirroring what the operator actually writes.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-07-06T12:00:00Z");
const T_3M_AGO = "2026-07-06T11:57:00Z";
const T_2H_AGO = "2026-07-06T10:00:00Z";

const IMAGE =
    "ghcr.io/acme/web@sha256:75be42bb6b4c6d03c902b4fc90b36b246cc6cacf2233926fa183a6051521a99d";

/** The #208-style guidance the operator writes verbatim into the condition. */
const INGRESS_STALL_MESSAGE =
    "KIngress has not been programmed for more than 2m0s — config-network " +
    'ingress-class is "kourier.knative.dev" but net-kourier serves ' +
    '"kourier.ingress.networking.knative.dev"; no reconciler serves this ' +
    "class, routes will never program (#208)";

function baseCr() {
    return {
        apiVersion: "apps.kn-next.dev/v1alpha1",
        kind: "NextApp",
        metadata: { name: "web", namespace: "default" },
        spec: { image: IMAGE },
        status: {} as Record<string, unknown>,
    };
}

/** Healthy: Ready=True, url programmed, no database. */
function healthyCr() {
    const cr = baseCr();
    cr.status = {
        url: "https://web.default.example.com",
        conditions: [
            {
                type: "Ready",
                status: "True",
                reason: "Ready",
                message: "Knative Service Ready; route programmed",
                lastTransitionTime: T_3M_AGO,
            },
            {
                type: "Degraded",
                status: "False",
                reason: "Ready",
                message: "",
                lastTransitionTime: T_3M_AGO,
            },
            {
                type: "Reconciling",
                status: "False",
                reason: "Reconciled",
                message: "",
                lastTransitionTime: T_3M_AGO,
            },
        ],
    };
    return cr;
}

/** Ingress stall: Ready=False/IngressNotProgrammed + Degraded=True (#208). */
function ingressStalledCr() {
    const cr = baseCr();
    cr.status = {
        conditions: [
            {
                type: "Ready",
                status: "False",
                reason: "IngressNotProgrammed",
                message: INGRESS_STALL_MESSAGE,
                lastTransitionTime: T_2H_AGO,
            },
            {
                type: "Degraded",
                status: "True",
                reason: "IngressNotProgrammed",
                message: INGRESS_STALL_MESSAGE,
                lastTransitionTime: T_2H_AGO,
            },
        ],
    };
    return cr;
}

/** BYO binding (ADR-0019): spec.database.secretRef + DatabaseReady=True/Bound. */
function databaseBoundCr() {
    const cr = healthyCr();
    (cr.spec as Record<string, unknown>).database = {
        secretRef: { name: "my-db-secret" },
    };
    (cr.status as Record<string, unknown>).databaseSecretName = "my-db-secret";
    (cr.status.conditions as Record<string, unknown>[]).push({
        type: "DatabaseReady",
        status: "True",
        reason: "Bound",
        message: 'Secret "my-db-secret" bound; DATABASE_URL wired into the app',
        lastTransitionTime: T_3M_AGO,
    });
    return cr;
}

/** A grandfathered spec.secrets.envMap collision (#1391): EnvMapCollision=True. */
const ENVMAP_COLLISION_MESSAGE =
    "spec.secrets.envMap collides with operator-managed system env — NODE_ENV: this " +
    "NextApp predates admission validation for this collision (new/updated CRs are " +
    "rejected) — the spec.secrets.envMap value is used INSTEAD of the operator's own " +
    "default for these name(s); remove the envMap entry to fall back to the operator's " +
    "default.";
function envMapCollisionCr() {
    const cr = healthyCr();
    (cr.status.conditions as Record<string, unknown>[]).push({
        type: "EnvMapCollision",
        status: "True",
        reason: "EnvMapReservedGrandfathered",
        message: ENVMAP_COLLISION_MESSAGE,
        lastTransitionTime: T_3M_AGO,
    });
    return cr;
}

/**
 * #1391 round 3: the documented, exempt-only envMap collision — a
 * connection-string name (REDIS_URL) sourced via envMap, the operator's
 * sanctioned pattern. status=True (the condition still fires — the
 * collision IS real at the env-render level) but the reason is the
 * informational one the operator emits a Normal event for, never Warning.
 */
const ENVMAP_EXEMPT_COLLISION_MESSAGE =
    "spec.secrets.envMap collides with operator-managed system env — REDIS_URL: " +
    "connection-string name(s) always sourced from your spec.secrets.envMap Secret " +
    "— the documented pattern for a value the CRD has no typed field for yet; no " +
    "action needed.";
function envMapExemptCollisionCr() {
    const cr = healthyCr();
    (cr.status.conditions as Record<string, unknown>[]).push({
        type: "EnvMapCollision",
        status: "True",
        reason: "EnvMapExpectedOverride",
        message: ENVMAP_EXEMPT_COLLISION_MESSAGE,
        lastTransitionTime: T_3M_AGO,
    });
    return cr;
}

/**
 * #1413 review, round 4: a MIXED report — a real, operator-managed collision
 * (HOSTNAME, always operatorWins) alongside an unrelated exempt connection-
 * string name (REDIS_URL). The Go side's informational gate
 * (computeStatusVerdict) must NOT downgrade this to the informational reason
 * just because an exempt name is also present — it stays reason=EnvVarIgnored,
 * the real-collision alarm reason. This fixture proves the CLI mirror renders
 * it as an alarm end to end, not just that the Go-side reason string is right.
 */
const ENVMAP_MIXED_COLLISION_MESSAGE =
    "spec.secrets.envMap collides with operator-managed system env — HOSTNAME: " +
    "always managed by the operator, envMap ignored (no action needed unless " +
    "the operator's own value is not what you intended); REDIS_URL: " +
    "connection-string name(s) always sourced from your spec.secrets.envMap Secret " +
    "— the documented pattern for a value the CRD has no typed field for yet; no " +
    "action needed.";
function envMapMixedCollisionCr() {
    const cr = healthyCr();
    (cr.status.conditions as Record<string, unknown>[]).push({
        type: "EnvMapCollision",
        status: "True",
        reason: "EnvVarIgnored",
        message: ENVMAP_MIXED_COLLISION_MESSAGE,
        lastTransitionTime: T_3M_AGO,
    });
    return cr;
}

/** Old operator: only status.url is populated — no conditions at all. */
function sparseCr() {
    const cr = baseCr();
    cr.status = { url: "https://web.default.example.com" };
    return cr;
}

/** The Degraded-True guidance the operator writes — must reach the user. */
const DEGRADED_MESSAGE =
    'container "app" is crash-looping — kubectl logs -l app=web -n default shows the stack trace';

/**
 * Degraded is ALARM-when-True polarity: Ready can even be True while Degraded
 * fires. The reason + message must render VERBATIM in the bad state.
 */
function degradedOnlyCr() {
    const cr = healthyCr();
    cr.status.conditions = (
        cr.status.conditions as Record<string, unknown>[]
    ).map((c) =>
        c.type === "Degraded"
            ? {
                  type: "Degraded",
                  status: "True",
                  reason: "PodCrashLooping",
                  message: DEGRADED_MESSAGE,
                  lastTransitionTime: T_3M_AGO,
              }
            : c,
    );
    return cr;
}

/** Malformed CR: status.conditions is not an array (corrupt/foreign object). */
function garbageConditionsCr() {
    const cr = baseCr();
    cr.status = {
        url: "https://web.default.example.com",
        conditions: "garbage",
    };
    return cr;
}

/** Stub kubectl keyed on the joined argv (doctor.ts convention). */
function stubKubectl(
    table: Record<string, { ok: boolean; stdout?: string; stderr?: string }>,
): KubectlFn {
    return (args) => {
        const key = args.join(" ");
        const hit = table[key];
        if (!hit) {
            return { ok: false, stdout: "", stderr: `no stub for: ${key}` };
        }
        return {
            ok: hit.ok,
            stdout: hit.stdout ?? "",
            stderr: hit.stderr ?? "",
        };
    };
}

const GET_WEB = "kubectl get nextapp web -n default -o json";

function opts(over: Partial<StatusOptions> = {}): StatusOptions {
    return {
        namespace: "default",
        json: false,
        watch: false,
        timeoutMs: 600_000,
        ...over,
    };
}

/** Hermetic deps: captured writes, fixed clock, instant sleeps. */
function makeDeps(
    kubectl: KubectlFn,
    clock: { t: number } = { t: NOW.getTime() },
): { deps: StatusDeps; out: string[]; clock: { t: number } } {
    const out: string[] = [];
    const deps: StatusDeps = {
        kubectl,
        write: (t) => out.push(t),
        now: () => new Date(clock.t),
        sleep: async (ms) => {
            clock.t += ms;
        },
    };
    return { deps, out, clock };
}

// ---------------------------------------------------------------------------
// parseStatusArgs
// ---------------------------------------------------------------------------

describe("parseStatusArgs", () => {
    it("parses the positional app, -n/--namespace, --json, --watch", () => {
        const a = parseStatusArgs(["web", "-n", "prod", "--json"]);
        expect(a.app).toBe("web");
        expect(a.namespace).toBe("prod");
        expect(a.json).toBe(true);
        expect(parseStatusArgs(["web", "--watch"]).watch).toBe(true);
    });

    it("rejects --watch --json with a clean usage error (documented in --help)", () => {
        expect(() => parseStatusArgs(["--watch", "--json"])).toThrow(
            /--json cannot be combined with --watch.*status --help/s,
        );
        expect(() => parseStatusArgs(["--json", "--watch"])).toThrow(
            /--json cannot be combined with --watch/,
        );
    });

    it("defaults: namespace default, no json/watch, 10m watch bound", () => {
        const a = parseStatusArgs([]);
        expect(a.app).toBeUndefined();
        expect(a.namespace).toBe("default");
        expect(a.json).toBe(false);
        expect(a.watch).toBe(false);
        expect(a.timeoutMs).toBe(600_000);
    });

    it("rejects unknown flags with a usage hint", () => {
        expect(() => parseStatusArgs(["--wacth"])).toThrow(
            /unknown flag "--wacth".*status --help/,
        );
    });

    it("rejects a second positional", () => {
        expect(() => parseStatusArgs(["web", "extra"])).toThrow(/positional/);
    });

    it("a value-taking flag without a value is a usage error", () => {
        expect(() => parseStatusArgs(["web", "-n"])).toThrow(
            /requires a value/,
        );
    });
});

// ---------------------------------------------------------------------------
// humanizeAge
// ---------------------------------------------------------------------------

describe("humanizeAge", () => {
    it('renders "3m ago" / "2h ago" style ages', () => {
        expect(humanizeAge(T_3M_AGO, NOW)).toBe("3m ago");
        expect(humanizeAge(T_2H_AGO, NOW)).toBe("2h ago");
        expect(humanizeAge("2026-07-06T11:59:45Z", NOW)).toBe("15s ago");
        expect(humanizeAge("2026-07-01T12:00:00Z", NOW)).toBe("5d ago");
    });

    it("degrades gracefully on garbage timestamps", () => {
        expect(humanizeAge("not-a-time", NOW)).toBe("unknown");
    });
});

// ---------------------------------------------------------------------------
// extractStatus — CR json → structured model
// ---------------------------------------------------------------------------

describe("extractStatus", () => {
    it("healthy: url, image, Ready=True, database mode none", () => {
        const m = extractStatus(healthyCr());
        expect(m.name).toBe("web");
        expect(m.namespace).toBe("default");
        expect(m.url).toBe("https://web.default.example.com");
        expect(m.image).toBe(IMAGE);
        expect(m.ready?.status).toBe("True");
        expect(m.degraded?.status).toBe("False");
        expect(m.database.mode).toBe("none");
        expect(m.database.secretName).toBeUndefined();
    });

    it("database-bound: mode bound + the bound secret name", () => {
        const m = extractStatus(databaseBoundCr());
        expect(m.database.mode).toBe("bound");
        expect(m.database.secretName).toBe("my-db-secret");
        expect(m.databaseReady?.status).toBe("True");
        expect(m.databaseReady?.reason).toBe("Bound");
    });

    it("envMap collision: reason + message surfaced (#1391)", () => {
        const m = extractStatus(envMapCollisionCr());
        expect(m.envMapCollision?.status).toBe("True");
        expect(m.envMapCollision?.reason).toBe("EnvMapReservedGrandfathered");
        expect(m.envMapCollision?.message).toBe(ENVMAP_COLLISION_MESSAGE);
    });

    it("old-operator sparse status: conditions absent → undefined views", () => {
        const m = extractStatus(sparseCr());
        expect(m.url).toBe("https://web.default.example.com");
        expect(m.ready).toBeUndefined();
        expect(m.degraded).toBeUndefined();
        expect(m.databaseReady).toBeUndefined();
        expect(m.reconciling).toBeUndefined();
        expect(m.envMapCollision).toBeUndefined();
    });

    it("malformed non-array conditions → undefined views, never a crash", () => {
        const m = extractStatus(garbageConditionsCr());
        expect(m.url).toBe("https://web.default.example.com");
        expect(m.ready).toBeUndefined();
        expect(m.degraded).toBeUndefined();
        expect(m.databaseReady).toBeUndefined();
        expect(m.reconciling).toBeUndefined();
        const text = renderStatusHuman(m, NOW);
        expect(text).toContain("not reported");
    });
});

// ---------------------------------------------------------------------------
// renderStatusHuman
// ---------------------------------------------------------------------------

describe("renderStatusHuman", () => {
    it("healthy: URL, Ready=True, humanized transition age, image digest", () => {
        const text = renderStatusHuman(extractStatus(healthyCr()), NOW);
        expect(text).toContain("https://web.default.example.com");
        expect(text).toMatch(/Ready\s+True/);
        expect(text).toContain("3m ago");
        expect(text).toContain(IMAGE);
        expect(text).toMatch(/Database\s+none/);
    });

    it("IngressNotProgrammed: reason + operator guidance verbatim", () => {
        const text = renderStatusHuman(extractStatus(ingressStalledCr()), NOW);
        expect(text).toMatch(/Ready\s+False/);
        expect(text).toContain("IngressNotProgrammed");
        // The operator's field-learned guidance must reach the user VERBATIM.
        expect(text).toContain(INGRESS_STALL_MESSAGE);
        expect(text).toContain("2h ago");
    });

    it("degraded: Degraded=True surfaces its reason AND message (True is the ALARM polarity)", () => {
        // Ready=True here — only Degraded carries the alarm, so the guidance
        // below can ONLY come from the Degraded line (polarity regression guard).
        const text = renderStatusHuman(extractStatus(degradedOnlyCr()), NOW);
        expect(text).toMatch(/Ready\s+True/);
        expect(text).toMatch(/Degraded\s+True.*PodCrashLooping/);
        expect(text).toContain(DEGRADED_MESSAGE);
    });

    it("degraded via ingress stall: reason + message render on the Degraded line too", () => {
        const text = renderStatusHuman(extractStatus(ingressStalledCr()), NOW);
        const degradedBlock = text.slice(text.indexOf("Degraded"));
        expect(degradedBlock).toMatch(/Degraded\s+True.*IngressNotProgrammed/);
        expect(degradedBlock).toContain(INGRESS_STALL_MESSAGE);
    });

    it("database-bound: mode + secret name are rendered", () => {
        const text = renderStatusHuman(extractStatus(databaseBoundCr()), NOW);
        expect(text).toMatch(/Database\s+bound/);
        expect(text).toContain("my-db-secret");
    });

    it("envMap collision: True is the ALARM polarity, reason + message render (#1391)", () => {
        const text = renderStatusHuman(extractStatus(envMapCollisionCr()), NOW);
        expect(text).toMatch(
            /EnvMapCollision\s+True.*EnvMapReservedGrandfathered/,
        );
        expect(text).toContain(ENVMAP_COLLISION_MESSAGE);
    });

    it("envMap collision, exempt-only (#1391 round 3): informational, NOT rendered as an alarm", () => {
        const text = renderStatusHuman(
            extractStatus(envMapExemptCollisionCr()),
            NOW,
        );
        // The reason still renders (informational conditions get the calm,
        // Ready-style one-line treatment), but the message dump — the alarm
        // formatting a real collision gets — must NOT appear.
        expect(text).toMatch(/EnvMapCollision\s+True.*EnvMapExpectedOverride/);
        expect(text).not.toContain(ENVMAP_EXEMPT_COLLISION_MESSAGE);
    });

    it("envMap collision, operator-wins PLUS an unrelated exempt name (#1413 round 4): still ALARM, not downgraded", () => {
        const text = renderStatusHuman(
            extractStatus(envMapMixedCollisionCr()),
            NOW,
        );
        // reason=EnvVarIgnored (the real-collision reason), not
        // EnvMapExpectedOverride — an exempt name alongside a real
        // operator-wins collision must not silently downgrade the alarm.
        expect(text).toMatch(/EnvMapCollision\s+True.*EnvVarIgnored/);
        expect(text).toContain(ENVMAP_MIXED_COLLISION_MESSAGE);
    });

    it("informational reasons list contains exactly the operator's documented-pattern reason", () => {
        expect(ENVMAP_COLLISION_INFORMATIONAL_REASONS).toEqual([
            "EnvMapExpectedOverride",
        ]);
    });

    it("ENVMAP_COLLISION_INFORMATIONAL_REASONS is lockstepped with the Go ReasonEnvMapExpectedOverride constant (#1391 round 5)", () => {
        // The TS list and the Go reason string are hand-maintained on either
        // side of a language boundary (see the doc comment on
        // ENVMAP_COLLISION_INFORMATIONAL_REASONS) — a rename on one side with
        // no corresponding change on the other would silently downgrade the
        // informational rendering back to an alarm dump. Reads the Go source
        // as text (same pattern as metrics-port-lockstep.test.ts) rather than
        // hardcoding a second copy of the string, so a rename on the Go side
        // is caught here without anyone remembering to update this file too.
        const controllerGo = readFileSync(
            resolve(
                __dirname,
                "..",
                "..",
                "..",
                "kn-next-operator",
                "internal",
                "controller",
                "nextapp_controller.go",
            ),
            "utf8",
        );
        const m = controllerGo.match(
            /ReasonEnvMapExpectedOverride\s*=\s*"([^"]+)"/,
        );
        if (!m) {
            throw new Error(
                "could not find ReasonEnvMapExpectedOverride's string value in nextapp_controller.go — the constant was renamed/moved and this lockstep guard needs updating, not silently skipped",
            );
        }
        expect(
            ENVMAP_COLLISION_INFORMATIONAL_REASONS as readonly string[],
        ).toContain(m[1]);
    });

    it("no envMap collision: healthy CR (no EnvMapCollision condition) renders 'not reported'", () => {
        const text = renderStatusHuman(extractStatus(healthyCr()), NOW);
        expect(text).toMatch(/EnvMapCollision\s+not reported/);
    });

    it("label columns align on the max label width (incl. EnvMapCollision)", () => {
        const text = renderStatusHuman(extractStatus(databaseBoundCr()), NOW);
        const lines = text.split("\n");
        const columns = new Set(
            [
                "Ready",
                "Degraded",
                "Reconciling",
                "DatabaseReady",
                "EnvMapCollision",
                "Image",
            ].map((label) => {
                const line = lines.find((l) =>
                    new RegExp(`^${label}\\s`).test(l),
                );
                expect(line, label).toBeDefined();
                return (
                    (line as string).slice(label.length).search(/\S/) +
                    label.length
                );
            }),
        );
        expect([...columns]).toHaveLength(1);
    });

    it('old operator: absent conditions render as "not reported", never crash', () => {
        const text = renderStatusHuman(extractStatus(sparseCr()), NOW);
        expect(text).toContain("not reported");
        expect(text).toContain("https://web.default.example.com");
    });
});

// ---------------------------------------------------------------------------
// runStatus — orchestration + exit-code contract
// ---------------------------------------------------------------------------

describe("runStatus — exit-code contract (CI-usable)", () => {
    it("Ready=True → exit 0", async () => {
        const { deps, out } = makeDeps(
            stubKubectl({
                [GET_WEB]: { ok: true, stdout: JSON.stringify(healthyCr()) },
            }),
        );
        const code = await runStatus("web", opts(), deps);
        expect(code).toBe(0);
        expect(out.join("")).toContain("https://web.default.example.com");
    });

    it("Ready=False → exit 1 (documented for CI gates)", async () => {
        const { deps, out } = makeDeps(
            stubKubectl({
                [GET_WEB]: {
                    ok: true,
                    stdout: JSON.stringify(ingressStalledCr()),
                },
            }),
        );
        const code = await runStatus("web", opts(), deps);
        expect(code).toBe(1);
        expect(out.join("")).toContain(INGRESS_STALL_MESSAGE);
    });

    it("old-operator sparse status (no Ready condition) → exit 0, not a false alarm", async () => {
        const { deps } = makeDeps(
            stubKubectl({
                [GET_WEB]: { ok: true, stdout: JSON.stringify(sparseCr()) },
            }),
        );
        expect(await runStatus("web", opts(), deps)).toBe(0);
    });

    it("issues ONLY the read (ADR-0001: no cluster writes)", async () => {
        const calls: string[] = [];
        const kubectl: KubectlFn = (args) => {
            calls.push(args.join(" "));
            return {
                ok: true,
                stdout: JSON.stringify(healthyCr()),
                stderr: "",
            };
        };
        const { deps } = makeDeps(kubectl);
        await runStatus("web", opts(), deps);
        expect(calls).toEqual([GET_WEB]);
    });
});

describe("runStatus — clean errors with hints", () => {
    it("missing CR → actionable error naming deploy + doctor", async () => {
        const { deps } = makeDeps(
            stubKubectl({
                [GET_WEB]: {
                    ok: false,
                    stderr: 'Error from server (NotFound): nextapps.apps.kn-next.dev "web" not found',
                },
            }),
        );
        await expect(runStatus("web", opts(), deps)).rejects.toThrow(
            /NextApp "web" not found in namespace "default".*knext deploy.*knext doctor/s,
        );
    });

    it("unreachable cluster → clean error referring to doctor", async () => {
        const { deps } = makeDeps(
            stubKubectl({
                [GET_WEB]: {
                    ok: false,
                    stderr: "The connection to the server 10.0.0.1:6443 was refused - did you specify the right host or port?",
                },
            }),
        );
        await expect(runStatus("web", opts(), deps)).rejects.toThrow(
            /cluster unreachable.*knext doctor/s,
        );
    });
});

// ---------------------------------------------------------------------------
// --json contract
// ---------------------------------------------------------------------------

describe("--json contract", () => {
    it("emits the structured subset as parseable JSON", async () => {
        const { deps, out } = makeDeps(
            stubKubectl({
                [GET_WEB]: {
                    ok: true,
                    stdout: JSON.stringify(databaseBoundCr()),
                },
            }),
        );
        const code = await runStatus("web", opts({ json: true }), deps);
        expect(code).toBe(0);
        const parsed = JSON.parse(out.join(""));
        expect(parsed.name).toBe("web");
        expect(parsed.namespace).toBe("default");
        expect(parsed.url).toBe("https://web.default.example.com");
        expect(parsed.image).toBe(IMAGE);
        expect(parsed.ready.status).toBe("True");
        expect(parsed.database).toEqual({
            mode: "bound",
            secretName: "my-db-secret",
        });
        expect(parsed.databaseReady.reason).toBe("Bound");
    });

    it("absent conditions are null in JSON (old operators), not omitted crashes", () => {
        const json = JSON.parse(statusModelToJson(extractStatus(sparseCr())));
        expect(json.ready).toBeNull();
        expect(json.degraded).toBeNull();
        expect(json.databaseReady).toBeNull();
        expect(json.reconciling).toBeNull();
        expect(json.envMapCollision).toBeNull();
    });

    it("envMap collision surfaces in JSON (#1391)", () => {
        const json = JSON.parse(
            statusModelToJson(extractStatus(envMapCollisionCr())),
        );
        expect(json.envMapCollision.status).toBe("True");
        expect(json.envMapCollision.reason).toBe("EnvMapReservedGrandfathered");
    });
});

// ---------------------------------------------------------------------------
// --watch
// ---------------------------------------------------------------------------

describe("--watch", () => {
    it("polls every 5s and exits 0 as soon as Ready=True", async () => {
        let call = 0;
        const kubectl: KubectlFn = () => {
            call++;
            const cr = call < 3 ? ingressStalledCr() : healthyCr();
            return { ok: true, stdout: JSON.stringify(cr), stderr: "" };
        };
        const { deps } = makeDeps(kubectl);
        const sleep = spyOn(deps, "sleep");
        const code = await runStatus("web", opts({ watch: true }), deps);
        expect(code).toBe(0);
        expect(call).toBe(3);
        expect(sleep).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenNthCalledWith(1, 5000);
        expect(sleep).toHaveBeenNthCalledWith(2, 5000);
    });

    it("is bounded: gives up after timeoutMs with exit 1", async () => {
        const kubectl: KubectlFn = () => ({
            ok: true,
            stdout: JSON.stringify(ingressStalledCr()),
            stderr: "",
        });
        const { deps, out } = makeDeps(kubectl);
        const code = await runStatus(
            "web",
            opts({ watch: true, timeoutMs: 20_000 }),
            deps,
        );
        expect(code).toBe(1);
        expect(out.join("")).toMatch(/timed out/i);
    });

    it("tolerates up to 3 consecutive transient kubectl failures, then recovers", async () => {
        // `knext deploy && knext status --watch` as a CI gate must not die
        // on a single apiserver blip mid-poll.
        let call = 0;
        const kubectl: KubectlFn = () => {
            call++;
            if (call <= 3) {
                return {
                    ok: false,
                    stdout: "",
                    stderr: "Unable to connect to the server: net/http: TLS handshake timeout",
                };
            }
            return {
                ok: true,
                stdout: JSON.stringify(healthyCr()),
                stderr: "",
            };
        };
        const { deps, out } = makeDeps(kubectl);
        const code = await runStatus("web", opts({ watch: true }), deps);
        expect(code).toBe(0);
        expect(call).toBe(4);
        expect(out.join("")).toMatch(/transient/i);
    });

    it("throws after the 4th consecutive failure (persistent outage is not a blip)", async () => {
        let call = 0;
        const kubectl: KubectlFn = () => {
            call++;
            return {
                ok: false,
                stdout: "",
                stderr: "The connection to the server 10.0.0.1:6443 was refused - did you specify the right host or port?",
            };
        };
        const { deps } = makeDeps(kubectl);
        await expect(
            runStatus("web", opts({ watch: true }), deps),
        ).rejects.toThrow(/cluster unreachable.*knext doctor/s);
        expect(call).toBe(4);
    });

    it("a failure streak resets on success (only CONSECUTIVE failures count)", async () => {
        let call = 0;
        // fail x3 → not-ready success → fail x3 → ready: must survive both streaks.
        const script: Array<"fail" | "notready" | "ready"> = [
            "fail",
            "fail",
            "fail",
            "notready",
            "fail",
            "fail",
            "fail",
            "ready",
        ];
        const kubectl: KubectlFn = () => {
            const step = script[call] ?? "ready";
            call++;
            if (step === "fail") {
                return { ok: false, stdout: "", stderr: "connection refused" };
            }
            const cr = step === "ready" ? healthyCr() : ingressStalledCr();
            return { ok: true, stdout: JSON.stringify(cr), stderr: "" };
        };
        const { deps } = makeDeps(kubectl);
        const code = await runStatus("web", opts({ watch: true }), deps);
        expect(code).toBe(0);
        expect(call).toBe(script.length);
    });
});

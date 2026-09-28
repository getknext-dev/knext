/**
 * #950 — honesty about whether the scaffold's @getknext/* pins can install.
 *
 * `knext create` pins the generated app's `@getknext/*` deps at the CLI's
 * OWN version (`^{{ version }}` in the template — the packages are a
 * changesets `fixed` group, so one version speaks for all of them). That is
 * correct by construction for a PUBLISHED CLI: the version it carries is on
 * the registry, because it IS the registry artifact.
 *
 * It is silently wrong for a CLI whose version was never published — a source
 * checkout, or a release lane blocked before `npm publish` (#853's dead token
 * is exactly how the S3-V run found this, Finding A-1): the scaffold exits 0
 * and the FIRST documented command, `npm install`, dies with `notarget`.
 *
 * This module is the create-time half of the fix: a best-effort registry
 * probe that WARNS when the pinned versions do not exist. Deliberate limits:
 *
 *   - Best-effort, never a gate. `create` writes files offline; an
 *     unreachable registry stays SILENT rather than failing the scaffold or
 *     crying wolf on every air-gapped run. The fail-closed "value" check
 *     lives where a gate belongs: the scaffold-install nightly
 *     (`scripts/verify-scaffold-install.mjs`), which treats unreachable as
 *     red — same division of labour as the action-pin checks (security.md).
 *   - Scan, don't enumerate: the pins come from the RENDERED package.json,
 *     so a template that gains a third @getknext dep is covered on the day
 *     it lands.
 *   - The probe respects `npm_config_registry` — the env var npm itself sets
 *     when a user has a registry override — so a mirror-only environment is
 *     checked against the registry `npm install` will actually hit.
 */

export interface ScaffoldPin {
    /** Package name, e.g. `@getknext/core`. */
    name: string;
    /** The range as pinned in the generated package.json, e.g. `^0.3.1`. */
    range: string;
    /**
     * The exact version the range anchors on (`^X.Y.Z` → `X.Y.Z`, or
     * `^X.Y.Z-<prerelease>` → `X.Y.Z-<prerelease>`), or null when the range
     * is not that shape (hand-edited apps). Null pins are not probed:
     * guessing what an arbitrary range resolves to is the registry's job,
     * not ours.
     */
    version: string | null;
}

export type RegistryVerdict =
    | { kind: "ok" }
    | { kind: "missing"; missing: ScaffoldPin[] }
    | { kind: "unreachable" };

/**
 * A bare `^X.Y.Z` or `^X.Y.Z-<prerelease>` caret pin — the ONLY shape the
 * scaffold template ever renders (`^{{ version }}`, see the module doc).
 * Prerelease-aware for the same reason round 2 made `verify-published-group`
 * and `audit-published`'s caret matching prerelease-aware (#1591): once the
 * CLI's own manifest version is `1.0.0-rc.1`, the rendered pin is
 * `^1.0.0-rc.1`, and the pre-#1591 release-only shape parsed that to `null`
 * — silently skipping the unpublished-pin warning this module exists to give
 * (#950) for every rc build. The prerelease identifier grammar (dot-split
 * `[0-9A-Za-z-]+`) matches semver 2.0.0 §9 and is the same character class
 * used by `parseSemver`/`caretSatisfies` in `scripts/audit-published.mjs` /
 * `scripts/verify-published-group.mjs` — this is a deliberate, independent
 * copy rather than a shared import: those two live in root `scripts/` (CI
 * tooling, never published), this lives in `packages/kn-next/src` (the
 * published CLI bundle), and the existing precedent in this repo is that
 * each consumer of this exact grammar keeps its own copy so it is provable
 * on its own closure (see the doc comment on `caretSatisfies`). Anything
 * that does not match this exact shape yields `null` and is silently
 * skipped, never guessed at — a malformed pin (e.g. a trailing dot, an empty
 * prerelease identifier, an `||` range) is a hand-edited app whose range is
 * the user's call, not ours.
 */
const CARET_PIN = /^\^(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/;

/** Extract every `@getknext/*` pin from a rendered scaffold's package.json. */
export function scaffoldGetknextPins(
    files: Map<string, string>,
): ScaffoldPin[] {
    const raw = files.get("package.json");
    if (raw === undefined) return [];
    let pkg: {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
    };
    try {
        pkg = JSON.parse(raw) as typeof pkg;
    } catch {
        return [];
    }
    return Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })
        .filter(([name]) => name.startsWith("@getknext/"))
        .map(([name, range]) => ({
            name,
            range,
            version: CARET_PIN.exec(range)?.[1] ?? null,
        }));
}

/**
 * Structural fetch shape, NOT `typeof fetch`: bun's global fetch type carries
 * a `preconnect` member, which would force every injected test double to fake
 * an API this module never calls.
 */
export type FetchLike = (
    input: string | URL | Request,
    init?: RequestInit,
) => Promise<Response>;

export interface CheckOptions {
    /** Injectable for tests; defaults to the global fetch. */
    fetchImpl?: FetchLike;
    /** Registry base URL; defaults to npm's override env var, then npmjs. */
    registry?: string;
    /** Per-request timeout — a scaffold must not hang on a slow registry. */
    timeoutMs?: number;
}

/**
 * Probe the registry for each pinned version.
 *
 * ANY failure to get an answer — network error, timeout, unexpected status,
 * unparseable body — yields `unreachable`, never `ok` and never `missing`:
 * the caller must not warn about versions it could not actually check, and
 * must not certify them either.
 */
export async function checkPinsPublished(
    pins: ScaffoldPin[],
    opts: CheckOptions = {},
): Promise<RegistryVerdict> {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const registry = (
        opts.registry ??
        process.env.npm_config_registry ??
        "https://registry.npmjs.org"
    ).replace(/\/+$/, "");
    const timeoutMs = opts.timeoutMs ?? 3000;

    // Probed in PARALLEL so the offline worst case is one timeout, not one
    // per pin — this runs inline in `knext create`.
    const results = await Promise.all(
        pins.map(async (pin): Promise<"ok" | "missing" | "unreachable"> => {
            if (pin.version === null) return "ok";
            // Scoped names keep the literal `@` but encode the slash —
            // the shape the npm registry serves (`/@getknext%2fcore`).
            const url = `${registry}/${encodeURIComponent(pin.name).replace(/%40/i, "@")}`;
            let res: Response;
            try {
                res = await fetchImpl(url, {
                    signal: AbortSignal.timeout(timeoutMs),
                    headers: {
                        // The abbreviated doc is enough — only `versions`.
                        accept: "application/vnd.npm.install-v1+json, application/json",
                    },
                });
            } catch {
                return "unreachable";
            }
            if (res.status === 404) return "missing";
            if (!res.ok) return "unreachable";
            let doc: { versions?: Record<string, unknown> };
            try {
                doc = (await res.json()) as typeof doc;
            } catch {
                return "unreachable";
            }
            return Object.hasOwn(doc.versions ?? {}, pin.version)
                ? "ok"
                : "missing";
        }),
    );
    if (results.includes("unreachable")) return { kind: "unreachable" };
    const missing = pins.filter((_, i) => results[i] === "missing");
    return missing.length > 0 ? { kind: "missing", missing } : { kind: "ok" };
}

/**
 * The warning `create` prints when the pins cannot install. Speaks the
 * scaffold persona's language (a Next.js developer, not a knext contributor):
 * what will fail, why, and the ways out.
 *
 * Deliberately does NOT recommend re-running create with the latest published
 * CLI: whether that release can scaffold at all is a registry fact this
 * warning cannot know (at the time of writing it could not — the published
 * 0.3.0 ships neither the `create` verb nor the templates, #964), and a
 * remedy that fails is worse than none.
 */
export function unpublishedPinsWarning(missing: ScaffoldPin[]): string {
    const list = missing
        .map((p) => `  - ${p.name}@${p.version ?? p.range}`)
        .join("\n");
    return (
        "\nWARNING: this app depends on package versions that are not on the npm registry yet:\n" +
        `${list}\n` +
        "`npm install` will fail with 'notarget' until they are published. This usually\n" +
        "means the knext CLI you ran is newer than the latest published release (for\n" +
        "example, a build from a source checkout). Until a release carrying these\n" +
        "versions lands on the registry, either point the generated package.json at\n" +
        "locally packed tarballs of the same source tree (`file:` references), or wait\n" +
        "for the publish and run `npm install` then. The app's files themselves are\n" +
        "complete and correct.\n"
    );
}

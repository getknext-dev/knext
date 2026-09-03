/**
 * The build/runtime seam (ADR-0036 §"RuntimeContract applies to all three cells",
 * Track B1 of `docs/adr/drafts/bun14-runtime-vinext-builder-plan.md`).
 *
 * ## What this is for
 *
 * knext has two independent user choices — which **builder** produces the app,
 * and which **runtime** executes it. Historically those were modelled as an
 * enumerated matrix of (build, runtime) cells, each cell a special case, with a
 * cluster-side CEL rule to reject the invalid ones. That approach collapsed:
 * adding a builder meant editing a table, a validator and an admission rule, and
 * the matrix in the ADRs drifted away from what the code actually did.
 *
 * This module replaces the table with a **contract**. A builder declares the
 * SHAPE of artifact it emits; a runtime declares which shapes it can execute.
 * Compatibility is then a property of the contract — *"no runtime accepts a
 * shape it cannot execute"* — rather than a list someone must remember to update.
 *
 * ## Why the shape, and not the (build, runtime) pair, is the key
 *
 * ADR-0036 records the load-bearing observation: `RuntimeContract` applies to
 * every cell via exactly **TWO** implementations, and they are keyed by what the
 * builder emitted, not by which runtime runs it —
 *
 *   - `.next/standalone` → the supervisor **spawns** `server.js` as a child;
 *   - nitro `.output`    → an **in-process** entry, run directly.
 *
 * Both vinext cells (node+vinext and bun+vinext) share one implementation. That
 * is why the axes genuinely separate: the runtime is a *parameter* of executing
 * a shape, not a selector of an implementation. Two shapes, N runtimes.
 *
 * ## Scope
 *
 * This is the seam only. It deliberately does NOT add a `build` config key or
 * CRD field — that is B2, and it changes the public schema and the CRD, so it
 * needs the design gates. Adding the key before the seam existed is what would
 * reproduce the coupled-target problem with extra config.
 *
 * Only ONE builder exists today (`turbopack`); vinext is not yet a dependency.
 * The contract is written for two so that adding the second is an implementation
 * of an existing interface rather than a redesign.
 */

/**
 * What a builder emits. The unit of compatibility.
 *
 * Not an open string: a runtime must be able to answer "can I execute this?"
 * exhaustively, and an unknown shape has to be a compile error rather than a
 * silent `false`.
 */
export type ArtifactShape = "next-standalone" | "nitro-output-bun";

/**
 * NOTE on why the nitro shape carries its PRESET.
 *
 * An earlier version of this type had a preset-blind `"nitro-output"`, on the
 * strength of ADR-0036 prose saying the vinext output runs "on either runtime"
 * via nitro's node-server preset. A design gate MEASURED that and it is false
 * for the artifact this repo actually builds:
 *
 *   $ node examples/bun-exec/.output/server/index.mjs
 *   exit 1 — ReferenceError: Bun is not defined
 *
 * `.output/nitro.json` says `"preset": "bun"`; the entry calls that runtime's
 * global `serve()` at
 * module top level. A nitro `.output` is therefore not ONE shape — it is one
 * shape per preset, and the preset decides which runtimes can execute it.
 * Encoding the preset in the shape is what keeps `isCompatible` honest; a
 * node-preset build would be a DIFFERENT shape, added when something builds one.
 */

/** Which builder produced an artifact. */
export type BuilderId = "turbopack" | "vinext";

/** Which process executes it. Mirrors the shipped `runtime` config key. */
export type RuntimeId = "node" | "bun";

/**
 * How a runtime has to execute an entry. Part of the shape's contract, not the
 * runtime's choice — `.next/standalone` is spawned because it is a Next server
 * that owns its own listener, and the nitro output is in-process because the
 * compiled single-executable path has no child to spawn.
 */
export type ExecutionMode = "spawn" | "in-process";

/**
 * A concrete artifact, as handed from a builder to a runtime.
 *
 * `entry` is relative to `root` so the descriptor stays portable across the
 * build host and the container, which do not share a prefix — the mismatch
 * behind #857.
 */
export interface BuildArtifact {
    readonly shape: ArtifactShape;
    /** Directory `entry` resolves against (the app root inside the image). */
    readonly root: string;
    /** Path to the entry the runtime executes, relative to `root`. */
    readonly entry: string;
    readonly execution: ExecutionMode;
}

/** Produces an artifact of exactly one shape. */
export interface BuilderAdapter {
    readonly id: BuilderId;
    readonly emits: ArtifactShape;
    /**
     * Can this build of knext actually RUN this builder?
     *
     * Separate from being described, and the distinction is load-bearing. A
     * builder's artifact shape is knowable before its toolchain is a
     * dependency — that is what lets the contract be written for two
     * implementors while only one is installable, so adding the second is an
     * implementation rather than a redesign.
     *
     * The validator reports the two cases differently on purpose: an
     * unrecognised builder is a typo, an unavailable one is a real builder this
     * release cannot run. Telling someone selecting `vinext` to check their
     * spelling would be wrong and would waste their time.
     */
    readonly available: boolean;
    /**
     * Where this builder's output lands for an app rooted at `root`.
     * Pure — it describes the artifact, it does not run the build.
     */
    describeArtifact(root: string): BuildArtifact;
}

/** Executes artifacts of the shapes it accepts. */
export interface RuntimeAdapter {
    readonly id: RuntimeId;
    /** The shapes this runtime can execute. */
    readonly accepts: readonly ArtifactShape[];
}

/**
 * The invariant that replaces the CEL admission rule: a runtime may only be
 * paired with an artifact whose shape it accepts.
 *
 * Expressed as a total function over the contract rather than a list of
 * forbidden pairs, so a new builder or runtime cannot silently become "valid"
 * by nobody having remembered to forbid it.
 */
export function isCompatible(
    runtime: RuntimeAdapter,
    artifact: BuildArtifact,
): boolean {
    return runtime.accepts.includes(artifact.shape);
}

/**
 * Human-readable refusal, for the CLI validator and the operator's status
 * condition. Returns `null` when the pairing is fine, so callers branch on the
 * value rather than re-deriving the check and risking the two disagreeing.
 */
export function explainIncompatibility(
    runtime: RuntimeAdapter,
    artifact: BuildArtifact,
): string | null {
    if (isCompatible(runtime, artifact)) return null;
    return (
        `runtime '${runtime.id}' cannot execute a '${artifact.shape}' artifact ` +
        `(it accepts: ${runtime.accepts.join(", ") || "nothing"}). ` +
        "Choose a different runtime, or a builder that emits a shape this runtime accepts."
    );
}

/**
 * `next build` → `.next/standalone/server.js`, spawned by the supervisor.
 *
 * The default and the only all-apps-verified path. `node-server.ts` is its
 * runtime half; `STANDALONE_SERVER_PATH` overrides the entry there, and the
 * default below is that same value so the two cannot drift apart silently.
 */
export const turbopackBuilder: BuilderAdapter = {
    id: "turbopack",
    emits: "next-standalone",
    // RETIRED by ADR-0048. Kept described, not available: existing apps and CRs
    // still carry `build: turbopack`, and the validator needs to tell them what
    // to do rather than report an unknown builder. Removing the descriptor
    // would turn a migration message into a spelling error.
    available: false,
    describeArtifact(root: string): BuildArtifact {
        return {
            shape: "next-standalone",
            root,
            entry: ".next/standalone/server.js",
            execution: "spawn",
        };
    },
};

/**
 * vinext (the Vite/rolldown Next reimplementation) → a nitro `.output`, run
 * **in-process**.
 *
 * `available: true` — the ONLY available builder (ADR-0048). Both halves of
 * the pipeline exist: `cli/vinext-build.ts` produces the executable and the
 * scaffolded Dockerfile ships it. (An earlier revision of this docstring said
 * `available: false` because vinext was not yet a dependency; that era ended
 * when the toolchain landed, and `kn-next build` now compiles the binary
 * itself for the nitro shape.)
 *
 * The entry is nitro's **bun** preset output — `.output/nitro.json` carries
 * `"preset": "bun"` and the entry calls that runtime's global `serve()` at
 * module top level. It is therefore executable by bun and NOT by node.
 *
 * ADR-0036 says the opposite — that both vinext cells share one entry, `node
 * .output/server/index.mjs` for node and the `--compile`d binary for bun. That
 * is **false for the artifact this repo builds**, and it was the source of an
 * incorrect `nodeRuntime.accepts` entry until a design gate ran the file. The
 * claim is contradicted here rather than repeated, because it is exactly the
 * kind of confident prose that produced the defect.
 *
 * `execution: "in-process"` rather than `"spawn"`: unlike the standalone
 * server, there is no child to supervise, so SIGTERM draining has to be handled
 * in-process by the entry itself. That difference is a property of the SHAPE,
 * which is why it belongs on the artifact and not on the runtime.
 */
export const vinextBuilder: BuilderAdapter = {
    id: "vinext",
    emits: "nitro-output-bun",
    // ADR-0048: the ONLY supported target. Available because both halves now
    // exist — `cli/vinext-build.ts` produces the executable (vite build ->
    // nitro bun preset -> `bun build --compile --minify --bytecode`, floored at
    // Bun 1.4.0), and `templates/app/Dockerfile.vinext.hbs` ships it.
    available: true,
    describeArtifact(root: string): BuildArtifact {
        return {
            shape: "nitro-output-bun",
            root,
            entry: ".output/server/index.mjs",
            execution: "in-process",
        };
    },
};

/**
 * Node executes the standalone shape, which it spawns as a child. That is the
 * whole list.
 *
 * This docstring previously said "Node executes both shapes", citing ADR-0036,
 * and argued that ADR-0042 Decision 2's exclusion of `node + vinext` was policy
 * rather than capability. **Measured, the cell is not capable at all**: the
 * artifact this repo builds is a bun-preset nitro output, and running it under
 * node exits 1 with a missing-global error before serving anything.
 *
 * So there is no "can versus may" tension here to reason about. If something
 * later emits a node-preset nitro output, that is a NEW shape, and ADR-0042's
 * policy question revives at that point rather than having been quietly
 * retired — see `docs/adr/drafts/0048-draft-build-runtime-separation.md`.
 */
export const nodeRuntime: RuntimeAdapter = {
    id: "node",
    // NOT the nitro shape. This listed `nitro-output` until a design gate ran the
    // artifact: `node examples/bun-exec/.output/server/index.mjs` exits 1 with
    // `ReferenceError: Bun is not defined`, because the built entry is nitro's
    // BUN preset and calls that runtime's global `serve()` at module top level.
    //
    // The claim came from ADR-0036 prose ("vinext runs on either runtime — nitro
    // node-server preset for node"), not from measurement, and nothing in the
    // tree builds a node-preset output. Re-add a node-executable nitro shape
    // when something actually emits one; until then this would have made
    // `isCompatible` certify a pairing that crashes on boot.
    accepts: ["next-standalone"],
};

/**
 * Bun executes both shapes.
 *
 * `next-standalone` under Bun is not hypothetical: it is the shipped meaning of
 * `runtime: bun` today — see `config.ts`'s own wording, *"Runtime to execute the
 * Next.js standalone server.js: 'bun' or 'node'"* — with per-file bytecode
 * precompilation in `build.ts`. ADR-0036 describes this pairing as "rejected"
 * under a `bun ⇒ vinext` invariant that was never implemented; no such CEL rule
 * exists in the CRD. The contract records what the code does.
 */
export const bunRuntime: RuntimeAdapter = {
    id: "bun",
    accepts: ["next-standalone", "nitro-output-bun"],
};

/**
 * Every builder the contract knows about — including ones this release cannot
 * run. Callers that need "what can I actually select today" must filter on
 * `available`, which is what the CLI validator does.
 */
export const BUILDERS: readonly BuilderAdapter[] = [
    turbopackBuilder,
    vinextBuilder,
];

/** The builders this release can actually run. */
export const AVAILABLE_BUILDERS: readonly BuilderAdapter[] = BUILDERS.filter(
    (b) => b.available,
);

/** Every runtime the contract knows about. */
export const RUNTIMES: readonly RuntimeAdapter[] = [nodeRuntime, bunRuntime];

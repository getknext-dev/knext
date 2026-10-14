/**
 * Two facts about the build target that several commands resolve the same
 * way: the image arch `knext deploy`/`preview` build for, and the
 * self-contained mode. A leaf module (no imports), so a preflight can share the
 * exact resolver the compile step uses without importing the compile step.
 * `build-artifact.ts` re-exports both, so existing importers are unchanged.
 */

/**
 * The target arch `knext deploy`/`preview` build images for — always
 * `linux/amd64` (`dockerBuildxArgs`'s `--platform`), regardless of the host.
 * Shared with `build.ts`'s own `SHIP_ARCH` so the two names never drift.
 */
export const DEPLOY_SHIP_ARCH = "linux-x64";

/**
 * Resolve the self-contained mode: an explicit caller value (the
 * `--self-contained` CLI flag) wins over the `selfContained` config key, which
 * defaults to off. Opt-in only — nothing infers it.
 */
export function resolveSelfContained(
    config: { selfContained?: boolean },
    override?: boolean,
): boolean {
    return override ?? config.selfContained ?? false;
}

export const NEVER_SIDECAR: string[];
export const BUNDLED_PREFIX: string;

export function packageNameOf(spec: string): string;
export function isSidecarCandidate(spec: string): boolean;
export function isCommonJsEntry(sidecarNodeModules: string, spec: string): boolean | null;
export function sidecarShimSource(spec: string): string;
export function hasNativeAddon(pkgDir: string, depth?: number): boolean;

export const REQUIRE_CONDITIONS: string[];
export const IMPORT_CONDITIONS: string[];
export const SIDECAR_GLOBAL: string;

export function sidecarRoot(execPath?: string): string;
export function isBareRequest(request: unknown): boolean;
export function splitRequest(request: string): { name: string; subpath: string };
export function isSafeRequest(request: string): boolean;
export function isSafeExportsTarget(target: unknown): boolean;
export function isInside(file: string, root: string): boolean;
export function probeFile(base: string): string | null;
export function exportsTargets(exp: unknown, subpath: string, conditions: string[]): string[];
export function resolveInPackage(pkgDir: string, subpath: string, conditions: string[]): string | null;
export function findPackageDir(name: string, fromFile: string | undefined, root: string): string | null;
export function resolveSidecar(
    request: string,
    fromFile: string | undefined,
    root: string,
    conditions?: string[],
): string | null;
export function sidecarHas(name: string, root: string): boolean;
export function installSidecarResolution(
    Module: { _resolveFilename?: (request: string, parent?: unknown, ...rest: unknown[]) => unknown } | undefined,
    root?: string,
): boolean;
export function sidecarEntryFile(request: string, root?: string): string;

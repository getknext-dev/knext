export const HARFBUZZ_NOTICE_FILE: string;

export function harfbuzzNoticeText(hbWasm: string): string;

export const HARFBUZZ_MAX_BYTES: number;

export function vinextOgPackageJson(appRoot: string): string | undefined;

export function resolvePinnedHarfbuzzWasm(
    ogPkg: string,
    startPoints: readonly string[],
): { path: string; license: string | undefined } | { reason: string };

export function ogHarfbuzzWarning(reason: string): string;

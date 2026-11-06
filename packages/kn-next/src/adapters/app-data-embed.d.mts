export type AppDataFile = {
    rel: string;
    abs: string;
    size: number;
    declared: boolean;
    aliases: string[];
};

export type AppDataPlan = {
    files: AppDataFile[];
    totalBytes: number;
    skipped: { rel: string; reason: string }[];
    warnings: string[];
};

export type TraceRule = { includes: string[]; excludes: string[] };

export declare function readTraceRules(
    root: string,
): Promise<{ rules: TraceRule[]; candidateExcludes: string[] }>;

export type RouteMatcher = {
    kind: "picomatch" | "minimal";
    why?: string;
    matches: (key: string, route: string) => boolean;
};

export declare function loadRouteMatcher(root: string): RouteMatcher;

export declare function deriveTraceRules(
    includes: Record<string, string[]>,
    excludes: Record<string, string[]>,
    matcher?: RouteMatcher,
): TraceRule[];

export declare function globalExcludes(
    includes: Record<string, string[]>,
    excludes: Record<string, string[]>,
    matcher?: RouteMatcher,
): string[];

export declare function scanDataLiterals(source: string, cwdRoot: string, entryDir: string): string[];

export declare function planAppData(input: {
    root: string;
    includes?: string[];
    rules?: TraceRule[];
    candidates?: string[];
    candidateExcludes?: string[];
    sidecarPackages?: Iterable<string>;
}): AppDataPlan;

export declare function dataPathsMissing(binary: Uint8Array, files: { rel: string }[]): string[];

export declare function rewriteFsImports(
    source: string,
    prefix: string,
): { contents: string; count: number };

export declare function discoverDataLiterals(input: {
    serverDir: string;
    cwdRoot: string;
    entryDir: string;
}): string[];

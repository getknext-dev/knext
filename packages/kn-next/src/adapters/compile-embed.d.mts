export declare const EMBED_PROBE_ENV: "KNEXT_EMBED_PROBE";

export type EmbedPlan = {
    root: string;
    entrypoints: string[];
    relpaths: string[];
    report: { excluded: string[]; nonModule: string[]; unmatched: string[] };
};

export declare function embeddedPath(rel: string): string;

export declare function planEmbed(input: { root: string; include: string[]; exclude?: string[] }): EmbedPlan;

export declare function embedBuildOptions(
    plan: EmbedPlan,
    opts: {
        entry: string;
        outfile: string;
        includeSupported: boolean;
        format?: "esm" | "cjs";
        bytecode?: boolean;
        minify?: boolean;
        target?: string;
        extra?: Record<string, unknown>;
    },
): Record<string, unknown>;

export declare function runEmbedProbe(env?: Record<string, string | undefined>): void;

export declare function assertPathFidelity(binaryPath: string, relpaths: string[]): { ok: boolean; missing: string[] };

export declare function unembeddedDynamicReport(
    serverOutputDir: string,
): { file: string; computedSites: number; dynamicRequireBindings: string[] }[];

export declare function detectCompileInclude(): Promise<{ supported: boolean; evidence: string }>;

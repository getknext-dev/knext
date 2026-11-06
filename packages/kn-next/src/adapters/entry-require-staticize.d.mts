export function analyzeServerModule(
    src: string,
    analyzerPath?: string,
): {
    aliases: string[];
    requireBindings: string[];
    exports: Map<string, string[]>;
    imports: { from: string; names: Map<string, string> }[];
    literalCalls: Map<string, Set<string>>;
    nonLiteralCallees: Set<string>;
    declarationCounts: Map<string, number>;
    unrecognizedBinding: boolean;
    foldedRuntimeRequires: string[];
};

export function importedRequireEscapes(
    src: string,
    names: string[],
    analyzerPath?: string,
): boolean;

export function wrapRequireBindings(
    src: string,
    aliases: string[],
    embed: string[],
): { contents: string; count: number };

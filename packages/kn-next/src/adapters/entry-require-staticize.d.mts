export function isBareNonBuiltin(spec: string): boolean;

export function analyzeServerModule(src: string): {
    aliases: string[];
    requireBindings: string[];
    exports: Map<string, string[]>;
    imports: { from: string; names: Map<string, string> }[];
    literalCalls: Map<string, Set<string>>;
    nonLiteralCallees: Set<string>;
    unrecognizedBinding: boolean;
};

export function wrapRequireBindings(
    src: string,
    aliases: string[],
    embed: string[],
): { contents: string; count: number };

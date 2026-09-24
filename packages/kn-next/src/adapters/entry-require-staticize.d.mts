export function staticizeEntryRequires(
    src: string,
    canResolve: (spec: string) => boolean,
): { contents: string; rewritten: string[]; unresolved: string[] };

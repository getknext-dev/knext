export declare function maskCommentsAndStrings(src: string): string;

export declare function computedRequireSites(src: string): { index: number; callee: string }[];

export declare function literalRequireClosure(roots: string[], within: string): Set<string>;

export declare function computedRequireInventory(
    files: Iterable<string>,
    baseDir: string,
): Record<string, number>;

export declare function moduleDisposition(
    path: string,
    ctx: { root: string; diskClosure: Set<string> },
): { real: string; where: "external" | "disk" | "bundle" };

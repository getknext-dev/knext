export function findRealImportMeta(
    src: string,
): { start: number; end: number; propEnd: number; prop: string | null }[];

export function rewriteImportMeta(
    src: string,
    exprs: { entryUrlExpr: string; entryFileExpr: string; entryDirExpr: string },
): { contents: string; rewritten: number };

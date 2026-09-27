export declare const NATIVE_ROOT_KEY: unique symbol;

export declare function extractEmbeddedNative(input: {
    files: { rel: string; path: string }[];
    tmpRoot?: string;
}): { root: string; extracted: number; reused: number };

export declare function lazySharp<T>(load: () => T): T;

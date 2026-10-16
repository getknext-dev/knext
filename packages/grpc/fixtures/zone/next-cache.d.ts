// Stand-in for the part of Next.js's `next/cache` the generated code calls,
// so the fixture's generated code type-checks outside a Next.js app. The real
// module is exercised by the two-user test, which builds the code with Next.js.
declare module 'next/cache' {
  export function cacheLife(profile: {
    stale?: number;
    revalidate?: number;
    expire?: number;
  }): void;
  export function cacheTag(...tags: string[]): void;
  export function updateTag(tag: string): void;
}

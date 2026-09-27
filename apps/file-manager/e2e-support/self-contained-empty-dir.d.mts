// Declarations for self-contained-empty-dir.mjs (a plain .mjs so it runs as a
// CLI under bun; this file types it for self-contained-e2e.test.ts).
import type { ChildProcess } from 'node:child_process';

export type RouteResult =
  | { status: number; bytes: number; type: string }
  | { skipped: string }
  | { error: string };

export interface Stage {
  dir: string;
  exec: string;
}

export interface ArmResult {
  binaryBytes: number;
  bootMs: number[];
  bootMedianMs: number;
  served: Record<string, RouteResult>;
  output: string;
}

export declare function routesFromManifests(nextDir: string): string[];
export declare function isDynamicRoute(route: string): boolean;
export declare function firstStaticAsset(nextDir: string): string | undefined;
export declare function stageSelfContained(opts: {
  nextDir: string;
  binary: string;
  publicDir?: string;
  nativeDir?: string;
}): Stage;
export declare function stageDisk(opts: {
  nextDir: string;
  binary: string;
  publicDir?: string;
}): Stage;
export declare function freePort(): Promise<number>;
export declare function boot(
  exec: string,
  opts?: { readyPath?: string; timeoutMs?: number; env?: Record<string, string> },
): Promise<{ child: ChildProcess; port: number; bootMs: number; output: () => string }>;
export declare function stop(child: ChildProcess): Promise<void>;
export declare function serveAll(
  port: number,
  routes: readonly string[],
  staticAsset?: string,
): Promise<Record<string, RouteResult>>;
export declare function measureArm(
  stage: Stage,
  opts: {
    routes: readonly string[];
    staticAsset?: string;
    runs: number;
    env?: Record<string, string>;
  },
): Promise<ArmResult>;
export declare function isServed(r: RouteResult | undefined): boolean;

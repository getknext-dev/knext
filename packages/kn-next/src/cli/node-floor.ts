/**
 * The Node.js floor — typed twin of `node-floor-guard.cjs`.
 *
 * The guard runs first at CLI start (dependency-free CJS, so it works on a Node
 * too old for the rest of the bundle). This module gives the rest of the CLI
 * (the `doctor` row) the same floor and the same message without importing the
 * CJS file, whose relative path would not survive being hoisted into a shared
 * chunk. `__tests__/node-floor.test.ts` asserts the two agree.
 */

export const NODE_FLOOR_MAJOR = 24;

export interface NodeFloorVerdict {
    ok: boolean;
    message: string;
}

/** Whether `version` (a `process.versions.node` string) clears the floor. Unreadable fails closed. */
export function checkNodeFloor(version: string): NodeFloorVerdict {
    const major =
        typeof version === "string"
            ? /^v?(\d+)(?:\.|$)/.exec(version.trim())
            : null;
    return {
        ok: major !== null && Number(major[1]) >= NODE_FLOOR_MAJOR,
        message: `knext requires Node.js ${NODE_FLOOR_MAJOR} or later; you are running ${version}. Upgrade Node: https://nodejs.org`,
    };
}

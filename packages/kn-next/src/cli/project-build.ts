/**
 * The one seam for running the project's build script (UX ledger row 4, 4c).
 *
 * Both deploy and build invoke `npm run build` (which runs `next build`,
 * output:'standalone'). When the app's dependencies are not installed yet,
 * npm's shell cannot find `next` and exits 127 — and that used to render as
 * FATAL + a serialized Error object, because the #810 friendly-error contract
 * covered USAGE mistakes only. For the zero-cloud persona the answer is one
 * sentence: run `npm install` first.
 *
 * A guard test (project-build.test.ts) scans src/cli for raw
 * `["npm", "run", "build"]` spawns so the translation cannot drift by one
 * caller re-inlining the command.
 */

import { runQuiet } from "./exec";
import { UsageError } from "./shared";

/** Exit code every POSIX shell uses for "command not found". */
const EXIT_COMMAND_NOT_FOUND = 127;

const MISSING_NEXT_MESSAGE = `The build could not run: the \`next\` command was not found.

That usually means this app's dependencies are not installed yet.
Run \`npm install\` in this directory, then try again.`;

/**
 * Run `npm run build`, translating the deps-not-installed failure (exit 127)
 * into plain guidance. Raised through the UsageError FAMILY deliberately:
 * that is the CLI's friendly write-and-exit rendering path — an expected
 * local-environment state prints as a message and exit 1, never as
 * `log.fatal({ err })` with a stack and a dist chunk path. Any other build
 * failure is rethrown untouched — `next build`'s own stderr is already on
 * screen (stderr is inherited), and dressing a real build break up as
 * guidance would hide it.
 *
 * @param run - injectable for tests; the real runner inherits stderr, so the
 *              shell's own `next: command not found` line appears right above
 *              the guidance.
 */
export function runProjectBuild(
    run: (argv: readonly string[]) => void = runQuiet,
): void {
    try {
        run(["npm", "run", "build"]);
    } catch (err) {
        if (
            typeof err === "object" &&
            err !== null &&
            (err as { status?: unknown }).status === EXIT_COMMAND_NOT_FOUND
        ) {
            throw new UsageError(MISSING_NEXT_MESSAGE);
        }
        throw err;
    }
}

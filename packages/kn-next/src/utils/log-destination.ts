/**
 * Process-local choice of where the framework logger writes.
 *
 * Deliberately NOT an environment variable: an env var is inherited by every
 * child process (kubectl, docker, the bun compile) and persists for programmatic
 * use. This is module state, internal to the CLI, and lives in its own module so
 * a CLI command can call it without importing the logger itself.
 *
 * A command that prints a machine-readable document on stdout (`deploy
 * --dry-run`'s NextApp CR) calls `setLogDestination("stderr")` first; the logger
 * re-resolves on the next emit, so a call made after an earlier log still wins.
 */
export type LogDestination = "stdout" | "stderr";

let destination: LogDestination = "stdout";

export function setLogDestination(d: LogDestination): void {
    destination = d;
}

export function getLogDestination(): LogDestination {
    return destination;
}

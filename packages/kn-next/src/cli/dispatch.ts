/**
 * What the bin does with its FIRST argument (ADR-0046).
 *
 * Two behaviours, deliberately separated:
 *
 *   - A bare `kn-next` and a flags-only `kn-next --skip-build` **deploy**. That
 *     is the advertised front door (`npx @getknext/core` in every README
 *     example) and the ADR ratifies it rather than changing it. A leading `-`
 *     is a flag, never a verb.
 *   - An unrecognised first token is an **error**, not a silent deploy. Before
 *     ADR-0046, `kn-next deplyo --dry-run` ran a full deploy, and once
 *     `cleanup` became a routed verb, `kn-next celanup` did too — a typo in a
 *     teardown command shipping a deploy is the same hazard class this CLI
 *     surface work set out to remove.
 *
 * Pure functions with no I/O so the contract is unit-testable; the bin does the
 * writing and the exiting.
 */

import { COMMAND_GROUPS } from "./help";

/**
 * Every verb the bin accepts, derived from the ONE command list that also
 * renders `--help` — never a second enumeration to keep in sync.
 */
export const KNOWN_VERBS: ReadonlySet<string> = new Set(
    COMMAND_GROUPS.flatMap((g) => g.commands.map((c) => c.verb)),
);

export type Invocation =
    | { kind: "deploy" }
    | { kind: "verb"; verb: string }
    | { kind: "unknown"; input: string };

/** Classify the bin's first argument. */
export function resolveInvocation(token: string | undefined): Invocation {
    // No subcommand, or a flag — the historical, advertised default.
    if (token === undefined || token.startsWith("-")) {
        return { kind: "deploy" };
    }
    if (token === "deploy") {
        return { kind: "deploy" };
    }
    if (KNOWN_VERBS.has(token)) {
        return { kind: "verb", verb: token };
    }
    return { kind: "unknown", input: token };
}

/** Classic Levenshtein distance (iterative, one row of state). */
function distance(a: string, b: string): number {
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const row = [i];
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            row[j] = Math.min(
                (row[j - 1] ?? 0) + 1,
                (prev[j] ?? 0) + 1,
                (prev[j - 1] ?? 0) + cost,
            );
        }
        prev = row;
    }
    return prev[b.length] ?? Math.max(a.length, b.length);
}

/**
 * The nearest known verb, or undefined when nothing is close enough.
 *
 * The tolerance scales with input length (1 edit for short tokens, 2 for
 * longer) so `gc` cannot absorb every two-letter typo and `xyzzy` gets no
 * suggestion at all — a confidently wrong "did you mean" is worse than none.
 */
export function suggestVerb(input: string): string | undefined {
    if (input.length < 2) {
        return undefined;
    }
    const tolerance = input.length <= 4 ? 1 : 2;
    let best: string | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const verb of KNOWN_VERBS) {
        const d = distance(input, verb);
        if (d < bestDistance) {
            best = verb;
            bestDistance = d;
        }
    }
    return bestDistance <= tolerance ? best : undefined;
}

/**
 * The message for a stray positional on the DEFAULT deploy path.
 *
 * `parseArgs` accepted positionals and ignored them, so `kn-next -n prod
 * cleanup` deployed to prod with the verb silently swallowed — the same
 * "opposite action" hazard as an unknown first token, reached through the
 * flags-first door. When the swallowed word IS a verb, the fix the user needs
 * is word order, so say that first.
 */
export function formatStrayPositional(token: string): string {
    const display =
        token === "" || /\s/.test(token) ? JSON.stringify(token) : token;
    const lines = [`unexpected argument: ${display}`, ""];
    if (KNOWN_VERBS.has(token)) {
        lines.push(
            `\`${token}\` is a command, and the command comes first:`,
            `  kn-next ${token} [options]`,
        );
    } else {
        const suggestion = suggestVerb(token);
        if (suggestion) {
            lines.push(
                `Did you mean the \`${suggestion}\` command? It comes first:`,
                `  kn-next ${suggestion} [options]`,
            );
        } else {
            lines.push(
                "kn-next deploy takes no positional arguments — the app it deploys",
                "comes from kn-next.config.ts in the current directory.",
            );
        }
    }
    lines.push("", "Run `kn-next --help` to see the available commands.");
    return `${lines.join("\n")}\n`;
}

/**
 * The message for an unrecognised command: what was typed, the nearest verb if
 * there is a credible one, and where the full list is. No stack, exit 1.
 */
export function formatUnknownCommand(input: string): string {
    const suggestion = suggestVerb(input);
    const display =
        input === "" || /\s/.test(input) ? JSON.stringify(input) : input;
    return `${[
        `unknown command: ${display}`,
        ...(suggestion ? ["", `Did you mean: kn-next ${suggestion}?`] : []),
        "",
        "Run `kn-next --help` to see the available commands.",
    ].join("\n")}\n`;
}

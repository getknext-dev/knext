/**
 * Shared value formatting for the in-app observability pages (ADR-0038).
 *
 * The single rule this module exists to enforce: **"no data yet" must never look
 * like a measured value.** A dash (`—`) reads like a rendered zero at a glance,
 * which is exactly the confusion the P1.2 sign-off flagged: an operator cannot
 * tell "the app served zero requests" from "nothing has been recorded / the
 * series does not exist". So absent samples render the explicit {@link NO_DATA}
 * marker, and a real `0` renders as `0` — everywhere, on every page.
 */

/** Explicit marker for "the series produced no sample" (never a measured zero). */
export const NO_DATA = 'no data yet';

/** A duration in seconds rendered as whole milliseconds, or the no-data marker. */
export function formatMillis(seconds: number | null): string {
  return seconds === null ? NO_DATA : `${(seconds * 1000).toFixed(0)} ms`;
}

/** A number rendered with fixed precision + unit suffix, or the no-data marker. */
export function formatNumber(value: number | null, digits: number, unit = ''): string {
  return value === null ? NO_DATA : `${value.toFixed(digits)}${unit}`;
}

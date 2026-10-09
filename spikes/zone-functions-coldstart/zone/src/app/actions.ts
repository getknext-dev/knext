'use server';

import { callFn, defaultHttpVersion } from '../lib/fn';

// The Server Action shape the v2 generator will emit. The bench drives the
// route handler (same callFn) because it can be timed with a plain GET; this
// action exists to show the client works from an action too.
export async function pingAction(fn: string) {
  return callFn(fn, defaultHttpVersion(fn));
}

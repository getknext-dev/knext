import { cookies } from 'next/headers';
import { Suspense } from 'react';

/**
 * compat-smoke FIXTURE — Streaming/Suspense flush (check j) + Server Action round-trip (check i).
 *
 * This route exists ONLY so `scripts/compat-smoke.mjs` can assert two capabilities that the
 * matrix previously listed with no red-on-fail evidence (docs/compat-matrix.md):
 *
 *   (j) the shell flushes BEFORE the Suspense boundary resolves — asserted on CHUNK ARRIVAL
 *       ORDERING, not on the final body (a fully buffered response reproduces the final body
 *       byte-for-byte, so asserting the body proves nothing).
 *   (i) a `'use server'` action, invoked over the no-JS progressive-enhancement form POST,
 *       actually executes and its effect is observable on a subsequent render.
 *
 * Security note (security.md — "no unauthenticated mutating endpoints"): the action below
 * changes NO server-side state. Its only effect is a cookie on the caller's own response, so
 * it is not a mutating endpoint — one client can never observe or affect another's value.
 */

export const dynamic = 'force-dynamic';

/** Marker cookie the Server Action writes; the render below reads it back. */
const ECHO_COOKIE = 'knext-smoke-echo';

/** How long the Suspense boundary takes to resolve. The smoke check requires the shell to
 *  arrive in an EARLIER chunk, at least 300 ms before this content lands. */
const LATE_MS = 800;

async function echoAction(formData: FormData) {
  'use server';
  const value = String(formData.get('knextEcho') ?? '');
  // Caller-scoped only: no module state, no database, no shared cache.
  const store = await cookies();
  store.set(ECHO_COOKIE, value, { httpOnly: true, sameSite: 'lax', path: '/' });
}

async function LateContent() {
  await new Promise((resolve) => setTimeout(resolve, LATE_MS));
  return <div id="knext-stream-late">knext-stream-late</div>;
}

export default async function KnextSmokeStreamPage() {
  const store = await cookies();
  const echo = store.get(ECHO_COOKIE)?.value ?? 'none';

  return (
    <main className="p-8">
      <h1 className="text-xl font-bold">knext compat-smoke fixture</h1>
      <div id="knext-stream-shell">knext-stream-shell</div>
      {/* Exposed as an ATTRIBUTE, not a text node — React splits a dynamic text child with a
          `<!-- -->` separator on some render paths, which would make it un-greppable. */}
      <div id="knext-action-echo" data-knext-action-echo={echo}>
        knext-action-echo
      </div>
      <form action={echoAction}>
        <input type="hidden" name="knextEcho" defaultValue="" />
        <button type="submit">echo</button>
      </form>
      <Suspense fallback={<div id="knext-stream-fallback">knext-stream-fallback</div>}>
        <LateContent />
      </Suspense>
    </main>
  );
}

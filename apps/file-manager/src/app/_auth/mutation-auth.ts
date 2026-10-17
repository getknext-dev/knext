import { headers } from 'next/headers';
import { isAuthorized } from '../api/cache/invalidate/auth';

/**
 * The check every state-changing Server Action in the file-manager runs FIRST.
 *
 * A `'use server'` export is a public POST endpoint — anyone who can reach the
 * app can invoke it, with or without the page that renders its form — so a
 * Server Action needs the same authentication as a mutating route handler
 * (security.md: no unauthenticated mutating endpoints).
 *
 * The credential is the app's one admin Bearer token, `CACHE_INVALIDATE_TOKEN`
 * (a K8s Secret; the same value the cache routes use), with the same rules as
 * `isAuthorized`: **fail-closed** when it is unset or empty, and a constant-time
 * compare. It can arrive two ways:
 *
 * - `Authorization: Bearer <token>` — scripts and tests;
 * - a `token` field in the submitted form — the browser path, since a plain
 *   `<form>` cannot set request headers.
 *
 * Copy this pattern into your own app: call it as the first statement of every
 * exported action and return/throw before touching anything if it says no.
 *
 * ```ts
 * export async function myAction(formData: FormData) {
 *   if (!(await authorizeMutation(formData))) return { error: 'Unauthorized' };
 *   // ... writes ...
 * }
 * ```
 */
export async function authorizeMutation(formData?: FormData | null): Promise<boolean> {
  const expected = process.env.CACHE_INVALIDATE_TOKEN;
  if (!expected) return false; // unconfigured = deny all

  let header: string | null = null;
  try {
    header = (await headers()).get('authorization');
  } catch {
    // No request scope to read headers from: fall through to the form field.
    header = null;
  }
  if (isAuthorized(header, expected)) return true;

  const field = formData?.get('token');
  if (typeof field === 'string' && field !== '') {
    return isAuthorized(`Bearer ${field}`, expected);
  }
  return false;
}

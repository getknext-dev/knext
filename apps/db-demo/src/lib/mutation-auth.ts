import { timingSafeEqual } from 'node:crypto';
import { headers } from 'next/headers';

/**
 * The check every state-changing Server Action in db-demo runs FIRST.
 *
 * A `'use server'` export is a public POST endpoint: anyone who can reach the app
 * can call it, with or without the page that renders its form. So a Server Action
 * that writes needs authentication, and it must fail closed.
 *
 * The credential is one write token, `DB_DEMO_WRITE_TOKEN` (provision it from a
 * Kubernetes Secret, never from config or an image). **Unset or empty means
 * nothing is authorized.** It is compared in constant time. It arrives as
 * `Authorization: Bearer <token>` (scripts) or as a `token` form field (the
 * browser, since a plain `<form>` cannot set headers).
 *
 * Copy this pattern into your own app:
 *
 * ```ts
 * export async function myAction(formData: FormData) {
 *   if (!(await authorizeMutation(formData))) throw new Error('Unauthorized');
 *   // ... writes ...
 * }
 * ```
 */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false; // timingSafeEqual needs equal lengths
  return timingSafeEqual(a, b);
}

export async function authorizeMutation(formData?: FormData | null): Promise<boolean> {
  const expected = process.env.DB_DEMO_WRITE_TOKEN;
  if (!expected) return false; // unconfigured = deny all

  let header: string | null = null;
  try {
    header = (await headers()).get('authorization');
  } catch {
    // No request scope to read headers from: fall through to the form field.
    header = null;
  }
  if (header?.startsWith('Bearer ') && tokenMatches(header.slice('Bearer '.length), expected)) {
    return true;
  }

  const field = formData?.get('token');
  return typeof field === 'string' && field !== '' && tokenMatches(field, expected);
}

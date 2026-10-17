'use server';

import { redirect } from 'next/navigation';
import { authorizeMutation } from '../_auth/mutation-auth';
import { setupDatabase } from './setup-database';

/**
 * Initialise the demo database. This used to run on every GET of /setup, which
 * let a crawler, a link prefetch or a cross-site request create tables and seed
 * data with no credential. It is now a Server Action (a POST) and, like every
 * export of a 'use server' module, starts with the auth check: nothing below it
 * runs for a caller without the admin token.
 *
 * The result goes back as a redirect to the read-only /setup page, so the
 * success/failure message is rendered by a GET that writes nothing.
 */
export async function runSetup(formData: FormData) {
  if (!(await authorizeMutation(formData))) {
    throw new Error('Unauthorized');
  }
  const result = await setupDatabase();
  redirect(result.success ? '/setup?done=1' : '/setup?failed=1');
}

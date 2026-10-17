'use server';

import { revalidatePath } from 'next/cache';
import { addMessage } from '@/db/queries';
import { authorizeMutation } from '@/lib/mutation-auth';

/**
 * The writer path: a form-bound server action. It writes on `getDb()` (via
 * {@link addMessage}), then revalidates `/` so the next render reads its own
 * write. Single-writer + read-your-writes — exactly the SDK's writer contract.
 *
 * Like every export of a `'use server'` module it is a public POST endpoint, so
 * the first statement refuses any caller without the write token (fail-closed
 * when `DB_DEMO_WRITE_TOKEN` is unset) before anything is read or written.
 */
export async function postMessage(formData: FormData): Promise<void> {
  if (!(await authorizeMutation(formData))) {
    throw new Error('Unauthorized');
  }
  const author = String(formData.get('author') ?? '').trim() || 'anonymous';
  const body = String(formData.get('body') ?? '').trim();
  if (!body) return; // nothing to persist
  await addMessage({ author, body });
  revalidatePath('/');
}

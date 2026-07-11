'use server';

import { revalidatePath } from 'next/cache';
import { addMessage } from '@/db/queries';

/**
 * The writer path: a form-bound server action. It writes on `getDb()` (via
 * {@link addMessage}), then revalidates `/` so the next render reads its own
 * write. Single-writer + read-your-writes — exactly the SDK's writer contract.
 */
export async function postMessage(formData: FormData): Promise<void> {
  const author = String(formData.get('author') ?? '').trim() || 'anonymous';
  const body = String(formData.get('body') ?? '').trim();
  if (!body) return; // nothing to persist
  await addMessage({ author, body });
  revalidatePath('/');
}

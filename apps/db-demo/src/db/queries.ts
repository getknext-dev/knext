/**
 * Data-access for db-demo — the read/write split the SDK is built around.
 *
 * These are plain async functions (no `'use server'`, no `next/*`) so they import
 * and unit-test cleanly, and are called from both the server component (read) and
 * the server action (write). The client choice is explicit, never auto-routed:
 *
 *   • {@link listMessages} → `getDbRO()` — a staleness-tolerant list read on the
 *     bounded-stale (~9s) RO gateway; falls back to the writer + warns if
 *     `DATABASE_URL_RO` is unset (an app without a read replica still works).
 *   • {@link addMessage}   → `getDb()`   — the single-writer path; the next
 *     `getDb()` read sees the row (read-your-writes).
 */
import { desc, getDb, getDbRO } from '@knext/db';
import { type Message, messages, type NewMessage } from './schema';

/** Newest-first list of messages, from the read-only replica (bounded-stale). */
export function listMessages(limit = 50): Promise<Message[]> {
  return getDbRO({ messages })
    .select()
    .from(messages)
    .orderBy(desc(messages.createdAt))
    .limit(limit);
}

/** Insert one message on the writer and return the persisted row (read-your-writes). */
export async function addMessage(input: NewMessage): Promise<Message> {
  const [row] = await getDb({ messages }).insert(messages).values(input).returning();
  return row;
}

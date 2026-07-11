/**
 * db-demo schema — the single source of truth for the app's tables.
 *
 * Everything is imported from `@knext/db/schema` (a thin re-export of drizzle's
 * `pg-core`), so the app has one pinned-compatible drizzle dependency and
 * drizzle's own schema docs apply directly. One table keeps the example minimal.
 */
import { pgTable, serial, text, timestamp } from '@knext/db/schema';

export const messages = pgTable('messages', {
  id: serial('id').primaryKey(),
  author: text('author').notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// Typed rows for free — the query + action modules import these.
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

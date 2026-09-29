# @getknext/db

The typed data SDK for knext apps—a thin [drizzle-orm](https://orm.drizzle.team) wrapper over Postgres pools provisioned by the knext operator. Define your schema once, query with drizzle's full API, and migrate with a single command.

## Install

```bash
npm install @getknext/db
```

## Quickstart

Define your schema in `src/db/schema.ts`:

```typescript
import { pgTable, serial, text, timestamp } from '@getknext/db/schema';

export const orders = pgTable('orders', {
  id: serial('id').primaryKey(),
  userId: text('user_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
```

Query with the client you need:

```typescript
import { getDb, getDbRO, eq } from '@getknext/db';
import { orders } from '@/db/schema';

// Write and read-your-write
await getDb().insert(orders).values({ userId: 'user-123' });

// Staleness-tolerant read
const recent = await getDbRO().select().from(orders).where(eq(orders.userId, 'user-123'));
```

- **`getDb()`** — writer over `DATABASE_URL` for all writes and reads that must see their own write.
- **`getDbRO()`** — read-only over `DATABASE_URL_RO` for analytics and fan-out queries (tolerates ≤ ~9s staleness).

## Supported platforms

| Runtime | Turbopack | Webpack |
|---------|-----------|---------|
| Node.js | ✓ | ✓ |
| Bun     | ✓ | ✓ |

Tested against Next.js 16.2.12. See the [compatibility page](https://knext.dev/docs/compatibility) for complete version coverage.

## Learn more

- [Documentation](https://knext.dev) — guides, schema definition, and migration recipes
- [Compatibility](https://knext.dev/docs/compatibility) — supported runtimes and Next.js versions
- [Security](https://knext.dev/docs/security) — threat model and hardening
- [Contributing](https://github.com/getknext-dev/knext/blob/main/CONTRIBUTING.md) — report issues and contribute

## License

[Apache-2.0](./LICENSE)

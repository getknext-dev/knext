import { defineDrizzleConfig } from '@knext/db/migrate';

/**
 * drizzle-kit config for db-demo. `defineDrizzleConfig()` wires dialect
 * `postgresql`, the knext path conventions (`./src/db/schema.ts` → `./drizzle`),
 * and the **writer** `DATABASE_URL` (never the RO replica — migrations are
 * writer-only, ADR-0021 §3). `drizzle-kit generate` needs no live database.
 */
export default defineDrizzleConfig();

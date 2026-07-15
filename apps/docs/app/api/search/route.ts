import { createFromSource } from 'fumadocs-core/search/server';
import { source } from '@/lib/source';

// Build-time search index served at /api/search — the Fumadocs search dialog
// queries this endpoint. Without it the search box returns nothing.
export const { GET } = createFromSource(source);

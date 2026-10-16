// The signed-in user of the request being served. The e2e zone has no session
// store: the request's `sub` query parameter stands in for the user a real app's
// authorize() would verify, and is read by authorize() through this store.
import { AsyncLocalStorage } from 'node:async_hooks';

export const user = new AsyncLocalStorage<{ readonly sub: string }>();

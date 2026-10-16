// The e2e zone's authorize() hook. A real app verifies its own session here; this
// one returns the `sub` the request handler put in the request context, and
// refuses when there is none, so a generated call can never run without a user.
import type { AuthorizeContext, Principal } from '@getknext/grpc/runtime';
import { user } from './context';

export async function authorize(_ctx: AuthorizeContext): Promise<Principal> {
  const current = user.getStore();
  if (!current) throw new Error('no signed-in user for this request');
  return { sub: current.sub };
}

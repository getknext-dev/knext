// The fixture zone's authorize() hook. A real app verifies its own session
// here (a cookie, a header) and throws when there is no signed-in user.
import type { AuthorizeContext, Principal } from '@getknext/grpc/runtime';

export async function authorize(_ctx: AuthorizeContext): Promise<Principal> {
  throw new Error('fixture: no signed-in user');
}

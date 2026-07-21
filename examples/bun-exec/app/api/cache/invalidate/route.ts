// RuntimeContract §5 / security.md hard rule: a mutating endpoint MUST be
// authenticated and fail CLOSED. This proves the rule is expressible on the
// bun-exec target — the Bearer check is shared with the runtime entry
// (`runtime-contract.mjs`) so the binary and the tests enforce identical logic.
//
// Without a valid `Authorization: Bearer <CACHE_INVALIDATE_TOKEN>` header this
// returns 401 and does nothing; an unset server token also denies (never opens).
import { checkBearer } from '../../../../runtime-contract.mjs';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const denied = checkBearer(req, process.env.CACHE_INVALIDATE_TOKEN);
  if (denied) return denied;

  // Authorised. A real app would enqueue an ISR/data-cache invalidation here.
  return Response.json({ invalidated: true });
}

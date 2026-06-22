# Mutating-endpoint audit (E4-2)

> Invariant (security.md, CLAUDE.md §7): **no unauthenticated mutating endpoint.** Any
> route/handler/webhook that changes state must require auth — a signed token and/or an
> internal-only `NetworkPolicy`. This doc is the audit of record; keep it current when adding
> any state-changing handler.

Last audited: 2026-06-21.

## Method
Enumerated every state-changing HTTP handler and admission webhook:

```bash
# App Router route handlers that mutate (POST/PUT/DELETE/PATCH, plus mutating GETs)
grep -rln 'export async function \(POST\|PUT\|DELETE\|PATCH\)' apps/*/src/app/api
# Operator admission webhooks
grep -rln 'webhook\|Mutate\|Validate.*admission' packages/kn-next-operator/internal
```

## Endpoints

| Endpoint | Method | Mutates | Auth | Status |
|---|---|---|---|---|
| `/api/cache/invalidate` | POST | Next.js cache (`revalidateTag`) | Bearer token `CACHE_INVALIDATE_TOKEN`, fail-closed (`isAuthorized`) | ✅ authed |
| `/api/cache/events` | DELETE | clears all cache events (Redis / in-memory) | same Bearer token (reuses the single `isAuthorized` helper) | ✅ authed (E4-2) |

There is intentionally **no `GET /api/cache/invalidate`** handler (#78): invalidation mutates state,
and a mutating GET is prefetchable/link-triggerable and leaks the Bearer token into URLs and logs.
App Router returns 405 for the unexported GET method; POST is the only invalidation entrypoint.

Read-only handlers (no auth required, by design): `GET /api/cache/events`, `GET /api/health`,
`GET /api/metrics`, `GET /api/audit`, `GET /api/cache-stats`. These disclose operational data only —
if any later exposes sensitive data, gate it too.

**Operator admission webhooks:** none yet. When validating/defaulting webhooks land (E3-4), add them
here; admission is the operator's mutating surface.

## Auth mechanism
- One helper: `apps/file-manager/src/app/api/cache/invalidate/auth.ts` → `isAuthorized(authHeader, expectedToken)`.
- **Fail-closed:** unauthorized when the token is unset/empty; constant-time compare (`timingSafeEqual`).
- Token is provisioned as a K8s Secret → `CACHE_INVALIDATE_TOKEN` env var; never in config/image/URL.
- Tests: `invalidate/auth.test.ts` (helper) + `events/route.test.ts` (the DELETE guard, 4 cases).

## Remaining (defense-in-depth)
- **Internal-only `NetworkPolicy`** so these endpoints aren't reachable from outside the namespace even
  with a leaked token (operator-applied; tracked under E4-1/E4-4).
- **CI guard** so a new open mutating handler fails the build. Ready-to-wire check: every file under
  `apps/*/src/app/api` that exports `POST|PUT|DELETE|PATCH` must contain `isAuthorized` (or be listed
  here as an explicit, justified exception).

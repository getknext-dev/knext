import { AccessDenied } from './_ui/access-denied';

/**
 * The `unauthorized.tsx` file convention for the `/observability` segment (#525):
 * what Next renders — with a real HTTP 401 — when a page under this segment
 * calls `denyObservabilityAccess()`. The markup itself lives in the one shared
 * component, so the wording and the status can only ever change together.
 */
export default function ObservabilityUnauthorized() {
  return <AccessDenied />;
}

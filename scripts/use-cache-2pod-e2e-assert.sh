#!/usr/bin/env bash
# Assertions for the `'use cache'` two-pod kind e2e: two pods of ONE Knative
# Service share a `'use cache'` entry and its tag invalidation through ONE real
# Redis.
#
# Shared by .github/workflows/use-cache-2pod-kind-e2e.yml and a local run against
# any kind cluster that already has the operator, Knative, a `redis` Deployment
# in the app namespace and the fixture app deployed with minScale >= 2:
#
#   scripts/use-cache-2pod-e2e-assert.sh <namespace> <nextapp-name>
#
# Every request is pinned to ONE pod through `kubectl port-forward pod/<name>`
# (the pod's own container port, bypassing the load-balanced Service), so a pass
# cannot be one pod answering twice. The cached route reports the pod that BUILT
# the entry (`cached.computedBy`), the pod that SERVED the response (`servedBy`)
# and how many entries the serving pod has built (`computesInThisPod`); a
# counter-only route (`/api/uc/stats`) gives an exact per-pod baseline. So "no
# recompute" is observed, not inferred from a matching timestamp, and the script
# is re-runnable against the same pods (it resets the entry first).
#
# The users section then reads a per-user `'use cache'` function
# (`/api/uc/user/<user>`, the user passed as the function's ARGUMENT) for two
# users on both pods: each user gets its own entry, pod B serves pod A's entry
# for each, and invalidating one user's tag leaves the other's entry alone. A
# user served another user's entry fails with "(cache keys collapsed)" -- the
# message the lane's `collapsed-keys` leg (knext's entry key collapsed in the
# shipped tarball by scripts/use-cache-collapse-keys-mutation.mjs) must hit.
#
# Fail-closed throughout: every check exits non-zero with an ::error:: line, and
# an empty / unparseable value is a failure, never a pass.
#
# Environment (all optional):
#   UC_REDIS_DEPLOY        Redis Deployment name in the namespace   (redis)
#   UC_TOKEN_SECRET        Secret holding CACHE_INVALIDATE_TOKEN    (<app>-credentials)
#   UC_PORT_A / UC_PORT_B  local ports for the two pod port-forwards (18081 / 18082)
#   UC_MUTATE_FLUSH=1      TEETH CHECK, not a mode of the product: flush Redis
#                          between pod A filling the entry and pod B reading it,
#                          i.e. remove the shared store. The run MUST exit
#                          non-zero, at the "pod B did not serve pod A's entry"
#                          assertion. Used to prove this script can see red.
set -euo pipefail

NS="${1:?usage: use-cache-2pod-e2e-assert.sh <namespace> <nextapp-name>}"
APP="${2:?missing nextapp name}"
REDIS_DEPLOY="${UC_REDIS_DEPLOY:-redis}"
TOKEN_SECRET="${UC_TOKEN_SECRET:-${APP}-credentials}"
PORT_A="${UC_PORT_A:-18081}"
PORT_B="${UC_PORT_B:-18082}"
LOGDIR="${TMPDIR:-/tmp}"

fail() { echo "::error::$*" >&2; exit 1; }
ok() { echo "ok: $*"; }

pf_pids=()
cleanup() {
  for p in "${pf_pids[@]:-}"; do
    [ -n "$p" ] && kill "$p" 2>/dev/null || true
  done
}
trap cleanup EXIT

# 1. Two distinct, Ready pods of the one Knative Service.
min_scale="$(kubectl -n "$NS" get ksvc "$APP" -o jsonpath='{.spec.template.metadata.annotations.autoscaling\.knative\.dev/min-scale}')"
[ -n "$min_scale" ] && [ "$min_scale" -ge 2 ] 2>/dev/null \
  || fail "ksvc/$APP min-scale annotation is '${min_scale}', want >= 2 (the test needs two pods up without traffic)"
ok "ksvc/$APP min-scale=$min_scale"

ready_pods() {
  kubectl -n "$NS" get pods -l "serving.knative.dev/service=${APP}" -o json \
    | jq -r '.items[]
        | select(.metadata.deletionTimestamp == null)
        | select(.status.phase == "Running")
        | select([.status.conditions[]? | select(.type == "Ready" and .status == "True")] | length == 1)
        | .metadata.name' | sort
}

pods=""
for _ in $(seq 1 90); do
  pods="$(ready_pods || true)"
  [ "$(printf '%s\n' "$pods" | grep -c .)" -ge 2 ] && break
  sleep 2
done
POD_A="$(printf '%s\n' "$pods" | sed -n 1p)"
POD_B="$(printf '%s\n' "$pods" | sed -n 2p)"
[ -n "$POD_A" ] && [ -n "$POD_B" ] && [ "$POD_A" != "$POD_B" ] \
  || fail "need two distinct Ready pods for ksvc/$APP, got: '${pods}'"
ok "pod A=$POD_A pod B=$POD_B"

CONTAINER_PORT="$(kubectl -n "$NS" get pod "$POD_A" -o jsonpath='{.spec.containers[?(@.name=="user-container")].ports[0].containerPort}')"
[ -n "$CONTAINER_PORT" ] || fail "pod $POD_A user-container declares no port"

# 2. Pin each request to one pod: port-forward to the POD (not the Service).
pin() { # <pod> <local-port> <tag>
  kubectl -n "$NS" port-forward "pod/$1" "$2:${CONTAINER_PORT}" >"${LOGDIR}/uc2pod-pf-$3.log" 2>&1 &
  pf_pids+=("$!")
  for _ in $(seq 1 30); do
    if (exec 3<>/dev/tcp/127.0.0.1/"$2") 2>/dev/null; then return 0; fi
    sleep 1
  done
  cat "${LOGDIR}/uc2pod-pf-$3.log" >&2 || true
  fail "port-forward to pod/$1 never became reachable on :$2"
}
pin "$POD_A" "$PORT_A" a
pin "$POD_B" "$PORT_B" b

field() { printf '%s' "$1" | jq -r "$2"; }

get_json() { # <port> <path> -> JSON on stdout
  local out
  out="$(curl -fsS --max-time 60 "http://127.0.0.1:$1$2")" || fail "GET $2 on :$1 failed"
  printf '%s' "$out"
}
stamp() { # <port>
  local out
  out="$(get_json "$1" /api/uc)"
  printf '%s' "$out" | jq -e '.cached.nonce and .servedBy and (.computesInThisPod | type == "number")' >/dev/null \
    || fail "GET /api/uc on :$1 returned an unexpected body: $out"
  printf '%s' "$out"
}
computes() { # <port>: how many entries the pod has built so far, WITHOUT reading the cache
  local out
  out="$(get_json "$1" /api/uc/stats)"
  printf '%s' "$out" | jq -e '.computesInThisPod | type == "number"' >/dev/null \
    || fail "GET /api/uc/stats on :$1 returned an unexpected body: $out"
  field "$out" .computesInThisPod
}

# 3. The mutating route is closed to an unauthenticated caller (kept here so the
#    test cannot pass against an open route), then reset the entry so the run
#    starts from a miss whatever ran before.
TOKEN="$(kubectl -n "$NS" get secret "$TOKEN_SECRET" -o jsonpath='{.data.CACHE_INVALIDATE_TOKEN}' | base64 -d)"
[ -n "$TOKEN" ] || fail "secret/$TOKEN_SECRET has no CACHE_INVALIDATE_TOKEN"

code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X POST "http://127.0.0.1:$PORT_A/api/uc/revalidate")"
[ "$code" = "401" ] || fail "unauthenticated POST /api/uc/revalidate answered $code, want 401"
ok "unauthenticated POST /api/uc/revalidate -> 401"

revalidate() { # <port> <expected-pod> [tag, default uc-2pod]
  local rev tag="${3:-uc-2pod}"
  rev="$(curl -fsS --max-time 30 -X POST -H "Authorization: Bearer ${TOKEN}" "http://127.0.0.1:$1/api/uc/revalidate?tag=${tag}")" \
    || fail "authenticated POST /api/uc/revalidate?tag=${tag} on :$1 failed"
  [ "$(field "$rev" .servedBy)" = "$2" ] || fail "revalidate pinned to $2 was served by '$(field "$rev" .servedBy)'"
  [ "$(field "$rev" .tag)" = "$tag" ] || fail "revalidate invalidated '$(field "$rev" .tag)', want '$tag'"
}
# The invalidation's timestamp must be strictly newer than any entry's.
sleep 1
revalidate "$PORT_A" "$POD_A"
sleep 1
ok "entry reset (revalidateTag('uc-2pod') on pod A)"

base_a="$(computes "$PORT_A")"
base_b="$(computes "$PORT_B")"

# 4. Pod A builds the entry once and serves it again from the cache.
a1="$(stamp "$PORT_A")"
a2="$(stamp "$PORT_A")"
[ "$(field "$a1" .servedBy)" = "$POD_A" ] || fail "request pinned to $POD_A was served by '$(field "$a1" .servedBy)'"
nonce_a="$(field "$a1" .cached.nonce)"
[ "$(field "$a2" .cached.nonce)" = "$nonce_a" ] \
  || fail "pod A recomputed on its second request ('use cache' is a no-op on this pod): $a1 / $a2"
[ "$(field "$a1" .cached.computedBy)" = "$POD_A" ] \
  || fail "pod A's own entry says it was built by '$(field "$a1" .cached.computedBy)', want $POD_A"
[ "$(field "$a2" .computesInThisPod)" = "$((base_a + 1))" ] \
  || fail "pod A should have built exactly one entry for two reads (baseline ${base_a}): $a1 / $a2"
ok "pod A built the entry once (nonce ${nonce_a}) and served it twice"

if [ "${UC_MUTATE_FLUSH:-}" = "1" ]; then
  echo "MUTATION: flushing Redis between pod A and pod B (the shared store removed)" >&2
  kubectl -n "$NS" exec "deploy/${REDIS_DEPLOY}" -- redis-cli FLUSHALL >/dev/null
fi

# 5. Pod B serves POD A's entry: same nonce, built by A, and B built nothing.
b1="$(stamp "$PORT_B")"
[ "$(field "$b1" .servedBy)" = "$POD_B" ] || fail "request pinned to $POD_B was served by '$(field "$b1" .servedBy)'"
[ "$(field "$b1" .cached.nonce)" = "$nonce_a" ] \
  || fail "pod B did not serve pod A's entry (A nonce ${nonce_a}): $b1"
[ "$(field "$b1" .cached.computedBy)" = "$POD_A" ] \
  || fail "pod B's entry was built by '$(field "$b1" .cached.computedBy)', want pod A ($POD_A)"
[ "$(field "$b1" .computesInThisPod)" = "$base_b" ] \
  || fail "pod B recomputed instead of reading the shared entry (computesInThisPod=$(field "$b1" .computesInThisPod), baseline ${base_b}): $b1"
ok "pod B served pod A's entry with no recompute (computesInThisPod=${base_b}, unchanged)"

# 6. The entry really lives in Redis, under knext's 'use cache' namespace.
keys="$(kubectl -n "$NS" exec "deploy/${REDIS_DEPLOY}" -- redis-cli --scan --pattern '*:uc:default:*')"
nkeys="$(printf '%s\n' "$keys" | grep -c . || true)"
[ "$nkeys" -gt 0 ] || fail "Redis holds no '<prefix>:uc:default:*' entry after the cache was filled"
ok "Redis holds ${nkeys} 'use cache' entr$([ "$nkeys" = 1 ] && echo y || echo ies)"

# 7. revalidateTag through pod A reaches pod B.
sleep 1
revalidate "$PORT_A" "$POD_A"
ok "revalidateTag('uc-2pod') ran on pod A"

b2="$(stamp "$PORT_B")"
nonce_b="$(field "$b2" .cached.nonce)"
[ "$nonce_b" != "$nonce_a" ] \
  || fail "pod B still serves the entry pod A invalidated (nonce ${nonce_a}): $b2"
[ "$(field "$b2" .cached.computedBy)" = "$POD_B" ] \
  || fail "pod B's fresh entry was built by '$(field "$b2" .cached.computedBy)', want pod B ($POD_B)"
[ "$(field "$b2" .computesInThisPod)" = "$((base_b + 1))" ] \
  || fail "pod B should have built exactly one entry after the invalidation (baseline ${base_b}): $b2"
ok "pod B saw fresh data after revalidateTag on pod A (nonce ${nonce_a} -> ${nonce_b})"

# 8. ...and the regenerated entry is shared back: pod A reads pod B's, building nothing.
a3="$(stamp "$PORT_A")"
[ "$(field "$a3" .cached.nonce)" = "$nonce_b" ] \
  || fail "pod A did not pick up pod B's regenerated entry (B nonce ${nonce_b}): $a3"
[ "$(field "$a3" .computesInThisPod)" = "$((base_a + 1))" ] \
  || fail "pod A recomputed instead of reading pod B's entry (baseline ${base_a}): $a3"
ok "pod A served pod B's regenerated entry with no recompute"

tags="$(kubectl -n "$NS" exec "deploy/${REDIS_DEPLOY}" -- redis-cli --scan --pattern '*:uc:tags')"
[ -n "$tags" ] || fail "Redis holds no '<prefix>:uc:tags' hash after the invalidation"
ok "Redis tag-stamp hash present: $tags"

# 9. Two users of ONE `'use cache'` function get two entries, on both pods.
#    `/api/uc/user/<user>` caches `profileFor(user)`. Next keys the entry on the
#    function AND its argument, and knext stores that key opaque, so if the two
#    users shared a key (the argument dropped from it, or knext's entry key
#    collapsed) the second user would be served the first user's entry.
user_stamp() { # <port> <user>
  local out
  out="$(get_json "$1" "/api/uc/user/$2")"
  printf '%s' "$out" | jq -e '.cached.nonce and .cached.computedBy and .servedBy and (.computesInThisPod | type == "number")' >/dev/null \
    || fail "GET /api/uc/user/$2 on :$1 returned an unexpected body: $out"
  [ "$(field "$out" .cached.user)" = "$2" ] \
    || fail "user '$2' was served the 'use cache' entry built for '$(field "$out" .cached.user)' (cache keys collapsed): $out"
  printf '%s' "$out"
}

sleep 1
revalidate "$PORT_A" "$POD_A"
sleep 1
ok "entries reset before the two-user check (revalidateTag('uc-2pod') on pod A)"
ubase_a="$(computes "$PORT_A")"
ubase_b="$(computes "$PORT_B")"

ua_alice="$(user_stamp "$PORT_A" alice)"
ua_bob="$(user_stamp "$PORT_A" bob)"
alice_nonce="$(field "$ua_alice" .cached.nonce)"
bob_nonce="$(field "$ua_bob" .cached.nonce)"
[ "$alice_nonce" != "$bob_nonce" ] \
  || fail "alice and bob were served ONE entry (nonce ${alice_nonce}) (cache keys collapsed)"
[ "$(field "$ua_bob" .computesInThisPod)" = "$((ubase_a + 2))" ] \
  || fail "pod A should have built one entry per user (baseline ${ubase_a}): $ua_alice / $ua_bob"
ua_alice2="$(user_stamp "$PORT_A" alice)"
[ "$(field "$ua_alice2" .cached.nonce)" = "$alice_nonce" ] \
  || fail "pod A recomputed alice's entry on a second read: $ua_alice / $ua_alice2"
ok "pod A built one entry per user (alice ${alice_nonce}, bob ${bob_nonce}) and serves each from the cache"

ub_alice="$(user_stamp "$PORT_B" alice)"
ub_bob="$(user_stamp "$PORT_B" bob)"
[ "$(field "$ub_alice" .cached.nonce)" = "$alice_nonce" ] \
  || fail "pod B did not serve pod A's entry for alice (A nonce ${alice_nonce}): $ub_alice"
[ "$(field "$ub_bob" .cached.nonce)" = "$bob_nonce" ] \
  || fail "pod B did not serve pod A's entry for bob (A nonce ${bob_nonce}): $ub_bob"
[ "$(field "$ub_alice" .cached.computedBy)" = "$POD_A" ] && [ "$(field "$ub_bob" .cached.computedBy)" = "$POD_A" ] \
  || fail "pod B's per-user entries were not built by pod A ($POD_A): $ub_alice / $ub_bob"
[ "$(field "$ub_bob" .computesInThisPod)" = "$ubase_b" ] \
  || fail "pod B recomputed a user's entry instead of reading the shared one (baseline ${ubase_b}): $ub_bob"
ok "pod B served pod A's entry for each user, building nothing"

ukeys="$(kubectl -n "$NS" exec "deploy/${REDIS_DEPLOY}" -- redis-cli --scan --pattern '*:uc:default:*')"
unkeys="$(printf '%s\n' "$ukeys" | grep -c . || true)"
[ "$unkeys" -ge 3 ] \
  || fail "Redis holds ${unkeys} '<prefix>:uc:default:*' entries, want >= 3: the no-argument entry plus one per user (cache keys collapsed)"
ok "Redis holds ${unkeys} separate 'use cache' entries"

# 10. Invalidating one user leaves the other user's entry alone, across pods.
sleep 1
revalidate "$PORT_A" "$POD_A" uc-user-alice
ok "revalidateTag('uc-user-alice') ran on pod A"
ub_alice2="$(user_stamp "$PORT_B" alice)"
[ "$(field "$ub_alice2" .cached.nonce)" != "$alice_nonce" ] \
  || fail "pod B still serves alice's entry after revalidateTag('uc-user-alice') on pod A: $ub_alice2"
[ "$(field "$ub_alice2" .cached.computedBy)" = "$POD_B" ] \
  || fail "alice's fresh entry was built by '$(field "$ub_alice2" .cached.computedBy)', want pod B ($POD_B)"
ub_bob2="$(user_stamp "$PORT_B" bob)"
[ "$(field "$ub_bob2" .cached.nonce)" = "$bob_nonce" ] \
  || fail "bob's entry did not survive alice's invalidation (bob nonce ${bob_nonce}): $ub_bob2"
ok "alice's entry rebuilt on pod B; bob's entry untouched (nonce ${bob_nonce})"

echo "use-cache two-pod e2e: all assertions passed"

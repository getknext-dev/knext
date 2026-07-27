#!/usr/bin/env bash
# cold-attribution-collector.sh — capture per-sample cold-start attribution data DURING a
# scale-to-zero-oke run.
#
# Why this exists: every previous cold-start run on this cluster failed to attribute the ~11 s
# tail because "the pods were gone before their placement could be inspected"
# (docs/benchmarks/scale-to-zero-oke.md, Run 24). The harness's only pod observation is
# running_pods() (run.sh:809) — a COUNT of Running pods polled every 3 s, with no pod name, no
# nodeName, no timestamps, no events and no revision identity. Nothing about that is wrong; it was
# built to measure, not to attribute. Attribution needs a separate observer, and it must be
# started BEFORE the request, because Knative reaps the pod on scale-to-zero and placement then
# becomes unrecoverable.
#
# Schema follows .claude/verdicts/sprint1-sysdesign.md §1.2.
#
# It is READ-ONLY against the cluster (get/list only). It mutates nothing. In particular it does
# NOT raise the scale-to-zero grace period to keep pods alive for inspection — that would mutate
# the thing being measured.
#
# Usage:
#   ./cold-attribution-collector.sh <ksvc-name> <context> <namespace> <out.jsonl>
# Stop with SIGTERM/SIGINT; it flushes a final events sweep on the way out.

set -uo pipefail

SVC="${1:?ksvc name required}"
KCTX="${2:?kube context required}"
NS="${3:?namespace required}"
OUT="${4:?output jsonl path required}"

POLL_INTERVAL="${POLL_INTERVAL:-0.4}"   # seconds between pod polls
SLOW_EVERY="${SLOW_EVERY:-6}"            # every N ticks: events, nodes, KPA, revision

kc() { kubectl --context "$KCTX" -n "$NS" "$@"; }

emit() { printf '%s\n' "$1" >> "$OUT"; }

# Millisecond UTC timestamp. GNU date's %3N is unavailable on macOS/BSD, and a whole-second stamp
# is too coarse to order events inside a ~2 s cold start.
if [ -n "${EPOCHREALTIME:-}" ]; then
  now() {
    local er="${EPOCHREALTIME/,/.}"       # some locales use a comma decimal separator
    local secs="${er%.*}" frac="${er#*.}"
    printf '%s.%sZ' "$(date -u -r "$secs" +%Y-%m-%dT%H:%M:%S)" "${frac:0:3}"
  }
else
  now() {
    python3 -c 'import datetime as d;print(d.datetime.now(d.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3]+"Z")'
  }
fi

sweep_events() {
  local tag="$1" ts
  ts="$(now)"
  kc get events -o json 2>/dev/null \
    | jq -c --arg t "$ts" --arg tag "$tag" --arg svc "$SVC" '
        .items[]
        | select(.involvedObject.kind == "Pod")
        | select((.involvedObject.name | startswith($svc)) or (.involvedObject.name | startswith("k6-")))
        | {t:$t, kind:"event", sweep:$tag,
           pod:.involvedObject.name,
           reason:.reason,
           message:.message,
           count:.count,
           first:(.firstTimestamp // .eventTime),
           last:(.lastTimestamp // .eventTime)}' 2>/dev/null \
    | while IFS= read -r line; do emit "$line"; done
}

# Target image digest — used to test node-level residency BEFORE each request. Post-hoc the image
# is always resident, so a post-hoc check proves nothing.
TARGET_IMAGE="$(kc get ksvc "$SVC" -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null)"
TARGET_DIGEST="${TARGET_IMAGE##*@}"

emit "$(jq -nc --arg t "$(now)" --arg svc "$SVC" --arg ns "$NS" --arg ctx "$KCTX" \
  --arg img "$TARGET_IMAGE" --arg dig "$TARGET_DIGEST" \
  '{t:$t, kind:"collector-start", service:$svc, namespace:$ns, context:$ctx,
    targetImage:$img, targetDigest:$dig}')"

# ksvc identity: proves apply_autoscaling did not fire mid-arm.
snapshot_ksvc() {
  kc get ksvc "$SVC" -o json 2>/dev/null \
    | jq -c --arg t "$(now)" '{t:$t, kind:"ksvc",
        generation:.metadata.generation,
        latestReady:.status.latestReadyRevisionName,
        latestCreated:.status.latestCreatedRevisionName,
        annotations:.spec.template.metadata.annotations,
        containerConcurrency:.spec.template.spec.containerConcurrency,
        readinessProbe:.spec.template.spec.containers[0].readinessProbe}' \
    | while IFS= read -r line; do emit "$line"; done
}

# Node-level image residency for the target digest, plus allocatable — sampled continuously so
# each sample has a reading taken before its request.
snapshot_nodes() {
  kc get nodes -o json 2>/dev/null \
    | jq -c --arg t "$(now)" --arg dig "$TARGET_DIGEST" '
        .items[]
        | {t:$t, kind:"node", name:.metadata.name,
           alloc_cpu:.status.allocatable.cpu, alloc_mem:.status.allocatable.memory,
           targetImageResident:([(.status.images // [])[] | (.names // [])[]
                                 | select(. | contains($dig))] | length > 0)}' 2>/dev/null \
    | while IFS= read -r line; do emit "$line"; done
}

# Autoscaler evidence: PodAutoscaler Active/Activating transitions + replica timeline.
snapshot_kpa() {
  kc get podautoscalers -l "serving.knative.dev/service=${SVC}" -o json 2>/dev/null \
    | jq -c --arg t "$(now)" '
        .items[]
        | {t:$t, kind:"kpa", name:.metadata.name,
           revision:(.metadata.labels["serving.knative.dev/revision"] // null),
           actualReplicas:(.status.actualScale // null),
           desiredReplicas:(.status.desiredScale // null),
           conditions:[(.status.conditions // [])[] | {type:.type, status:.status, reason:(.reason//null), at:.lastTransitionTime}]}' 2>/dev/null \
    | while IFS= read -r line; do emit "$line"; done
}

snapshot_ksvc
snapshot_nodes
snapshot_kpa

# Flush a final sweep on the way out, so late-arriving Pulled/Started/Unhealthy events for the
# last sample are not lost when we are stopped right after the run ends.
finish() {
  emit "$(jq -nc --arg t "$(now)" '{t:$t, kind:"collector-stop"}')"
  sweep_events "final"
  snapshot_kpa
  exit 0
}
trap finish TERM INT

tick=0
CAPTURED_K6=""   # k6 driver pods whose full summary log we have already captured
while true; do
  ts="$(now)"

  # App pods: identity, placement, the four lifecycle condition timestamps, per-container start
  # times (BOTH user-container and queue-proxy — queue-proxy readiness is what gates traffic, and
  # omitting it attributes queue-proxy time to the app), and the REWRITTEN probe as it actually
  # exists on the running pod rather than the operator's intent.
  kc get pods -l "serving.knative.dev/service=${SVC}" -o json 2>/dev/null \
    | jq -c --arg t "$ts" '
        .items[]
        | {t:$t, kind:"pod",
           name:.metadata.name,
           uid:.metadata.uid,
           revision:(.metadata.labels["serving.knative.dev/revision"] // null),
           revisionUid:(.metadata.labels["serving.knative.dev/revisionUID"] // null),
           node:(.spec.nodeName // null),
           podIP:(.status.podIP // null),
           created:.metadata.creationTimestamp,
           phase:.status.phase,
           deletionTimestamp:(.metadata.deletionTimestamp // null),
           conditions:[(.status.conditions // [])[]
             | {type:.type, status:.status, at:.lastTransitionTime}],
           containers:[(.status.containerStatuses // [])[]
             | {name:.name, ready:.ready, started:(.started // null),
                restarts:.restartCount, imageID:(.imageID // ""),
                state:(.state | keys[0]? // "unknown"),
                startedAt:(.state.running.startedAt // .state.terminated.startedAt // null)}],
           probes:[(.spec.containers // [])[]
             | {name:.name, readinessProbe:(.readinessProbe // null)}]}' 2>/dev/null \
    | while IFS= read -r line; do emit "$line"; done

  # k6 driver pods: these delimit each sample window (name carries cold-N). nodeName matters —
  # same-node vs cross-node is a confound on a 2-node cluster, and the k6 pod's CPU request
  # competes for the same node headroom.
  kc get pods -l "app=k6-loadtest" -o json 2>/dev/null \
    | jq -c --arg t "$ts" '
        .items[]
        | {t:$t, kind:"k6pod",
           name:.metadata.name,
           job:(.metadata.labels["job-name"] // null),
           node:(.spec.nodeName // null),
           phase:.status.phase,
           created:.metadata.creationTimestamp,
           startedAt:((.status.containerStatuses // [])[0].state.running.startedAt
                      // (.status.containerStatuses // [])[0].state.terminated.startedAt // null),
           finishedAt:((.status.containerStatuses // [])[0].state.terminated.finishedAt // null)}' 2>/dev/null \
    | while IFS= read -r line; do emit "$line"; done

  # Capture the FULL k6 summary from the driver pod's logs the moment it succeeds.
  #
  # Why not read the results file: run.sh:1021 filters k6's summary through
  #   grep -E 'http_req_duration|http_req_failed|http_reqs|iteration_duration|checks\.\.\.|vus_max|dropped'
  # which DROPS http_req_connecting / http_req_waiting / http_req_tls_handshaking. Those splits are
  # the diagnostic that separates "Kourier/activator" (connecting spikes) from "pod path" (waiting
  # spikes) — recording only the total makes them indistinguishable. Reading the pod log directly
  # gets the whole summary without modifying the harness. run.sh deletes the Job at the end of each
  # rep, so this must happen while the pod still exists — hence polling, not a post-hoc read.
  for kp in $(kc get pods -l "app=k6-loadtest" \
                -o jsonpath='{range .items[?(@.status.phase=="Succeeded")]}{.metadata.name}{"\n"}{end}' 2>/dev/null); do
    case " $CAPTURED_K6 " in *" $kp "*) continue ;; esac
    klog="$(kc logs "$kp" 2>/dev/null)"
    if [ -n "$klog" ]; then
      emit "$(jq -nc --arg t "$(now)" --arg pod "$kp" --arg log "$klog" \
        '{t:$t, kind:"k6log", pod:$pod, log:$log}')"
      CAPTURED_K6="$CAPTURED_K6 $kp"
    fi
  done

  tick=$((tick + 1))
  if [ $((tick % SLOW_EVERY)) -eq 0 ]; then
    sweep_events "periodic"
    snapshot_nodes
    snapshot_kpa
    snapshot_ksvc
  fi

  sleep "$POLL_INTERVAL"
done

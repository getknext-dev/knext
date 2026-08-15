---
"@getknext/core": patch
---

The operator's default NetworkPolicy now restricts ingress **ports**, and scopes same-namespace
access to metrics only.

Previously the policy allowed any admitted source to reach **any port** on your app's pods. In
practice that meant a pod sharing your namespace could dial your app container directly, bypassing
the Knative queue-proxy — and with it your app's concurrency limit and one layer of HTTP parsing.

The policy now admits the queue-proxy ports (`8012`/`8013`, and `8112` for Knative's internal
TLS path) and the metrics ports (`9090`, `9091`)
from `knative-serving`/`kourier-system`, and the **metrics ports only** from same-namespace pods.
Your app's container port is deliberately excluded — the queue-proxy reaches it over pod-local
loopback, which no NetworkPolicy governs.

**Behaviour change.** If something in your namespace called your app directly on its container
port, that call now fails. Call the app through its service URL instead (gateway-routed, still
allowed), or opt out with `spec.security.networkPolicy: false`.

**Enforcement depends on your CNI.** Calico and Cilium enforce NetworkPolicy; flannel ships no
policy controller, so on a flannel cluster this object is declarative only and changes nothing.

#!/usr/bin/env bash
# Print each arm's rendered Knative Service container contract (command, env, probes,
# resources, volumes) so a run can be checked against "one variable per arm" before
# any wake. Usage: bash verify-arms.sh arm1 arm2 ...
set -euo pipefail
for k in "$@"; do
  kubectl --context knext-coldstart -n bench-cells get ksvc "$k" -o json | python3 -c '
import json, sys
j = json.load(sys.stdin)
s = j["spec"]["template"]["spec"]
c = s["containers"][0]
print(j["metadata"]["name"], "image=" + c["image"].split("@")[1][:19],
      "cmd=" + str(c.get("command")), "env=" + str({e["name"]: e.get("value") for e in c.get("env", [])}),
      "ready=" + json.dumps(c.get("readinessProbe")), "res=" + json.dumps(c.get("resources")),
      "vols=" + str([v["name"] for v in s.get("volumes", [])]), "init=" + str(len(s.get("initContainers", []))))
'
done

#!/usr/bin/env python3
"""Trim harness JSONL for committing as raw data: keeps every timing field,
event and the per-cycle clock offset; shortens container log lines (the
timestamps analyze.py reads are kept, the JSON payloads are cut).

    python3 compact.py in.jsonl out.jsonl
"""
import json
import sys

with open(sys.argv[1]) as src, open(sys.argv[2], "w") as dst:
    for line in src:
        r = json.loads(line)
        logs = r.get("logs", {})
        if "user-container" in logs:
            logs["user-container"] = [
                {**x, "line": x.get("line", "")[:240]} for x in logs["user-container"][:14]
            ]
        if "queue-proxy" in logs:
            logs["queue-proxy"] = [{**x, "line": x.get("line", "")[:160]} for x in logs["queue-proxy"][:4]]
        dst.write(json.dumps(r, separators=(",", ":")) + "\n")

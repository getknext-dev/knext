/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package utils

import (
	"fmt"
	"strconv"
	"strings"
)

// MetricValue returns the value of ONE exposition sample, addressed by its full
// series name including any label set exactly as the exporter prints it, e.g.
// `knext_platform_apps_held{reason="EffectiveSpecInvalid"}` or
// `knext_platform_rollout_wait_seconds_count`.
//
// It matches the series token exactly rather than by prefix: a prefix match
// would return `..._count` for the bare histogram name, or one label set for
// another, and the caller would assert on the wrong number. ok=false means the
// series is absent, which is NOT zero — the platform e2e relies on telling a
// series that was never exported from one that reads 0.
func MetricValue(exposition, series string) (float64, bool) {
	for _, line := range strings.Split(exposition, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		// A sample is "<series> <value>[ <timestamp>]". The label values the
		// operator exports contain no spaces, so the first space ends the series.
		sp := strings.IndexByte(line, ' ')
		if sp < 0 || line[:sp] != series {
			continue
		}
		fields := strings.Fields(line[sp:])
		if len(fields) == 0 {
			continue
		}
		v, err := strconv.ParseFloat(fields[0], 64)
		if err != nil {
			continue
		}
		return v, true
	}
	return 0, false
}

// ScrapeWithBearer GETs url (TLS verification off: the operator's metrics
// endpoint serves a self-signed cert) with an Authorization: Bearer header from
// an ephemeral in-cluster curl pod in namespace, and returns the exposition
// text. The token is redacted from the command echoed to the Ginkgo log; it is a
// per-run, e2e-generated ServiceAccount token on a throwaway kind cluster.
func ScrapeWithBearer(namespace, podName, url, token string) (string, error) {
	_, _ = Kubectl("delete", "pod", podName, "-n", namespace, "--ignore-not-found")
	out, err := runKubectlRedacted([]string{
		"run", podName,
		"-n", namespace,
		"--restart=Never",
		"--rm", "-i",
		"--image=" + CurlImage(),
		"--command", "--",
		"curl", "-sS", "-k", "--max-time", "30",
		"-H", fmt.Sprintf("Authorization: Bearer %s", token),
		url,
	}, token)
	return out, err
}

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
	"bufio"
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	. "github.com/onsi/ginkgo/v2" // nolint:revive,staticcheck
)

const (
	certmanagerVersion = "v1.19.3"
	certmanagerURLTmpl = "https://github.com/cert-manager/cert-manager/releases/download/%s/cert-manager.yaml"

	defaultKindBinary  = "kind"
	defaultKindCluster = "kind"
)

func warnError(err error) {
	_, _ = fmt.Fprintf(GinkgoWriter, "warning: %v\n", err)
}

// CurlImage returns the in-cluster curl image used by the ephemeral HTTP-probe
// pods (ActivateAndGet / ScrapeAppMetrics). Defaults to the Docker Hub
// curlimages/curl pin; KNEXT_E2E_CURL_IMAGE overrides it for environments
// where docker.io is unreachable/throttled (the curl project publishes the
// same image at quay.io/curl/curl).
func CurlImage() string {
	if v := strings.TrimSpace(os.Getenv("KNEXT_E2E_CURL_IMAGE")); v != "" {
		return v
	}
	return "curlimages/curl:8.11.1"
}

// Run executes the provided command within this context
func Run(cmd *exec.Cmd) (string, error) {
	dir, _ := GetProjectDir()
	cmd.Dir = dir

	if err := os.Chdir(cmd.Dir); err != nil {
		_, _ = fmt.Fprintf(GinkgoWriter, "chdir dir: %q\n", err)
	}

	cmd.Env = append(os.Environ(), "GO111MODULE=on")
	command := strings.Join(cmd.Args, " ")
	_, _ = fmt.Fprintf(GinkgoWriter, "running: %q\n", command)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return string(output), fmt.Errorf("%q failed with error %q: %w", command, string(output), err)
	}

	return string(output), nil
}

// UninstallCertManager uninstalls the cert manager
func UninstallCertManager() {
	url := fmt.Sprintf(certmanagerURLTmpl, certmanagerVersion)
	cmd := exec.Command("kubectl", "delete", "-f", url)
	if _, err := Run(cmd); err != nil {
		warnError(err)
	}

	// Delete leftover leases in kube-system (not cleaned by default)
	kubeSystemLeases := []string{
		"cert-manager-cainjector-leader-election",
		"cert-manager-controller",
	}
	for _, lease := range kubeSystemLeases {
		cmd = exec.Command("kubectl", "delete", "lease", lease,
			"-n", "kube-system", "--ignore-not-found", "--force", "--grace-period=0")
		if _, err := Run(cmd); err != nil {
			warnError(err)
		}
	}
}

// InstallCertManager installs the cert manager bundle.
func InstallCertManager() error {
	url := fmt.Sprintf(certmanagerURLTmpl, certmanagerVersion)
	cmd := exec.Command("kubectl", "apply", "-f", url)
	if _, err := Run(cmd); err != nil {
		return err
	}
	// Wait for cert-manager-webhook to be ready, which can take time if cert-manager
	// was re-installed after uninstalling on a cluster.
	cmd = exec.Command("kubectl", "wait", "deployment.apps/cert-manager-webhook",
		"--for", "condition=Available",
		"--namespace", "cert-manager",
		"--timeout", "5m",
	)

	_, err := Run(cmd)
	return err
}

// IsCertManagerCRDsInstalled checks if any Cert Manager CRDs are installed
// by verifying the existence of key CRDs related to Cert Manager.
func IsCertManagerCRDsInstalled() bool {
	// List of common Cert Manager CRDs
	certManagerCRDs := []string{
		"certificates.cert-manager.io",
		"issuers.cert-manager.io",
		"clusterissuers.cert-manager.io",
		"certificaterequests.cert-manager.io",
		"orders.acme.cert-manager.io",
		"challenges.acme.cert-manager.io",
	}

	// Execute the kubectl command to get all CRDs
	cmd := exec.Command("kubectl", "get", "crds")
	output, err := Run(cmd)
	if err != nil {
		return false
	}

	// Check if any of the Cert Manager CRDs are present
	crdList := GetNonEmptyLines(output)
	for _, crd := range certManagerCRDs {
		for _, line := range crdList {
			if strings.Contains(line, crd) {
				return true
			}
		}
	}

	return false
}

// LoadImageToKindClusterWithName loads a local docker image to the kind cluster
func LoadImageToKindClusterWithName(name string) error {
	cluster := defaultKindCluster
	if v, ok := os.LookupEnv("KIND_CLUSTER"); ok {
		cluster = v
	}
	kindOptions := []string{"load", "docker-image", name, "--name", cluster}
	kindBinary := defaultKindBinary
	if v, ok := os.LookupEnv("KIND"); ok {
		kindBinary = v
	}
	cmd := exec.Command(kindBinary, kindOptions...)
	_, err := Run(cmd)
	return err
}

// GetNonEmptyLines converts given command output string into individual objects
// according to line breakers, and ignores the empty elements in it.
func GetNonEmptyLines(output string) []string {
	var res []string
	elements := strings.SplitSeq(output, "\n")
	for element := range elements {
		if element != "" {
			res = append(res, element)
		}
	}

	return res
}

// GetProjectDir will return the directory where the project is
func GetProjectDir() (string, error) {
	wd, err := os.Getwd()
	if err != nil {
		return wd, fmt.Errorf("failed to get current working directory: %w", err)
	}
	wd = strings.ReplaceAll(wd, "/test/e2e", "")
	return wd, nil
}

// ---------------------------------------------------------------------------
// Scale-to-zero / metrics helpers (shared by the nightly e2e specs:
// scale_to_zero_cache_test.go (#38) and the scale-to-zero regression (#39)).
// These are deliberately generic kubectl/Knative wrappers so #39 can reuse them
// without depending on #38's spec.
// ---------------------------------------------------------------------------

// Kubectl runs a kubectl subcommand against the active context and returns its
// combined output. Thin wrapper over Run for readability in the specs.
func Kubectl(args ...string) (string, error) {
	return Run(exec.Command("kubectl", args...))
}

// KnativeReadyPodCount returns the number of Running pods for a Knative Service
// in the given namespace (label `serving.knative.dev/service=<svc>`). A return
// of 0 means the service has scaled to zero.
func KnativeReadyPodCount(namespace, ksvc string) (int, error) {
	out, err := Kubectl("get", "pods",
		"-n", namespace,
		"-l", fmt.Sprintf("serving.knative.dev/service=%s", ksvc),
		"--field-selector=status.phase=Running",
		"-o", "name",
	)
	if err != nil {
		return 0, err
	}
	return len(GetNonEmptyLines(out)), nil
}

// WaitForScaleToZero blocks until the Knative service has 0 Running pods, or
// returns an error after a 5-minute timeout. Promoted out of #38's spec
// (was a local `waitForScaleToZero`) so the #39 scale-from-zero regression can
// reuse it. It only wraps KnativeReadyPodCount.
func WaitForScaleToZero(namespace, ksvc string) error {
	deadline := time.Now().Add(5 * time.Minute)
	for time.Now().Before(deadline) {
		n, err := KnativeReadyPodCount(namespace, ksvc)
		if err == nil && n == 0 {
			return nil
		}
		time.Sleep(3 * time.Second)
	}
	return fmt.Errorf("service %s/%s did not scale to zero within timeout", namespace, ksvc)
}

// WaitForScaleFromZero blocks until the Knative service has at least one Running
// pod (i.e. the activator has woken a replica), or returns an error after a
// 5-minute timeout. Used by the #39 activation path to assert a scaled-to-zero
// service comes back up on demand.
func WaitForScaleFromZero(namespace, ksvc string) error {
	deadline := time.Now().Add(5 * time.Minute)
	for time.Now().Before(deadline) {
		n, err := KnativeReadyPodCount(namespace, ksvc)
		if err == nil && n >= 1 {
			return nil
		}
		time.Sleep(3 * time.Second)
	}
	return fmt.Errorf("service %s/%s did not scale up from zero within timeout", namespace, ksvc)
}

// ActivateAndGet sends a GET to the cluster-local Knative service at the given
// path from an ephemeral in-cluster curl pod, and returns the HTTP status code
// and response body. This is the #39 activation primitive: hitting a
// scaled-to-zero service routes through the Knative activator, which wakes a
// pod and proxies the request once it is Ready. Modeled on ScrapeAppMetrics.
func ActivateAndGet(namespace, ksvc, path string) (int, string, error) {
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	url := fmt.Sprintf("http://%s.%s.svc.cluster.local%s", ksvc, namespace, path)
	podName := fmt.Sprintf("activate-%s", ksvc)
	// Best-effort cleanup of any prior activation pod.
	_, _ = Kubectl("delete", "pod", podName, "-n", namespace, "--ignore-not-found")
	// We cannot rely on "the status code is the last line": utils.Run uses
	// CombinedOutput, so `kubectl run --rm` merges its own `pod "..." deleted`
	// notice (stderr) into the captured output, which would otherwise be parsed
	// as the HTTP code. Instead, curl's `-w` wraps the code in unique sentinels
	// (KNHTTP<code>KNEND) that we extract by marker, ignoring any surrounding
	// kubectl noise — the same robustness ScrapeAppMetricValue relies on.
	out, err := Kubectl("run", podName,
		"-n", namespace,
		"--restart=Never",
		"--rm", "-i",
		"--image="+CurlImage(),
		"--command", "--",
		"curl", "-sS", "--max-time", "120",
		"-w", fmt.Sprintf("\\n%s%%{http_code}%s", curlCodePrefix, curlCodeSuffix), url,
	)
	if err != nil {
		return 0, out, err
	}
	return ParseCurlStatusMarker(out, url)
}

// curlCodePrefix/curlCodeSuffix bracket the HTTP status written by the
// in-cluster curl probes' `-w '\nKNHTTP%{http_code}KNEND'`. They are unique
// sentinels so the code survives kubectl's `--rm` merging its own
// `pod "..." deleted` notice (stderr) into the captured output.
const (
	curlCodePrefix = "KNHTTP"
	curlCodeSuffix = "KNEND"
)

// ParseCurlStatusMarker extracts the HTTP status code and response body from the
// combined output of an in-cluster curl run that used the KNHTTP<code>KNEND
// status marker. Shared by ActivateAndGet (GET) and HTTPPostInCluster (POST) so
// both survive kubectl's merged `pod deleted` stderr noise identically. The body
// is everything before the newline that precedes the status marker.
func ParseCurlStatusMarker(out, url string) (int, string, error) {
	start := strings.LastIndex(out, curlCodePrefix)
	if start < 0 {
		return 0, out, fmt.Errorf("no HTTP status marker in response from %s: %q", url, out)
	}
	rest := out[start+len(curlCodePrefix):]
	end := strings.Index(rest, curlCodeSuffix)
	if end < 0 {
		return 0, out, fmt.Errorf("truncated HTTP status marker in response from %s: %q", url, out)
	}
	codeStr := strings.TrimSpace(rest[:end])
	code, convErr := strconv.Atoi(codeStr)
	if convErr != nil {
		return 0, out, fmt.Errorf("could not parse HTTP status %q from response: %w", codeStr, convErr)
	}
	body := strings.TrimRight(out[:start], "\n")
	return code, body, nil
}

// HTTPPostInCluster POSTs a JSON body to a cluster-local Knative service path
// from an ephemeral in-cluster curl pod, returning the HTTP status and body. It
// wakes a scaled-to-zero pod exactly as ActivateAndGet's GET does. Optional
// header lines (e.g. "Authorization: Bearer <token>") are passed as curl -H
// args; when secretValue is non-empty it is REDACTED from the command echoed to
// the Ginkgo log so a Bearer token never lands in CI output (security.md:
// "Do not echo secrets into logs"). Used by the Profile-A scale suite to prove
// the /api/cache/invalidate auth boundary (401 without token, 200 with) and the
// on-demand revalidation on the woken pod.
func HTTPPostInCluster(namespace, ksvc, path, jsonBody string, headerLines []string, secretValue string) (int, string, error) {
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	url := fmt.Sprintf("http://%s.%s.svc.cluster.local%s", ksvc, namespace, path)
	podName := fmt.Sprintf("post-%s", ksvc)
	// Best-effort cleanup of any prior POST pod so `kubectl run` does not collide.
	_, _ = Kubectl("delete", "pod", podName, "-n", namespace, "--ignore-not-found")

	args := []string{"run", podName,
		"-n", namespace,
		"--restart=Never",
		"--rm", "-i",
		"--image=" + CurlImage(),
		"--command", "--",
		"curl", "-sS", "--max-time", "120",
		"-X", "POST",
		"-H", "Content-Type: application/json",
	}
	for _, h := range headerLines {
		args = append(args, "-H", h)
	}
	args = append(args,
		"-d", jsonBody,
		"-w", fmt.Sprintf("\\n%s%%{http_code}%s", curlCodePrefix, curlCodeSuffix),
		url,
	)
	out, err := runKubectlRedacted(args, secretValue)
	if err != nil {
		return 0, out, err
	}
	return ParseCurlStatusMarker(out, url)
}

// runKubectlRedacted runs `kubectl <args>` like Run/Kubectl but replaces every
// occurrence of secretValue with "***" in the command line echoed to the Ginkgo
// log, so a Bearer token passed as a curl -H arg is not leaked into CI output.
// The pod's own spec still carries the arg (unavoidable for an in-cluster curl),
// but the ephemeral `--rm` pod is torn down immediately and the token is a
// per-run, e2e-generated value — never a production secret.
func runKubectlRedacted(args []string, secretValue string) (string, error) {
	cmd := exec.Command("kubectl", args...)
	dir, _ := GetProjectDir()
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GO111MODULE=on")
	shown := strings.Join(cmd.Args, " ")
	if secretValue != "" {
		shown = strings.ReplaceAll(shown, secretValue, "***")
	}
	_, _ = fmt.Fprintf(GinkgoWriter, "running: %q\n", shown)
	output, err := cmd.CombinedOutput()
	if err != nil {
		redacted := string(output)
		if secretValue != "" {
			redacted = strings.ReplaceAll(redacted, secretValue, "***")
		}
		return string(output), fmt.Errorf("%q failed with error %q", shown, redacted)
	}
	return string(output), nil
}

// ScrapeAppMetrics curls the app's own `/api/metrics` route (port 3000 inside
// the app container, NOT the :9464 sidecar) from an ephemeral in-cluster pod and
// returns the Prometheus exposition text. The app URL is the Knative service's
// cluster-local address. Used to read `kn_next_bytecode_cache_warm_start`.
func ScrapeAppMetrics(namespace, ksvc string) (string, error) {
	url := fmt.Sprintf("http://%s.%s.svc.cluster.local/api/metrics", ksvc, namespace)
	podName := fmt.Sprintf("scrape-%s", ksvc)
	// Best-effort cleanup of any prior scrape pod.
	_, _ = Kubectl("delete", "pod", podName, "-n", namespace, "--ignore-not-found")
	out, err := Kubectl("run", podName,
		"-n", namespace,
		"--restart=Never",
		"--rm", "-i",
		"--image="+CurlImage(),
		"--command", "--",
		"curl", "-sS", "--max-time", "30", url,
	)
	return out, err
}

// ScrapeAppMetricValue extracts the numeric value of a single-sample metric line
// whose name (with any label set) matches `metricPrefix` from raw exposition text.
// Returns the raw string value (e.g. "1") so callers can assert exact equality.
func ScrapeAppMetricValue(metrics, metricPrefix string) (string, bool) {
	for _, line := range strings.Split(metrics, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if !strings.HasPrefix(line, metricPrefix) {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) >= 2 {
			return fields[len(fields)-1], true
		}
	}
	return "", false
}

// UncommentCode searches for target in the file and remove the comment prefix
// of the target content. The target content may span multiple lines.
func UncommentCode(filename, target, prefix string) error {
	// false positive
	// nolint:gosec
	content, err := os.ReadFile(filename)
	if err != nil {
		return fmt.Errorf("failed to read file %q: %w", filename, err)
	}
	strContent := string(content)

	idx := strings.Index(strContent, target)
	if idx < 0 {
		return fmt.Errorf("unable to find the code %q to be uncommented", target)
	}

	out := new(bytes.Buffer)
	_, err = out.Write(content[:idx])
	if err != nil {
		return fmt.Errorf("failed to write to output: %w", err)
	}

	scanner := bufio.NewScanner(bytes.NewBufferString(target))
	if !scanner.Scan() {
		return nil
	}
	for {
		if _, err = out.WriteString(strings.TrimPrefix(scanner.Text(), prefix)); err != nil {
			return fmt.Errorf("failed to write to output: %w", err)
		}
		// Avoid writing a newline in case the previous line was the last in target.
		if !scanner.Scan() {
			break
		}
		if _, err = out.WriteString("\n"); err != nil {
			return fmt.Errorf("failed to write to output: %w", err)
		}
	}

	if _, err = out.Write(content[idx+len(target):]); err != nil {
		return fmt.Errorf("failed to write to output: %w", err)
	}

	// false positive
	// nolint:gosec
	if err = os.WriteFile(filename, out.Bytes(), 0644); err != nil {
		return fmt.Errorf("failed to write file %q: %w", filename, err)
	}

	return nil
}

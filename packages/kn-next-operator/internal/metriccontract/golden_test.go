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

package metriccontract_test

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	dto "github.com/prometheus/client_model/go"
	"sigs.k8s.io/controller-runtime/pkg/metrics"

	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/internal/metriccontract"

	// The two packages that register on the operator's /metrics today. They are
	// imported ONLY for the live cross-check below; the scan itself discovers
	// packages from cmd/'s import graph and does not rely on this list.
	_ "github.com/AhmedElBanna80/knext/packages/kn-next-operator/internal/controller"
	_ "github.com/AhmedElBanna80/knext/packages/kn-next-operator/internal/webhook/v1alpha1"
)

// moduleRoot is the operator module, two levels up from this package.
var moduleRoot = filepath.Join("..", "..")

// updateEnv rewrites the golden instead of comparing against it.
const updateEnv = "KNEXT_UPDATE_METRIC_GOLDEN"

func scanOperator(t *testing.T) map[string]metriccontract.Family {
	t.Helper()
	fams, err := metriccontract.Scan(moduleRoot, "cmd")
	if err != nil {
		t.Fatalf("scanning the operator's registered metrics: %v", err)
	}
	return fams
}

// The committed golden is what the TS metric contract
// (packages/kn-next/src/__tests__/observability-metric-contract.test.ts) reads
// as the operator's emitted set; that lane has no Go toolchain. This test is
// what keeps it from going stale: a renamed, added or removed operator metric
// reds here until the golden is regenerated, and the regenerated golden then
// reds every alert, dashboard and doc that still names the old series.
func TestGoldenMatchesTheOperatorsRegisteredMetrics(t *testing.T) {
	want, err := metriccontract.GoldenJSON(scanOperator(t))
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(moduleRoot, filepath.FromSlash(metriccontract.GoldenPath))
	if os.Getenv(updateEnv) == "1" {
		if err := os.WriteFile(path, want, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading the golden: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("%s is stale against the operator's registered metrics.\n"+
			"Regenerate it with: %s=1 go test ./internal/metriccontract/\n"+
			"--- committed\n%s\n--- scanned\n%s", metriccontract.GoldenPath, updateEnv, got, want)
	}
}

// The scan reads source; this checks it against the REGISTRY the operator
// process actually serves, in both directions, as far as a registry can say:
//   - every knext_ family the live registry gathers must be in the scan, with
//     the same type (a registration the scanner missed reds here);
//   - every scanned family that is not a *Vec must be gathered (a *Vec with no
//     children is omitted from Gather, which is why the scan is the source of
//     truth and this is a cross-check, not the other way round).
func TestScanAgreesWithTheLiveRegistry(t *testing.T) {
	fams := scanOperator(t)
	gathered, err := metrics.Registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	live := map[string]string{}
	for _, mf := range gathered {
		if strings.HasPrefix(mf.GetName(), "knext_") {
			live[mf.GetName()] = typeName(mf.GetType())
		}
	}
	if len(live) == 0 {
		t.Fatal("the live registry gathered no knext_ family; the cross-check would be vacuous")
	}
	for name, typ := range live {
		f, ok := fams[name]
		if !ok {
			t.Errorf("%s is served by the live registry but the scan did not find it", name)
			continue
		}
		if f.Type != typ {
			t.Errorf("%s: scan says %s, live registry says %s", name, f.Type, typ)
		}
	}
	for name, f := range fams {
		if _, ok := live[name]; !ok && !f.Vec {
			t.Errorf("%s was scanned as registered but the live registry does not serve it", name)
		}
	}
}

func typeName(t dto.MetricType) string {
	switch t {
	case dto.MetricType_COUNTER:
		return "counter"
	case dto.MetricType_GAUGE:
		return "gauge"
	case dto.MetricType_HISTOGRAM:
		return "histogram"
	case dto.MetricType_SUMMARY:
		return "summary"
	default:
		return strings.ToLower(t.String())
	}
}

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

package metriccontract

import (
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// fixture writes a throwaway module: go.mod plus the given files (paths
// relative to the module root). Nothing is compiled; Scan only parses.
func fixture(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	files["go.mod"] = "module example.com/op\n\ngo 1.25\n"
	for rel, src := range files {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(src), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

const mainImportsM = `package main

import _ "example.com/op/internal/m"

func main() {}
`

const header = `package m

import (
	"github.com/prometheus/client_golang/prometheus"
	"sigs.k8s.io/controller-runtime/pkg/metrics"
)
`

func names(fams map[string]Family) []string {
	out := make([]string, 0, len(fams))
	for n := range fams {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}

func mustScan(t *testing.T, root string) map[string]Family {
	t.Helper()
	fams, err := Scan(root, "cmd")
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	return fams
}

func TestScanReadsRegisteredMetricsWithTheirType(t *testing.T) {
	root := fixture(t, map[string]string{
		"cmd/main.go": mainImportsM,
		"internal/m/m.go": header + `
var (
	total = prometheus.NewCounterVec(prometheus.CounterOpts{Name: "knext_a_total", Help: "a"}, []string{"r"})
	dur   = prometheus.NewHistogram(prometheus.HistogramOpts{Name: "knext_b_seconds", Help: "b"})
	held  = prometheus.NewGauge(prometheus.GaugeOpts{Name: "knext_c", Help: "c"})
	q     = prometheus.NewSummaryVec(prometheus.SummaryOpts{Name: "knext_d", Help: "d"}, []string{"x"})
)

func init() {
	metrics.Registry.MustRegister(total, dur)
	metrics.Registry.MustRegister(held)
	_ = metrics.Registry.Register(q)
}
`,
	})
	got := mustScan(t, root)
	want := map[string]Family{
		"knext_a_total":   {Type: "counter", Vec: true},
		"knext_b_seconds": {Type: "histogram"},
		"knext_c":         {Type: "gauge"},
		"knext_d":         {Type: "summary", Vec: true},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

// The acceptance case: a metric DECLARED in live, uncommented Go code that is
// never registered is not emitted, so it is not in the set.
func TestScanRejectsADeclaredButUnregisteredMetric(t *testing.T) {
	root := fixture(t, map[string]string{
		"cmd/main.go": mainImportsM,
		"internal/m/m.go": header + `
var real = prometheus.NewCounter(prometheus.CounterOpts{Name: "knext_real_total"})

var ghost = prometheus.NewCounter(prometheus.CounterOpts{Name: "knext_ghost_total"})

func init() { metrics.Registry.MustRegister(real) }

func unused() { ghost.Inc() }
`,
	})
	if got := names(mustScan(t, root)); !reflect.DeepEqual(got, []string{"knext_real_total"}) {
		t.Fatalf("got %v", got)
	}
}

func TestScanIgnoresComments(t *testing.T) {
	root := fixture(t, map[string]string{
		"cmd/main.go": mainImportsM,
		"internal/m/m.go": header + `
// var ghost = prometheus.NewCounter(prometheus.CounterOpts{Name: "knext_ghost_a_total"})
/* var ghost2 = prometheus.NewGauge(prometheus.GaugeOpts{Name: "knext_ghost_b"}) */
var real = prometheus.NewCounter(prometheus.CounterOpts{Name: "knext_real_total", Help: "see http://x/y // not a comment"})

func init() {
	// metrics.Registry.MustRegister(ghost)
	metrics.Registry.MustRegister(real)
}
`,
	})
	if got := names(mustScan(t, root)); !reflect.DeepEqual(got, []string{"knext_real_total"}) {
		t.Fatalf("got %v", got)
	}
}

// A package the binary never imports never runs its init(), so its
// registrations are dead code too.
func TestScanRejectsAPackageTheBinaryDoesNotLink(t *testing.T) {
	root := fixture(t, map[string]string{
		"cmd/main.go": mainImportsM,
		"internal/m/m.go": header + `
var real = prometheus.NewCounter(prometheus.CounterOpts{Name: "knext_real_total"})

func init() { metrics.Registry.MustRegister(real) }
`,
		"internal/orphan/o.go": strings.Replace(header, "package m", "package orphan", 1) + `
var o = prometheus.NewCounter(prometheus.CounterOpts{Name: "knext_orphan_total"})

func init() { metrics.Registry.MustRegister(o) }
`,
	})
	if got := names(mustScan(t, root)); !reflect.DeepEqual(got, []string{"knext_real_total"}) {
		t.Fatalf("got %v", got)
	}
}

func TestScanFollowsTransitiveImports(t *testing.T) {
	root := fixture(t, map[string]string{
		"cmd/main.go":     mainImportsM,
		"internal/m/m.go": "package m\n\nimport _ \"example.com/op/internal/deep\"\n",
		"internal/deep/d.go": strings.Replace(header, "package m", "package deep", 1) + `
var d = prometheus.NewCounter(prometheus.CounterOpts{Name: "knext_deep_total"})

func init() { metrics.Registry.MustRegister(d) }
`,
	})
	if got := names(mustScan(t, root)); !reflect.DeepEqual(got, []string{"knext_deep_total"}) {
		t.Fatalf("got %v", got)
	}
}

func TestScanSkipsFilesExcludedByBuildConstraints(t *testing.T) {
	root := fixture(t, map[string]string{
		"cmd/main.go": mainImportsM,
		"internal/m/m.go": header + `
var real = prometheus.NewCounter(prometheus.CounterOpts{Name: "knext_real_total"})

func init() { metrics.Registry.MustRegister(real) }
`,
		"internal/m/e2e.go": "//go:build e2e\n\n" + header + `
var e = prometheus.NewCounter(prometheus.CounterOpts{Name: "knext_e2e_only_total"})

func init() { metrics.Registry.MustRegister(e) }
`,
		"internal/m/m_test.go": header + `
var tst = prometheus.NewCounter(prometheus.CounterOpts{Name: "knext_test_only_total"})

func init() { metrics.Registry.MustRegister(tst) }
`,
	})
	if got := names(mustScan(t, root)); !reflect.DeepEqual(got, []string{"knext_real_total"}) {
		t.Fatalf("got %v", got)
	}
}

// Import aliases, any variable name, an inline constructor and a name built
// from constants all resolve to the name the registry actually serves.
func TestScanResolvesAliasesInlineConstructorsAndConstantNames(t *testing.T) {
	root := fixture(t, map[string]string{
		"cmd/main.go": mainImportsM,
		"internal/m/m.go": `package m

import (
	prom "github.com/prometheus/client_golang/prometheus"
	crmetrics "sigs.k8s.io/controller-runtime/pkg/metrics"
)

const (
	ns     = "knext"
	suffix = "_total"
)

var renamedWhatever = prom.NewCounter(prom.CounterOpts{
	Namespace: ns,
	Subsystem: "folded",
	Name:      "name" + suffix,
})

func init() {
	crmetrics.Registry.MustRegister(
		renamedWhatever,
		prom.NewGaugeFunc(prom.GaugeOpts{Name: ns + "_inline"}, func() float64 { return 1 }),
	)
}
`,
	})
	got := mustScan(t, root)
	want := map[string]Family{
		"knext_folded_name_total": {Type: "counter"},
		"knext_inline":            {Type: "gauge"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

// Anything the scanner cannot prove is an ERROR, never a silent skip: a
// registration it could not read would otherwise be an emitted metric the
// contract never sees.
func TestScanFailsClosedOnShapesItCannotProve(t *testing.T) {
	cases := map[string]string{
		"a collector built by a function call": `
func newC() prometheus.Collector { return prometheus.NewCounter(prometheus.CounterOpts{Name: "knext_x_total"}) }

func init() { metrics.Registry.MustRegister(newC()) }
`,
		"a registration outside init()": `
var c = prometheus.NewCounter(prometheus.CounterOpts{Name: "knext_x_total"})

func Setup() { metrics.Registry.MustRegister(c) }
`,
		"a name from a variable, not a constant": `
var n = "knext_x_total"

var c = prometheus.NewCounter(prometheus.CounterOpts{Name: n})

func init() { metrics.Registry.MustRegister(c) }
`,
		"the registry handed to something else": `
func init() { use(metrics.Registry) }

func use(any) {}
`,
		"an unknown constructor": `
var c = prometheus.NewUntypedFunc(prometheus.UntypedOpts{Name: "knext_x"}, func() float64 { return 0 })

func init() { metrics.Registry.MustRegister(c) }
`,
		"a collector from another package": `
func init() { metrics.Registry.MustRegister(prometheus.DefaultGatherer.(prometheus.Collector)) }
`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			root := fixture(t, map[string]string{
				"cmd/main.go":     mainImportsM,
				"internal/m/m.go": header + body,
			})
			fams, err := Scan(root, "cmd")
			if err == nil {
				t.Fatalf("Scan accepted it: %+v", fams)
			}
			t.Logf("refused: %v", err)
		})
	}
}

func TestScanFailsClosedWhenNothingIsRegistered(t *testing.T) {
	root := fixture(t, map[string]string{
		"cmd/main.go": mainImportsM,
		"internal/m/m.go": header + `
var c = prometheus.NewCounter(prometheus.CounterOpts{Name: "knext_x_total"})
`,
	})
	if fams, err := Scan(root, "cmd"); err == nil {
		t.Fatalf("an empty scan passed: %+v", fams)
	}
}

func TestScanFailsClosedOnADuplicateName(t *testing.T) {
	root := fixture(t, map[string]string{
		"cmd/main.go": mainImportsM,
		"internal/m/m.go": header + `
var a = prometheus.NewCounter(prometheus.CounterOpts{Name: "knext_x_total"})
var b = prometheus.NewGauge(prometheus.GaugeOpts{Name: "knext_x_total"})

func init() { metrics.Registry.MustRegister(a, b) }
`,
	})
	if fams, err := Scan(root, "cmd"); err == nil {
		t.Fatalf("a duplicate name passed: %+v", fams)
	}
}

func TestScanFailsClosedWhenTheEntryIsNotAMainPackage(t *testing.T) {
	root := fixture(t, map[string]string{"cmd/lib.go": "package lib\n"})
	if _, err := Scan(root, "cmd"); err == nil {
		t.Fatal("a non-main entry passed")
	}
}

func TestGoldenJSONIsSortedTypedAndNewlineTerminated(t *testing.T) {
	b, err := GoldenJSON(map[string]Family{
		"knext_b": {Type: "gauge"},
		"knext_a": {Type: "counter", Vec: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	if !strings.HasSuffix(s, "}\n") {
		t.Fatalf("not newline-terminated: %q", s)
	}
	if strings.Index(s, "knext_a") > strings.Index(s, "knext_b") {
		t.Fatalf("not sorted: %s", s)
	}
	if !strings.Contains(s, `"knext_a": "counter"`) || !strings.Contains(s, `"knext_b": "gauge"`) {
		t.Fatalf("families not rendered name -> type: %s", s)
	}
	if _, err := GoldenJSON(map[string]Family{}); err == nil {
		t.Fatal("an empty golden rendered")
	}
}

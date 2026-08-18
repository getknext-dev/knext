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

package controller

import (
	"context"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// spec.scaling.scaleDownDelay (#762, ADR-0045). Two properties the sibling
// "NotTo(HaveKey(...))" assertion does NOT cover on its own:
//
//  1. the UNSET case must be byte-identical to the pre-field template, not
//     merely free of the new key — an implementation that stamps an empty
//     value, or that reorders/adds any other annotation while wiring this
//     field in, breaks back-compat just as loudly;
//  2. the RECONCILER must reject an out-of-range value too, not only the
//     webhook: a CR stored before the field's range was enforced (or written
//     while the webhook was down) reaches the shared
//     validation.ValidateNextAppSpec branch on the reconcile leg (ADR-0040).
var _ = Describe("spec.scaling.scaleDownDelay (#762, ADR-0045)", func() {
	const (
		namespace  = "default"
		validImage = "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1"
	)

	ctx := context.Background()

	storeAndReconcile := func(name string, spec appsv1alpha1.NextAppSpec) (types.NamespacedName, error) {
		nn := types.NamespacedName{Name: name, Namespace: namespace}
		nextApp := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
			Spec:       spec,
		}
		Expect(k8sClient.Create(ctx, nextApp)).To(Succeed())

		DeferCleanup(func() {
			cur := &appsv1alpha1.NextApp{}
			if err := k8sClient.Get(ctx, nn, cur); err == nil {
				Expect(k8sClient.Delete(ctx, cur)).To(Succeed())
				cleanupReconciler := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
				Eventually(func() bool {
					_, _ = cleanupReconciler.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
					return errors.IsNotFound(k8sClient.Get(ctx, nn, &appsv1alpha1.NextApp{}))
				}, 10*time.Second, 100*time.Millisecond).Should(BeTrue())
			}
		})

		reconciler := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
		_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		return nn, err
	}

	It("leaves the revision template annotations BYTE-IDENTICAL to the pre-field baseline when unset (#762 back-compat)", func() {
		nn, err := storeAndReconcile("sdd-baseline", appsv1alpha1.NextAppSpec{
			Image:   validImage,
			Scaling: &appsv1alpha1.ScalingSpec{MinScale: 0, MaxScale: 10},
		})
		Expect(err).NotTo(HaveOccurred())

		ksvc := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())

		// The COMPLETE set this exact spec produced before spec.scaling.scaleDownDelay
		// existed. Equality (not "no scale-down-delay key") is the invariant:
		// unset must change nothing at all about the template the operator writes.
		Expect(ksvc.Spec.Template.Annotations).To(Equal(map[string]string{
			"autoscaling.knative.dev/min-scale": "0",
			"autoscaling.knative.dev/max-scale": "10",
		}), "an unset scaleDownDelay must leave the revision template exactly as it was before the field existed")
	})

	It("UN-stamps the annotation when an update removes the field (#762)", func() {
		// Correct by construction — buildDesiredKsvc assigns the annotation map
		// wholesale rather than merging into the live one — but "correct by
		// construction" is exactly the claim that stops being true after an
		// innocent refactor to a merge. Removing the field must remove the
		// annotation, or a user who deletes the line keeps paying for a pod.
		nn, err := storeAndReconcile("sdd-update-removes", appsv1alpha1.NextAppSpec{
			Image:   validImage,
			Scaling: &appsv1alpha1.ScalingSpec{MinScale: 0, MaxScale: 10, ScaleDownDelay: "5m"},
		})
		Expect(err).NotTo(HaveOccurred())

		ksvc := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
		Expect(ksvc.Spec.Template.Annotations).To(
			HaveKeyWithValue("autoscaling.knative.dev/scale-down-delay", "5m"),
			"precondition: the annotation is stamped before the update")

		By("updating the NextApp to remove spec.scaling.scaleDownDelay")
		cur := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, nn, cur)).To(Succeed())
		cur.Spec.Scaling.ScaleDownDelay = ""
		Expect(k8sClient.Update(ctx, cur)).To(Succeed())

		reconciler := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
		_, err = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
		Expect(ksvc.Spec.Template.Annotations).NotTo(HaveKey("autoscaling.knative.dev/scale-down-delay"),
			"removing the field must un-stamp the annotation, restoring the Knative cluster default")
		Expect(ksvc.Spec.Template.Annotations).To(HaveKeyWithValue("autoscaling.knative.dev/max-scale", "10"),
			"and must not disturb the sibling annotations")
	})

	It("is REJECTED by the reconciler too, not only the webhook, when out of range (#762, ADR-0040 shared branch)", func() {
		// No validating webhook is installed in this suite, so this is exactly
		// the stored-CR case: the value is a plain string in the CRD schema and
		// CAN be persisted. The reconcile leg must refuse it through the same
		// shared validation branch the webhook uses.
		_, err := storeAndReconcile("sdd-reconciler-reject", appsv1alpha1.NextAppSpec{
			Image:   validImage,
			Scaling: &appsv1alpha1.ScalingSpec{ScaleDownDelay: "2h"},
		})
		Expect(err).To(HaveOccurred())
		Expect(err.Error()).To(ContainSubstring("scaleDownDelay"))
		Expect(err.Error()).To(ContainSubstring("1h"), "the error must NAME the Knative bound")
	})

	It("is REJECTED by the reconciler when it is not a duration at all (#762)", func() {
		_, err := storeAndReconcile("sdd-reconciler-garbage", appsv1alpha1.NextAppSpec{
			Image:   validImage,
			Scaling: &appsv1alpha1.ScalingSpec{ScaleDownDelay: "5 minutes"},
		})
		Expect(err).To(HaveOccurred())
		Expect(err.Error()).To(ContainSubstring("scaleDownDelay"))
	})
})

// TestEveryDurationParseOfCRInputLivesInTheValidator SCANS the operator's own
// source instead of enumerating parse sites (ADR-0045 Decision 3: "no MustParse
// at the use site"). A duration string that came from a CR must be parsed ONLY
// where a parse error can be turned into an admission/reconcile rejection —
// inside internal/validation. Anywhere else (buildDesiredKsvc in particular) a
// parse is either a panic waiting for a stored-malformed CR or a silently
// swallowed error; the stamping site must pass the validated string through
// verbatim.
//
// The scan resolves the IMPORT, not the identifier text: `gotime "time"` +
// `gotime.ParseDuration(...)`, and a dot-import of "time" calling a bare
// `ParseDuration(...)`, both compile and both are caught. Matching the literal
// name `time` was the first version of this guard and it was mutation-proved
// GREEN against the aliased form — i.e. decoration.
//
// The exemption is the validator PACKAGE DIRECTORY, matched on path segments,
// so a future `internal/validationutil` is not silently exempt by prefix.
func TestEveryDurationParseOfCRInputLivesInTheValidator(t *testing.T) {
	root := filepath.Join("..", "..")

	var offenders []string
	filesScanned := 0

	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			switch d.Name() {
			case "bin", "vendor", "node_modules", "test", "tmpmeasure", "dist":
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		fset := token.NewFileSet()
		file, perr := parser.ParseFile(fset, path, nil, 0)
		if perr != nil {
			return perr
		}
		filesScanned++
		if inValidatorPackage(path) {
			return nil
		}
		for _, hit := range durationParseHits(fset, file) {
			offenders = append(offenders, filepath.ToSlash(path)+":"+hit)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walking operator sources: %v", err)
	}
	if filesScanned == 0 {
		t.Fatal("scanned no Go files; the scan itself is broken, not passing")
	}
	if len(offenders) > 0 {
		t.Errorf("these parse a duration outside internal/validation, where a parse error cannot "+
			"become a rejection (ADR-0045: no parse/MustParse at the use site): %v", offenders)
	}
}

// TestDurationParseScannerRecognisesEveryCallForm is the scanner's SELF-PROOF.
//
// The obvious self-proof — "assert the scan found at least one real call" —
// is not available and must not be faked: knext delegates to Knative's own
// validator, so the operator's tracked sources contain NO duration parse at
// all, and an assertion that one exists would red on correct code. Instead the
// scanner is proved against fixtures covering every call form that compiles,
// including the two the first version of this guard missed.
func TestDurationParseScannerRecognisesEveryCallForm(t *testing.T) {
	cases := []struct {
		name string
		src  string
		want int
	}{
		{
			name: "plain import",
			src:  "package p\nimport \"time\"\nfunc f(s string) { _, _ = time.ParseDuration(s) }\n",
			want: 1,
		},
		{
			name: "aliased import — compiles, and the identifier-matching guard missed it",
			src:  "package p\nimport gotime \"time\"\nfunc f(s string) { _, _ = gotime.ParseDuration(s) }\n",
			want: 1,
		},
		{
			name: "dot import — bare call, also missed by identifier matching",
			src:  "package p\nimport . \"time\"\nfunc f(s string) { _, _ = ParseDuration(s) }\n",
			want: 1,
		},
		{
			name: "a DIFFERENT package's ParseDuration is not a time parse",
			src:  "package p\nimport \"other/time\"\nfunc f(s string) { _ = time.ParseDuration(s) }\n",
			want: 0,
		},
		{
			name: "an unrelated method named ParseDuration on a local value",
			src:  "package p\ntype T struct{}\nfunc (T) ParseDuration(string) {}\nfunc f(v T, s string) { v.ParseDuration(s) }\n",
			want: 0,
		},
		{
			name: "no parse at all — the shipped stamping site's shape",
			src:  "package p\nfunc f(m map[string]string, v string) { m[\"k\"] = v }\n",
			want: 0,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fset := token.NewFileSet()
			file, err := parser.ParseFile(fset, "fixture.go", tc.src, 0)
			if err != nil {
				t.Fatalf("fixture does not parse: %v", err)
			}
			hits := durationParseHits(fset, file)
			if len(hits) != tc.want {
				t.Fatalf("scanner found %d hits (%v), want %d — the scanner cannot see this call form, "+
					"so its silence over the real tree proves nothing", len(hits), hits, tc.want)
			}
		})
	}
}

// TestValidatorExemptionIsPackageScoped pins the exemption to the validator
// package DIRECTORY. A substring match ("internal/validation") would silently
// exempt a future internal/validationutil, which is how an exemption quietly
// grows into a hole.
func TestValidatorExemptionIsPackageScoped(t *testing.T) {
	exempt := []string{
		"../../internal/validation/validate.go",
		"/abs/repo/internal/validation/quantity.go",
	}
	notExempt := []string{
		"../../internal/validationutil/helper.go",
		"../../internal/controller/nextapp_controller.go",
		"../../internal/validation_helpers/x.go",
		"../../internal/webhook/v1alpha1/nextapp_webhook.go",
	}
	for _, p := range exempt {
		if !inValidatorPackage(p) {
			t.Errorf("%s must be exempt (it IS the validator package)", p)
		}
	}
	for _, p := range notExempt {
		if inValidatorPackage(p) {
			t.Errorf("%s must NOT be exempt — the exemption is the validator package, not a prefix", p)
		}
	}
}

// inValidatorPackage reports whether path lives in internal/validation, matched
// on whole path SEGMENTS.
func inValidatorPackage(path string) bool {
	dir := filepath.ToSlash(filepath.Dir(path))
	segs := strings.Split(dir, "/")
	for i := 0; i+1 < len(segs); i++ {
		if segs[i] == "internal" && segs[i+1] == "validation" {
			return true
		}
	}
	return false
}

// durationParseHits returns "<line> <form>" for every call to time.ParseDuration
// in file, resolving the local name of the "time" import rather than matching
// the identifier text — so `gotime "time"` and a dot-import are both caught,
// and another package that happens to be named `time` is not.
func durationParseHits(fset *token.FileSet, file *ast.File) []string {
	timeNames := map[string]bool{}
	timeDotImported := false
	for _, imp := range file.Imports {
		if imp.Path == nil || imp.Path.Value != `"time"` {
			continue
		}
		switch {
		case imp.Name == nil:
			timeNames["time"] = true
		case imp.Name.Name == ".":
			timeDotImported = true
		case imp.Name.Name == "_":
			// A blank import cannot be called through.
		default:
			timeNames[imp.Name.Name] = true
		}
	}

	var hits []string
	ast.Inspect(file, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		switch fun := call.Fun.(type) {
		case *ast.SelectorExpr:
			pkg, ok := fun.X.(*ast.Ident)
			if !ok || !timeNames[pkg.Name] || fun.Sel.Name != "ParseDuration" {
				return true
			}
			hits = append(hits, fmt.Sprintf("%d %s.ParseDuration (import \"time\")",
				fset.Position(call.Pos()).Line, pkg.Name))
		case *ast.Ident:
			if !timeDotImported || fun.Name != "ParseDuration" {
				return true
			}
			hits = append(hits, fmt.Sprintf("%d ParseDuration (dot-imported \"time\")",
				fset.Position(call.Pos()).Line))
		}
		return true
	})
	return hits
}

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
// Literal-argument calls are allowed and are what proves the scanner recognises
// real duration-parse call expressions rather than finding nothing.
func TestEveryDurationParseOfCRInputLivesInTheValidator(t *testing.T) {
	root := filepath.Join("..", "..")
	validatorDir := filepath.Join("internal", "validation")

	var offenders []string
	recognisedCalls, filesScanned := 0, 0

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
		inValidator := strings.Contains(path, validatorDir)
		ast.Inspect(file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			pkg, ok := sel.X.(*ast.Ident)
			if !ok || pkg.Name != "time" {
				return true
			}
			if sel.Sel.Name != "ParseDuration" {
				return true
			}
			recognisedCalls++
			if inValidator {
				return true
			}
			offenders = append(offenders, fmt.Sprintf("%s:%d time.ParseDuration",
				filepath.ToSlash(path), fset.Position(call.Pos()).Line))
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatalf("walking operator sources: %v", err)
	}
	if filesScanned == 0 {
		t.Fatal("scanned no Go files; the scan itself is broken, not passing")
	}
	if recognisedCalls == 0 {
		t.Fatal("scan found no time.ParseDuration call at all — the CR duration field is not " +
			"being parsed anywhere, so this scan's silence proves nothing")
	}
	if len(offenders) > 0 {
		t.Errorf("these parse a duration outside internal/validation, where a parse error cannot "+
			"become a rejection (ADR-0045: no MustParse/parse at the use site): %v", offenders)
	}
}

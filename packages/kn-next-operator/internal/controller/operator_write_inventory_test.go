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

// Lockstep between what the operator's code WRITES and what the shipped
// ValidatingAdmissionPolicy lets the operator's ServiceAccount write.
//
// The policy (config/admission) refuses every Secret / ConfigMap write by the
// operator unless the name ends in an allowed suffix. If the code ever writes a
// name the policy does not allow, the reconciler breaks in production; if the
// policy keeps a suffix the code no longer writes, the narrowing is wider than
// the operator needs. Both directions are pinned here, and the inventory is a
// SCAN of the operator's type-checked source, not a hand-kept list:
//
//  1. TYPED writes. Every call of a write verb (Create, Update, Patch, Delete,
//     DeleteAllOf, Apply, CreateOrUpdate, CreateOrPatch) whose object argument
//     is a core/v1 Secret or ConfigMap (or a list of them) is found by static
//     type, whatever the variable is called and however the client is reached.
//     The set must equal the registry below, and each registry entry names the
//     helper that spells the object's name; the writer's own ObjectMeta must
//     take its name from that helper, so a second, differently named object
//     cannot hide behind the same function.
//  2. DYNAMIC writes: the object argument is an interface (client.Object,
//     runtime.Object) or an unstructured/metadata-only object, so its kind is
//     not visible in the type. Each such site must be justified in
//     dynamicWriteAllowlist, its object must be built inside the function, and
//     the function must not mention a Secret or ConfigMap type.
//  3. Kind and resource literals. A constant "Secret" / "ConfigMap" / "secrets"
//     / "configmaps" anywhere in the operator's non-test source must sit in a
//     function that never writes (the two metadata-only reads), so an
//     unstructured write cannot name one of the two kinds without reddening.
//  4. Typed clientsets and apply configurations for either kind are not used.
//
// To legitimately add a Secret or ConfigMap writer: add its helper and a
// registry entry here, extend the policy's allow-list in
// config/admission/secret-configmap-writes.yaml, and update
// docs/security/threat-model.md, in the same change.

import (
	"go/ast"
	"go/constant"
	"go/token"
	"go/types"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"golang.org/x/tools/go/packages"
	"golang.org/x/tools/go/types/typeutil"
	admissionregistrationv1 "k8s.io/api/admissionregistration/v1"
	"sigs.k8s.io/yaml"
)

const (
	operatorModulePath = "github.com/AhmedElBanna80/knext/packages/kn-next-operator"
	corev1PkgPath      = "k8s.io/api/core/v1"
)

// operatorWriter is one Secret or ConfigMap the operator creates and updates.
type operatorWriter struct {
	// Func is the function that makes the write, as the scan prints it.
	Func string
	// Resource is the plural core/v1 resource written: "secrets" or "configmaps".
	Resource string
	// Verbs are the write verbs that function uses on it.
	Verbs []string
	// NameFunc is the helper that spells the object's name; the policy suffix
	// is derived by CALLING it, not by restating the string.
	NameFunc string
	// Name is the same helper, callable: a zone's name in, the object's name out.
	Name func(zone string) string
}

// operatorWriters is the registry the scan is held to, in both directions.
var operatorWriters = []operatorWriter{
	{
		Func: "(*NextAppReconciler).writeSigningKeySecret", Resource: "secrets",
		Verbs: []string{"Create", "Update"}, NameFunc: "ZoneSigningKeySecretName", Name: ZoneSigningKeySecretName,
	},
	{
		Func: "(*NextAppReconciler).writeJWKSConfigMap", Resource: "configmaps",
		Verbs: []string{"Create", "Update"}, NameFunc: "ZoneJWKSConfigMapName", Name: ZoneJWKSConfigMapName,
	},
}

// dynamicWriteAllowlist justifies each write whose object kind the type does not
// show. The scan still enforces the closure rules on every entry.
var dynamicWriteAllowlist = map[string]string{
	"(*BackendServiceReconciler).removeRendered": "deletes the function's own Knative Service and " +
		"NetworkPolicy, both built as literals in the same function",
	"(*NextAppReconciler).Reconcile": "creates and updates the Knative caching Image (an unstructured object whose " +
		"kind is the literal \"Image\") and the KafkaSource built by buildKafkaSource (kind \"KafkaSource\"); Reconcile " +
		"names no Secret or ConfigMap type, and the zone key and JWKS are written by the registered writers it calls",
}

// readOnlyKindUses lists the functions that may spell "Secret" / "ConfigMap" as
// a kind: both fetch metadata only, and the scan asserts they never write.
var readOnlyKindUses = map[string]string{
	"(*BackendServiceReconciler).secretMetadata":  "metadata-only GET of a Secret a function references",
	"(*BackendServiceReconciler).observeZoneJWKS": "metadata-only GET of the zone's JWKS ConfigMap",
}

var writeVerbs = map[string]bool{
	"Create": true, "Update": true, "Patch": true, "Delete": true,
	"DeleteAllOf": true, "Apply": true, "CreateOrUpdate": true, "CreateOrPatch": true,
}

// writeSite is one call of a write verb on a Secret, a ConfigMap or an object of
// an unknown kind.
type writeSite struct {
	pos      string
	fn       string
	verb     string
	resource string // "secrets", "configmaps" or "dynamic"
	local    bool   // dynamic only: the object variable is declared in the function
}

type operatorScan struct {
	writes       []writeSite
	kindLiterals []literalSite
	// funcWrites is every function that makes any write call.
	funcWrites map[string]bool
	// typeRefs is every function that names a core/v1 Secret or ConfigMap type.
	typeRefs map[string]bool
	// nameFuncs maps a writer function to the helpers its ObjectMeta literals call.
	nameFuncs map[string][]string
	// nonConstKind lists functions that set an object's kind from a non-constant
	// value (a user-supplied kind) and also write.
	nonConstKind map[string]string
	// clientsetUses lists every use of a typed clientset or apply configuration
	// for the two kinds.
	clientsetUses []string
	files         int
}

type literalSite struct{ pos, fn, value string }

func shortFuncName(full string) string {
	return strings.ReplaceAll(full, operatorModulePath+"/internal/controller.", "")
}

// scanOperatorWrites type-checks the operator's non-test source and collects
// every Secret / ConfigMap write it can find.
func scanOperatorWrites(t *testing.T) *operatorScan {
	t.Helper()
	cfg := &packages.Config{
		Mode: packages.NeedName | packages.NeedFiles | packages.NeedSyntax | packages.NeedTypes |
			packages.NeedTypesInfo | packages.NeedImports,
		Dir: filepath.Join("..", ".."),
	}
	pkgs, err := packages.Load(cfg, "./cmd/...", "./internal/...", "./api/...")
	if err != nil {
		t.Fatalf("load the operator's packages: %v", err)
	}
	scan := &operatorScan{
		funcWrites: map[string]bool{}, typeRefs: map[string]bool{},
		nameFuncs: map[string][]string{}, nonConstKind: map[string]string{},
	}
	sawController := false
	for _, p := range pkgs {
		if len(p.Errors) > 0 {
			t.Fatalf("package %s does not type-check (%v); the scan would be blind to it", p.PkgPath, p.Errors[0])
		}
		if p.PkgPath == operatorModulePath+"/internal/controller" {
			sawController = true
		}
		for _, file := range p.Syntax {
			scan.files++
			for _, decl := range file.Decls {
				fd, ok := decl.(*ast.FuncDecl)
				if !ok || fd.Body == nil {
					continue
				}
				scan.scanFunc(p, fd)
			}
			scan.scanPackageLevel(p, file)
		}
	}
	// Both halves: a scan that never saw the reconcilers proves nothing.
	if !sawController || scan.files < 20 {
		t.Fatalf("scanned %d files (controller package seen: %v); the inventory would pass vacuously", scan.files, sawController)
	}
	return scan
}

func (s *operatorScan) scanFunc(p *packages.Package, fd *ast.FuncDecl) {
	obj, _ := p.TypesInfo.Defs[fd.Name].(*types.Func)
	if obj == nil {
		return
	}
	name := shortFuncName(obj.FullName())
	body := fd.Body
	ast.Inspect(body, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.CallExpr:
			s.scanCall(p, name, body, x)
		case *ast.SelectorExpr:
			s.scanSelector(p, name, x)
		case *ast.BasicLit:
			s.scanLiteral(p, name, x)
		case *ast.CompositeLit:
			s.scanObjectMeta(p, name, x)
		}
		return true
	})
}

// scanPackageLevel picks up constants and declarations outside any function.
func (s *operatorScan) scanPackageLevel(p *packages.Package, file *ast.File) {
	for _, decl := range file.Decls {
		if _, isFunc := decl.(*ast.FuncDecl); isFunc {
			continue
		}
		ast.Inspect(decl, func(n ast.Node) bool {
			switch x := n.(type) {
			case *ast.BasicLit:
				s.scanLiteral(p, "(package level)", x)
			case *ast.SelectorExpr:
				s.scanSelector(p, "(package level)", x)
			}
			return true
		})
	}
}

func (s *operatorScan) scanLiteral(p *packages.Package, fn string, lit *ast.BasicLit) {
	if lit.Kind != token.STRING {
		return
	}
	tv, ok := p.TypesInfo.Types[lit]
	if !ok || tv.Value == nil || tv.Value.Kind() != constant.String {
		return
	}
	switch v := constant.StringVal(tv.Value); v {
	case "Secret", "ConfigMap", "secrets", "configmaps":
		s.kindLiterals = append(s.kindLiterals, literalSite{pos: p.Fset.Position(lit.Pos()).String(), fn: fn, value: v})
	}
}

// scanSelector records references to the two core types and to the typed
// clientset / apply-configuration surface for them.
func (s *operatorScan) scanSelector(p *packages.Package, fn string, sel *ast.SelectorExpr) {
	obj := p.TypesInfo.Uses[sel.Sel]
	if obj == nil || obj.Pkg() == nil {
		return
	}
	switch obj.Pkg().Path() {
	case corev1PkgPath:
		if tn, ok := obj.(*types.TypeName); ok && coreResource(tn.Name()) != "" {
			s.typeRefs[fn] = true
		}
	case "k8s.io/client-go/kubernetes/typed/core/v1":
		switch obj.Name() {
		case "SecretInterface", "ConfigMapInterface", "SecretsGetter", "ConfigMapsGetter", "SecretExpansion", "ConfigMapExpansion":
			s.clientsetUses = append(s.clientsetUses, p.Fset.Position(sel.Pos()).String()+" "+obj.Name())
		}
	case "k8s.io/client-go/applyconfigurations/core/v1":
		switch obj.Name() {
		case "Secret", "ConfigMap", "SecretApplyConfiguration", "ConfigMapApplyConfiguration":
			s.clientsetUses = append(s.clientsetUses, p.Fset.Position(sel.Pos()).String()+" "+obj.Name())
		}
	}
}

// coreResource maps a core/v1 type name to the plural resource it serves.
func coreResource(typeName string) string {
	switch typeName {
	case "Secret", "SecretList":
		return "secrets"
	case "ConfigMap", "ConfigMapList":
		return "configmaps"
	}
	return ""
}

// classifyObjectArg says what a write call's argument can be: "secrets",
// "configmaps", "dynamic" (an interface or a kind-erased object) or "".
func classifyObjectArg(t types.Type) string {
	if t == nil {
		return ""
	}
	for {
		switch u := t.(type) {
		case *types.Pointer:
			t = u.Elem()
			continue
		case *types.Slice:
			t = u.Elem()
			continue
		}
		break
	}
	if named, ok := t.(*types.Named); ok && named.Obj().Pkg() != nil {
		switch named.Obj().Pkg().Path() {
		case corev1PkgPath:
			return coreResource(named.Obj().Name())
		case "k8s.io/apimachinery/pkg/apis/meta/v1/unstructured":
			return "dynamic"
		case "k8s.io/apimachinery/pkg/apis/meta/v1":
			if strings.HasPrefix(named.Obj().Name(), "PartialObjectMetadata") {
				return "dynamic"
			}
		}
	}
	if iface, ok := t.Underlying().(*types.Interface); ok {
		if iface.Empty() {
			return "dynamic"
		}
		hasKind, hasCopy := false, false
		for i := 0; i < iface.NumMethods(); i++ {
			switch iface.Method(i).Name() {
			case "GetObjectKind":
				hasKind = true
			case "DeepCopyObject":
				hasCopy = true
			}
		}
		if hasKind && hasCopy {
			return "dynamic"
		}
	}
	return ""
}

func (s *operatorScan) scanCall(p *packages.Package, fn string, body *ast.BlockStmt, call *ast.CallExpr) {
	callee, _ := typeutil.Callee(p.TypesInfo, call).(*types.Func)
	if callee == nil {
		return
	}
	// A kind set from a non-constant value, in a function that also writes, is
	// reported after the walk (the write may come later in the function).
	switch callee.Name() {
	case "SetKind", "SetGroupVersionKind", "WithKind":
		if len(call.Args) == 1 {
			if tv, ok := p.TypesInfo.Types[call.Args[0]]; ok && tv.Value == nil && callee.Name() != "SetGroupVersionKind" {
				s.nonConstKind[fn] = p.Fset.Position(call.Pos()).String()
			}
		}
	}
	if !writeVerbs[callee.Name()] {
		return
	}
	for _, arg := range call.Args {
		kind := classifyObjectArg(p.TypesInfo.TypeOf(arg))
		if kind == "" {
			continue
		}
		s.funcWrites[fn] = true
		site := writeSite{pos: p.Fset.Position(call.Pos()).String(), fn: fn, verb: callee.Name(), resource: kind}
		if kind == "dynamic" {
			site.local = argDeclaredIn(p, arg, body)
		}
		s.writes = append(s.writes, site)
	}
}

// argDeclaredIn reports whether the object an argument names is a variable
// declared inside body (not a parameter handed in by a caller).
func argDeclaredIn(p *packages.Package, arg ast.Expr, body *ast.BlockStmt) bool {
	for {
		switch x := arg.(type) {
		case *ast.UnaryExpr:
			arg = x.X
			continue
		case *ast.ParenExpr:
			arg = x.X
			continue
		}
		break
	}
	id, ok := arg.(*ast.Ident)
	if !ok {
		// A literal built in place has no outside origin.
		_, isLit := arg.(*ast.CompositeLit)
		return isLit
	}
	obj := p.TypesInfo.Uses[id]
	return obj != nil && obj.Pos() >= body.Pos() && obj.Pos() <= body.End()
}

// scanObjectMeta records, for a metav1.ObjectMeta literal, the name helpers its
// Name field calls (and a marker for a Name that is not a helper call).
func (s *operatorScan) scanObjectMeta(p *packages.Package, fn string, lit *ast.CompositeLit) {
	tv, ok := p.TypesInfo.Types[lit]
	if !ok {
		return
	}
	named, ok := tv.Type.(*types.Named)
	if !ok || named.Obj().Pkg() == nil || named.Obj().Pkg().Path() != "k8s.io/apimachinery/pkg/apis/meta/v1" || named.Obj().Name() != "ObjectMeta" {
		return
	}
	for _, el := range lit.Elts {
		kv, ok := el.(*ast.KeyValueExpr)
		if !ok {
			continue
		}
		if key, ok := kv.Key.(*ast.Ident); !ok || key.Name != "Name" {
			continue
		}
		helper := "(not a helper call)"
		if call, ok := kv.Value.(*ast.CallExpr); ok {
			if callee, _ := typeutil.Callee(p.TypesInfo, call).(*types.Func); callee != nil {
				helper = callee.Name()
			}
		}
		s.nameFuncs[fn] = append(s.nameFuncs[fn], helper)
	}
}

// typedWriters folds the typed write sites into function -> resource -> verbs.
func (s *operatorScan) typedWriters() map[string]map[string]bool {
	out := map[string]map[string]bool{}
	for _, w := range s.writes {
		if w.resource != "secrets" && w.resource != "configmaps" {
			continue
		}
		key := w.fn + " " + w.resource
		if out[key] == nil {
			out[key] = map[string]bool{}
		}
		out[key][w.verb] = true
	}
	return out
}

func sortedVerbSet(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// TestOperatorSecretAndConfigMapWritersMatchTheRegistry pins rule 1: the typed
// writes found in the source are exactly the registry, verb for verb, and each
// writer names its object with the registered helper and nothing else.
func TestOperatorSecretAndConfigMapWritersMatchTheRegistry(t *testing.T) {
	scan := scanOperatorWrites(t)
	found := scan.typedWriters()

	want := map[string]bool{}
	for _, w := range operatorWriters {
		key := w.Func + " " + w.Resource
		want[key] = true
		got, ok := found[key]
		if !ok {
			t.Errorf("registry entry %s writes no %s any more; remove it and its policy suffix", w.Func, w.Resource)
			continue
		}
		if g, e := strings.Join(sortedVerbSet(got), ","), strings.Join(sortedVerbList(w.Verbs), ","); g != e {
			t.Errorf("%s uses verbs [%s] on %s, the registry says [%s]", w.Func, g, w.Resource, e)
		}
		helpers := scan.nameFuncs[w.Func]
		if len(helpers) == 0 {
			t.Errorf("%s builds no ObjectMeta with a Name; the registry's name helper %s is not what names the object", w.Func, w.NameFunc)
		}
		for _, h := range helpers {
			if h != w.NameFunc {
				t.Errorf("%s names an object with %s, but the registry (and so the policy) allows only %s", w.Func, h, w.NameFunc)
			}
		}
	}
	for key, verbs := range found {
		if !want[key] {
			t.Errorf("%s writes with [%s] and is not in the registry: the policy would refuse it in a cluster. "+
				"Register the writer, add its name suffix to config/admission/secret-configmap-writes.yaml, "+
				"and update docs/security/threat-model.md", key, strings.Join(sortedVerbSet(verbs), ","))
		}
	}
	// Both halves: the scan must have found the writers it is judging.
	if len(found) == 0 {
		t.Fatal("the scan found no Secret or ConfigMap write at all; it is blind and would pass vacuously")
	}
}

func sortedVerbList(v []string) []string {
	out := append([]string(nil), v...)
	sort.Strings(out)
	return out
}

// TestOperatorDynamicWritesAreJustifiedAndClosed pins rule 2.
func TestOperatorDynamicWritesAreJustifiedAndClosed(t *testing.T) {
	scan := scanOperatorWrites(t)
	seen := map[string]bool{}
	for _, w := range scan.writes {
		if w.resource != "dynamic" {
			continue
		}
		seen[w.fn] = true
		if why, ok := dynamicWriteAllowlist[w.fn]; !ok || strings.TrimSpace(why) == "" {
			t.Errorf("%s: %s of an object whose kind the type does not show, and %s has no justified entry in "+
				"dynamicWriteAllowlist. It could be a Secret or a ConfigMap the policy would refuse.", w.pos, w.verb, w.fn)
		}
		if !w.local {
			t.Errorf("%s: %s writes an object that %s did not build (a parameter): its kind cannot be shown", w.pos, w.verb, w.fn)
		}
		if scan.typeRefs[w.fn] {
			t.Errorf("%s: %s names a core/v1 Secret or ConfigMap type and also writes an object of unknown kind", w.pos, w.fn)
		}
	}
	for fn := range dynamicWriteAllowlist {
		if !seen[fn] {
			t.Errorf("dynamicWriteAllowlist entry %q matches no dynamic write; remove it (a stale waiver pre-authorises a future one)", fn)
		}
	}
	for fn, pos := range scan.nonConstKind {
		if scan.funcWrites[fn] {
			t.Errorf("%s sets an object's kind from a non-constant value and also writes (%s): the kind could be Secret or ConfigMap", fn, pos)
		}
	}
}

// TestOperatorKindLiteralsLiveOnlyInReadOnlyFunctions pins rules 3 and 4.
func TestOperatorKindLiteralsLiveOnlyInReadOnlyFunctions(t *testing.T) {
	scan := scanOperatorWrites(t)
	seen := map[string]bool{}
	for _, l := range scan.kindLiterals {
		seen[l.fn] = true
		if _, ok := readOnlyKindUses[l.fn]; !ok {
			t.Errorf("%s: %q appears in %s, which is not a registered read-only function. A write that names "+
				"Secret or ConfigMap by kind is invisible to the type scan.", l.pos, l.value, l.fn)
			continue
		}
		if scan.funcWrites[l.fn] {
			t.Errorf("%s: %s spells %q and also writes; a read-only function may not", l.pos, l.fn, l.value)
		}
	}
	for fn := range readOnlyKindUses {
		if !seen[fn] {
			t.Errorf("readOnlyKindUses entry %q spells no Secret/ConfigMap kind any more; remove it", fn)
		}
	}
	for _, u := range scan.clientsetUses {
		t.Errorf("typed clientset or apply configuration for Secrets/ConfigMaps used at %s; the policy inventory does not follow it", u)
	}
}

// loadShippedWritePolicy reads the shipped policy (config/admission).
func loadShippedWritePolicy(t *testing.T) (*admissionregistrationv1.ValidatingAdmissionPolicy, *admissionregistrationv1.ValidatingAdmissionPolicyBinding) {
	t.Helper()
	dir := filepath.Join("..", "..", "config", "admission")
	var policy *admissionregistrationv1.ValidatingAdmissionPolicy
	var binding *admissionregistrationv1.ValidatingAdmissionPolicyBinding
	files, err := filepath.Glob(filepath.Join(dir, "*.yaml"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no admission manifests under %s (err %v): the operator bundle ships no write policy", dir, err)
	}
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, doc := range strings.Split(string(raw), "\n---") {
			var head struct {
				Kind string `json:"kind"`
			}
			if err := yaml.Unmarshal([]byte(doc), &head); err != nil {
				t.Fatalf("%s: %v", f, err)
			}
			switch head.Kind {
			case "ValidatingAdmissionPolicy":
				policy = &admissionregistrationv1.ValidatingAdmissionPolicy{}
				if err := yaml.UnmarshalStrict([]byte(doc), policy); err != nil {
					t.Fatalf("%s: %v", f, err)
				}
			case "ValidatingAdmissionPolicyBinding":
				binding = &admissionregistrationv1.ValidatingAdmissionPolicyBinding{}
				if err := yaml.UnmarshalStrict([]byte(doc), binding); err != nil {
					t.Fatalf("%s: %v", f, err)
				}
			}
		}
	}
	if policy == nil || binding == nil {
		t.Fatalf("config/admission must hold both a ValidatingAdmissionPolicy and its Binding (policy %v, binding %v)", policy != nil, binding != nil)
	}
	return policy, binding
}

var quotedCEL = regexp.MustCompile(`'([^']*)'`)

// policyAllowList returns the suffixes the policy allows for a resource.
func policyAllowList(t *testing.T, policy *admissionregistrationv1.ValidatingAdmissionPolicy, variable string) []string {
	t.Helper()
	for _, v := range policy.Spec.Variables {
		if v.Name != variable {
			continue
		}
		var out []string
		for _, m := range quotedCEL.FindAllStringSubmatch(v.Expression, -1) {
			out = append(out, m[1])
		}
		sort.Strings(out)
		if len(out) == 0 {
			t.Fatalf("policy variable %s holds no quoted suffix: %q", variable, v.Expression)
		}
		return out
	}
	t.Fatalf("policy has no variable %q", variable)
	return nil
}

// writerSuffix derives the suffix a name helper appends, by calling it.
func writerSuffix(t *testing.T, w operatorWriter) string {
	t.Helper()
	const probe = "probe-zone"
	name := w.Name(probe)
	if !strings.HasPrefix(name, probe) || len(name) == len(probe) {
		t.Fatalf("%s(%q) = %q: not a pure suffix of the zone name, so the policy cannot allow it by suffix", w.NameFunc, probe, name)
	}
	suffix := strings.TrimPrefix(name, probe)
	if other := w.Name("a"); other != "a"+suffix {
		t.Fatalf("%s is not a fixed suffix: %q for %q, %q for %q", w.NameFunc, name, probe, other, "a")
	}
	return suffix
}

// TestPolicyAllowListEqualsWhatTheOperatorWrites pins the lockstep: per resource,
// the policy allows exactly the suffixes the registered writers append.
func TestPolicyAllowListEqualsWhatTheOperatorWrites(t *testing.T) {
	policy, _ := loadShippedWritePolicy(t)
	want := map[string][]string{}
	for _, w := range operatorWriters {
		want[w.Resource] = append(want[w.Resource], writerSuffix(t, w))
	}
	for r := range want {
		sort.Strings(want[r])
	}
	for resource, variable := range map[string]string{"secrets": "allowedSecretSuffixes", "configmaps": "allowedConfigMapSuffixes"} {
		got := policyAllowList(t, policy, variable)
		if strings.Join(got, "|") != strings.Join(want[resource], "|") {
			t.Errorf("the policy allows %s names ending %v, the operator writes %v: they must match "+
				"(a missing suffix breaks the reconciler; an extra one widens the operator's write power)",
				resource, got, want[resource])
		}
	}
}

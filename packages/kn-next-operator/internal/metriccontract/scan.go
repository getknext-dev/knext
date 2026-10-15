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

// Package metriccontract derives the metric families the operator binary
// serves on its /metrics endpoint, from the parsed Go source, for the
// observability metric contract (packages/kn-next/src/adapters/metric-contract.ts).
//
// It reads the AST, never text, and it counts a metric only when it is LIVE:
//   - the package is linked into the binary (reachable from cmd/'s imports,
//     honouring build constraints, test files excluded) — for EVERY architecture
//     the image ships, and the architectures must agree;
//   - the collector is registered on controller-runtime's metrics.Registry (the
//     registry /metrics serves) from an init() function;
//   - the collector is an unexported package-level variable that nothing in the
//     package assigns besides its declaration, or an inline call, built by a
//     known prometheus constructor, and its name is a compile-time constant of
//     the package.
//
// Identifiers are resolved by SCOPE (go/types), never by name: a local variable
// or constant that shadows the package-level one is a different object, and a
// package variable that is reassigned (or whose address escapes) may not hold
// what its declaration says by the time it is registered.
//
// A metric declared but never registered, a registration in a comment or in a
// package the binary does not import, is not counted. Anything the scanner
// cannot prove (a registration outside init(), a collector built by a helper
// function, a name held in a variable, a shadowed or reassigned identifier, the
// registry handed to anything else) is an ERROR, never a silent skip, and so is
// an empty result: a registration the scanner could not read would otherwise
// be an emitted metric the contract never sees.
package metriccontract

import (
	"encoding/json"
	"errors"
	"fmt"
	"go/ast"
	"go/build"
	"go/parser"
	"go/token"
	"go/types"
	"os"
	"path"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
)

// GoldenPath is the committed golden, relative to the operator module root.
// The TS metric contract reads it; golden_test.go keeps it current.
const GoldenPath = "internal/metriccontract/operator-metrics.golden.json"

// ShippedArchs are the linux architectures the operator image is built for
// (.github/workflows/operator-supply-chain.yml `platforms:`). Each is scanned,
// and a registration only one of them links is an error.
var ShippedArchs = []string{"amd64", "arm64"}

const (
	promPath      = "github.com/prometheus/client_golang/prometheus"
	crMetricsPath = "sigs.k8s.io/controller-runtime/pkg/metrics"
)

// Family is one registered metric family.
type Family struct {
	// Type is the exposition type: counter | gauge | histogram | summary.
	Type string
	// Vec is true for a *Vec, which the registry omits from Gather until it has
	// a child. Not part of the golden.
	Vec bool
}

var constructors = map[string]Family{
	"NewCounter":      {Type: "counter"},
	"NewCounterVec":   {Type: "counter", Vec: true},
	"NewCounterFunc":  {Type: "counter"},
	"NewGauge":        {Type: "gauge"},
	"NewGaugeVec":     {Type: "gauge", Vec: true},
	"NewGaugeFunc":    {Type: "gauge"},
	"NewHistogram":    {Type: "histogram"},
	"NewHistogramVec": {Type: "histogram", Vec: true},
	"NewSummary":      {Type: "summary"},
	"NewSummaryVec":   {Type: "summary", Vec: true},
}

// Scan returns every metric family the binary built from mainDir (relative to
// moduleRoot) registers on controller-runtime's metrics.Registry, for every
// shipped architecture. The architectures must register the same set.
func Scan(moduleRoot, mainDir string) (map[string]Family, error) {
	var first map[string]Family
	for i, arch := range ShippedArchs {
		fams, err := scanArch(moduleRoot, mainDir, arch)
		if err != nil {
			return nil, fmt.Errorf("linux/%s: %w", arch, err)
		}
		if i == 0 {
			first = fams
			continue
		}
		if diff := diffFamilies(first, fams); diff != "" {
			return nil, fmt.Errorf("the linux/%s and linux/%s builds register different metrics, "+
				"so one golden cannot describe the image: %s", ShippedArchs[0], arch, diff)
		}
	}
	return first, nil
}

func diffFamilies(a, b map[string]Family) string {
	var out []string
	for n, f := range a {
		if g, ok := b[n]; !ok {
			out = append(out, fmt.Sprintf("%s only on linux/%s", n, ShippedArchs[0]))
		} else if !reflect.DeepEqual(f, g) {
			out = append(out, fmt.Sprintf("%s is %+v on one and %+v on the other", n, f, g))
		}
	}
	for n := range b {
		if _, ok := a[n]; !ok {
			out = append(out, fmt.Sprintf("%s only on the other architecture", n))
		}
	}
	sort.Strings(out)
	return strings.Join(out, "; ")
}

func scanArch(moduleRoot, mainDir, arch string) (map[string]Family, error) {
	modPath, err := modulePath(moduleRoot)
	if err != nil {
		return nil, err
	}
	ctx := build.Default
	ctx.GOOS, ctx.GOARCH, ctx.CgoEnabled = "linux", arch, false // the shipped image's build

	fset := token.NewFileSet()
	out := map[string]Family{}
	seen := map[string]bool{}
	queue := []string{filepath.Clean(mainDir)}
	for len(queue) > 0 {
		rel := queue[0]
		queue = queue[1:]
		if seen[rel] {
			continue
		}
		seen[rel] = true
		dir := filepath.Join(moduleRoot, rel)
		bp, err := ctx.ImportDir(dir, 0)
		if err != nil {
			return nil, fmt.Errorf("reading package %s: %w", rel, err)
		}
		if rel == filepath.Clean(mainDir) && bp.Name != "main" {
			return nil, fmt.Errorf("%s is package %q, not the binary's main package", rel, bp.Name)
		}
		for _, imp := range bp.Imports {
			if imp == modPath {
				queue = append(queue, ".")
			} else if strings.HasPrefix(imp, modPath+"/") {
				queue = append(queue, filepath.FromSlash(strings.TrimPrefix(imp, modPath+"/")))
			}
		}
		pkg, err := parsePackage(fset, dir, path.Join(modPath, filepath.ToSlash(rel)), bp.GoFiles)
		if err != nil {
			return nil, err
		}
		if err := pkg.collect(out); err != nil {
			return nil, err
		}
	}
	if len(out) == 0 {
		return nil, errors.New("no metric is registered on metrics.Registry from a package the binary links; " +
			"an empty scan would make every consumer of the contract vacuous")
	}
	return out, nil
}

// GoldenJSON renders the golden: name -> type, sorted, newline-terminated.
func GoldenJSON(fams map[string]Family) ([]byte, error) {
	if len(fams) == 0 {
		return nil, errors.New("refusing to render an empty golden")
	}
	doc := struct {
		Comment  string            `json:"$comment"`
		Families map[string]string `json:"families"`
	}{
		Comment: "GENERATED - do not edit. The metric families the operator binary registers on its " +
			"/metrics endpoint, scanned from the Go AST. Regenerate: " +
			"KNEXT_UPDATE_METRIC_GOLDEN=1 go test ./internal/metriccontract/",
		Families: map[string]string{},
	}
	for name, f := range fams {
		doc.Families[name] = f.Type
	}
	b, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}

func modulePath(root string) (string, error) {
	b, err := os.ReadFile(filepath.Join(root, "go.mod"))
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(b), "\n") {
		if f := strings.Fields(line); len(f) == 2 && f[0] == "module" {
			return strings.Trim(f[1], `"`), nil
		}
	}
	return "", fmt.Errorf("%s/go.mod has no module line", root)
}

// pkg is one parsed package: its files, its package-level vars and consts, and
// the go/types scope information that ties every identifier to its object.
type pkg struct {
	fset   *token.FileSet
	files  []*ast.File
	vars   map[string]valueRef
	consts map[string]ast.Expr
	scope  *types.Scope
	info   *types.Info
	// assigned is every package-level variable assigned (or address-taken)
	// anywhere in the package besides its declaration, with the first site.
	assigned map[*types.Var]token.Pos
}

type valueRef struct {
	expr ast.Expr
}

// stubImporter satisfies every import with an empty package. The scan needs
// go/types only for SCOPE — which object an identifier names — never for the
// types of other packages, so nothing outside this module is loaded and the
// type errors that follow (every selector into a stub is undefined) are
// discarded. Identifier resolution does not depend on them.
type stubImporter map[string]*types.Package

func (s stubImporter) Import(p string) (*types.Package, error) {
	if p == "unsafe" {
		return types.Unsafe, nil
	}
	if tp, ok := s[p]; ok {
		return tp, nil
	}
	tp := types.NewPackage(p, defaultImportName(p))
	tp.MarkComplete()
	s[p] = tp
	return tp, nil
}

func defaultImportName(p string) string { return p[strings.LastIndex(p, "/")+1:] }

func parsePackage(fset *token.FileSet, dir, importPath string, goFiles []string) (*pkg, error) {
	p := &pkg{fset: fset, vars: map[string]valueRef{}, consts: map[string]ast.Expr{}}
	for _, name := range goFiles {
		f, err := parser.ParseFile(fset, filepath.Join(dir, name), nil, parser.SkipObjectResolution)
		if err != nil {
			return nil, err
		}
		p.files = append(p.files, f)
		for _, decl := range f.Decls {
			gd, ok := decl.(*ast.GenDecl)
			if !ok || (gd.Tok != token.VAR && gd.Tok != token.CONST) {
				continue
			}
			for _, spec := range gd.Specs {
				vs := spec.(*ast.ValueSpec)
				for i, id := range vs.Names {
					var val ast.Expr
					if len(vs.Values) == len(vs.Names) {
						val = vs.Values[i]
					}
					if gd.Tok == token.VAR {
						p.vars[id.Name] = valueRef{expr: val}
					} else {
						p.consts[id.Name] = val
					}
				}
			}
		}
	}
	p.info = &types.Info{Uses: map[*ast.Ident]types.Object{}, Defs: map[*ast.Ident]types.Object{}}
	conf := types.Config{Importer: stubImporter{}, Error: func(error) {}, FakeImportC: true}
	tp, _ := conf.Check(importPath, fset, p.files, p.info) // errors: see stubImporter
	if tp == nil {
		return nil, fmt.Errorf("type-checking %s for scope information failed", importPath)
	}
	p.scope = tp.Scope()
	p.assigned = map[*types.Var]token.Pos{}
	mark := func(e ast.Expr) {
		id, ok := ast.Unparen(e).(*ast.Ident)
		if !ok {
			return
		}
		if v, ok := p.info.Uses[id].(*types.Var); ok && v.Parent() == p.scope {
			if _, dup := p.assigned[v]; !dup {
				p.assigned[v] = id.Pos()
			}
		}
	}
	for _, f := range p.files {
		ast.Inspect(f, func(n ast.Node) bool {
			switch n := n.(type) {
			case *ast.AssignStmt:
				for _, l := range n.Lhs {
					mark(l)
				}
			case *ast.IncDecStmt:
				mark(n.X)
			case *ast.RangeStmt:
				if n.Key != nil {
					mark(n.Key)
				}
				if n.Value != nil {
					mark(n.Value)
				}
			case *ast.UnaryExpr:
				if n.Op == token.AND {
					mark(n.X) // a pointer to the var can reassign it
				}
			}
			return true
		})
	}
	return p, nil
}

// importName is the name a file refers to an import path by ("" if absent).
func importName(f *ast.File, path string) (string, error) {
	for _, imp := range f.Imports {
		if p, _ := strconv.Unquote(imp.Path.Value); p == path {
			if imp.Name == nil {
				return defaultImportName(path), nil
			}
			if imp.Name.Name == "." {
				return "", fmt.Errorf("dot-import of %s is not supported by the metric scan", path)
			}
			return imp.Name.Name, nil
		}
	}
	return "", nil
}

// pkgSel reports whether e is `<ident>.<sel>` where <ident> RESOLVES (by scope)
// to the import of path; sel == "" matches any selector.
func (p *pkg) pkgSel(e ast.Expr, path, sel string) bool {
	s, ok := e.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	x, ok := s.X.(*ast.Ident)
	if !ok {
		return false
	}
	pn, ok := p.info.Uses[x].(*types.PkgName)
	return ok && pn.Imported().Path() == path && (sel == "" || s.Sel.Name == sel)
}

func (p *pkg) errorf(at ast.Node, format string, args ...any) error {
	return fmt.Errorf("%s: %s", p.fset.Position(at.Pos()), fmt.Sprintf(format, args...))
}

// collect adds every family this package registers to out.
func (p *pkg) collect(out map[string]Family) error {
	for _, f := range p.files {
		crName, err := importName(f, crMetricsPath)
		if err != nil {
			return err
		}
		if crName == "" || crName == "_" {
			continue
		}
		for _, decl := range f.Decls {
			inInit := false
			if fd, ok := decl.(*ast.FuncDecl); ok && fd.Recv == nil && fd.Name.Name == "init" {
				inInit = true
			}
			handled := map[ast.Expr]bool{}
			var walkErr error
			ast.Inspect(decl, func(n ast.Node) bool {
				if walkErr != nil {
					return false
				}
				switch n := n.(type) {
				case *ast.CallExpr:
					fun, ok := n.Fun.(*ast.SelectorExpr)
					if !ok || !p.pkgSel(fun.X, crMetricsPath, "Registry") {
						return true
					}
					if fun.Sel.Name != "MustRegister" && fun.Sel.Name != "Register" {
						return true // falls through to the unsupported-use check below
					}
					if !inInit {
						walkErr = p.errorf(n, "metrics.Registry.%s outside init(): the scan cannot prove it runs", fun.Sel.Name)
						return false
					}
					handled[fun.X] = true
					for _, arg := range n.Args {
						if walkErr = p.register(out, arg, 0); walkErr != nil {
							return false
						}
					}
				case *ast.SelectorExpr:
					if p.pkgSel(n, crMetricsPath, "Registry") && !handled[n] {
						walkErr = p.errorf(n, "metrics.Registry used other than as metrics.Registry.MustRegister/Register in init(): "+
							"the scan cannot see what it registers")
						return false
					}
					// The file's name for the metrics package, resolving to
					// something else: a registration through it may or may not
					// reach the served registry, and the scan cannot tell.
					if x, ok := n.X.(*ast.Ident); ok && x.Name == crName {
						if _, isPkg := p.info.Uses[x].(*types.PkgName); !isPkg {
							walkErr = p.errorf(n, "%s is shadowed by a local declaration here: the scan cannot tell "+
								"which registry %s.%s names", crName, crName, n.Sel.Name)
							return false
						}
					}
				}
				return true
			})
			if walkErr != nil {
				return walkErr
			}
		}
	}
	return nil
}

// register resolves one MustRegister argument to its family.
func (p *pkg) register(out map[string]Family, arg ast.Expr, depth int) error {
	if depth > 8 {
		return p.errorf(arg, "collector reference chain too deep")
	}
	switch a := arg.(type) {
	case *ast.ParenExpr:
		return p.register(out, a.X, depth+1)
	case *ast.Ident:
		obj := p.info.Uses[a]
		if obj == nil {
			return p.errorf(a, "%s does not resolve to a declaration", a.Name)
		}
		if obj.Parent() != p.scope {
			return p.errorf(a, "%s resolves to a local declaration at %s, not the package-level variable: "+
				"the scan cannot see what it holds", a.Name, p.fset.Position(obj.Pos()))
		}
		v, ok := obj.(*types.Var)
		ref, has := p.vars[a.Name]
		if !ok || !has || ref.expr == nil {
			return p.errorf(a, "%s is not a package-level variable with an initializer", a.Name)
		}
		if v.Exported() {
			return p.errorf(a, "%s is exported: another package can reassign it, "+
				"and the scan reads only its declaration", a.Name)
		}
		if at, re := p.assigned[v]; re {
			return p.errorf(a, "%s is assigned at %s besides its declaration: the scan reads only the declaration, "+
				"so what is registered may not be what it declares", a.Name, p.fset.Position(at))
		}
		return p.register(out, ref.expr, depth+1)
	case *ast.CallExpr:
		fun, ok := a.Fun.(*ast.SelectorExpr)
		if !ok || !p.pkgSel(fun, promPath, "") {
			return p.errorf(a, "collector is not built by a prometheus constructor")
		}
		fam, ok := constructors[fun.Sel.Name]
		if !ok {
			return p.errorf(a, "unsupported prometheus constructor %s", fun.Sel.Name)
		}
		if len(a.Args) == 0 {
			return p.errorf(a, "%s has no opts", fun.Sel.Name)
		}
		name, err := p.optsName(a.Args[0])
		if err != nil {
			return err
		}
		if _, dup := out[name]; dup {
			return p.errorf(a, "%s is registered twice", name)
		}
		out[name] = fam
		return nil
	default:
		return p.errorf(arg, "unsupported collector expression %T", arg)
	}
}

// optsName is prometheus.BuildFQName(Namespace, Subsystem, Name) of an opts literal.
func (p *pkg) optsName(e ast.Expr) (string, error) {
	lit, ok := e.(*ast.CompositeLit)
	if !ok || !p.pkgSel(lit.Type, promPath, "") || !strings.HasSuffix(lit.Type.(*ast.SelectorExpr).Sel.Name, "Opts") {
		return "", p.errorf(e, "metric opts are not a prometheus.*Opts literal")
	}
	fields := map[string]string{}
	for _, el := range lit.Elts {
		kv, ok := el.(*ast.KeyValueExpr)
		if !ok {
			return "", p.errorf(el, "positional opts fields are not supported")
		}
		key, ok := kv.Key.(*ast.Ident)
		if !ok {
			return "", p.errorf(kv, "unsupported opts key")
		}
		switch key.Name {
		case "Namespace", "Subsystem", "Name":
			v, err := p.constString(kv.Value, 0)
			if err != nil {
				return "", err
			}
			fields[key.Name] = v
		}
	}
	if fields["Name"] == "" {
		return "", p.errorf(lit, "metric opts have no Name")
	}
	var parts []string
	for _, k := range []string{"Namespace", "Subsystem", "Name"} {
		if fields[k] != "" {
			parts = append(parts, fields[k])
		}
	}
	return strings.Join(parts, "_"), nil
}

// constString evaluates a compile-time string constant expression.
func (p *pkg) constString(e ast.Expr, depth int) (string, error) {
	if depth > 16 {
		return "", p.errorf(e, "constant chain too deep")
	}
	switch v := e.(type) {
	case *ast.BasicLit:
		if v.Kind == token.STRING {
			return strconv.Unquote(v.Value)
		}
	case *ast.ParenExpr:
		return p.constString(v.X, depth+1)
	case *ast.BinaryExpr:
		if v.Op == token.ADD {
			l, err := p.constString(v.X, depth+1)
			if err != nil {
				return "", err
			}
			r, err := p.constString(v.Y, depth+1)
			if err != nil {
				return "", err
			}
			return l + r, nil
		}
	case *ast.Ident:
		obj := p.info.Uses[v]
		if obj != nil && obj.Parent() != p.scope && obj.Parent() != types.Universe {
			return "", p.errorf(v, "%s resolves to a local declaration at %s, not a package-level constant",
				v.Name, p.fset.Position(obj.Pos()))
		}
		if _, isConst := obj.(*types.Const); isConst && obj.Parent() == p.scope {
			if c, ok := p.consts[v.Name]; ok && c != nil {
				return p.constString(c, depth+1)
			}
		}
	}
	return "", p.errorf(e, "metric name part is not a string constant of this package")
}

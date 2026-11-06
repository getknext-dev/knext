package wake

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// closeRebindSites reports every function in src that listens on an ephemeral
// port (":0") and then closes that listener with a plain (non-deferred)
// statement. Handing the port number on after a close is the reserve-then-rebind
// TOCTOU (another process, or an outbound ephemeral source port, can take it
// before the rebind). Use reservePort/listenReserved (hold the socket) instead.
func closeRebindSites(t *testing.T, name, src string) []string {
	t.Helper()
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, name, src, 0)
	if err != nil {
		t.Fatalf("parse %s: %v", name, err)
	}
	var out []string
	for _, decl := range f.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Body == nil {
			continue
		}
		ephemeral := map[string]bool{}
		ast.Inspect(fn.Body, func(n ast.Node) bool {
			as, ok := n.(*ast.AssignStmt)
			if !ok || len(as.Rhs) != 1 || len(as.Lhs) < 1 {
				return true
			}
			call, ok := as.Rhs[0].(*ast.CallExpr)
			if !ok || len(call.Args) != 2 {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			lit, lok := call.Args[1].(*ast.BasicLit)
			if !ok || !lok || sel.Sel.Name != "Listen" || !strings.HasSuffix(lit.Value, `:0"`) {
				return true
			}
			if id, ok := as.Lhs[0].(*ast.Ident); ok {
				ephemeral[id.Name] = true
			}
			return true
		})
		report := func(call *ast.CallExpr) {
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || sel.Sel.Name != "Close" {
				return
			}
			if id, ok := sel.X.(*ast.Ident); ok && ephemeral[id.Name] {
				out = append(out, name+": "+fn.Name.Name+": "+id.Name+" closed after listening on :0")
			}
		}
		// `x.Close()` and `_ = x.Close()` statements; `defer x.Close()` is a
		// DeferStmt and is deliberately not matched.
		// Closures (t.Cleanup, goroutines) are skipped: a Close there is a
		// teardown of a listener that is being SERVED, not a released reservation.
		ast.Inspect(fn.Body, func(n ast.Node) bool {
			switch s := n.(type) {
			case *ast.FuncLit:
				return false
			case *ast.ExprStmt:
				if c, ok := s.X.(*ast.CallExpr); ok {
					report(c)
				}
			case *ast.AssignStmt:
				if len(s.Rhs) == 1 {
					if c, ok := s.Rhs[0].(*ast.CallExpr); ok {
						report(c)
					}
				}
			}
			return true
		})
	}
	return out
}

// Both halves: the scanner flags the racy shape and accepts the held-socket shape.
func TestCloseRebindScannerBothHalves(t *testing.T) {
	racy := `package x
import "net"
func a() { p, _ := net.Listen("tcp", "127.0.0.1:0"); _ = p.Close() }
func b() { p, _ := net.Listen("tcp", "127.0.0.1:0"); p.Close() }
`
	if got := closeRebindSites(t, "racy.go", racy); len(got) != 2 {
		t.Fatalf("scanner missed the racy shape, got %v", got)
	}
	ok := `package x
import "net"
func a() { p, _ := net.Listen("tcp", "127.0.0.1:0"); defer p.Close() }
func b(t T) { h, port := reservePort(t); _, _ = h, port }
`
	if got := closeRebindSites(t, "ok.go", ok); len(got) != 0 {
		t.Fatalf("scanner flagged a safe shape: %v", got)
	}
}

// No gateway test closes an ephemeral listener (close->rebind TOCTOU, #2689/#2690).
func TestGatewayTestsHaveNoCloseThenRebindPorts(t *testing.T) {
	scanned := 0
	var bad []string
	err := filepath.WalkDir("..", func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, "_test.go") ||
			strings.HasSuffix(p, "noclose_rebind_guard_test.go") ||
			strings.HasSuffix(p, "reserve_other_test.go") {
			return err
		}
		b, rerr := os.ReadFile(p)
		if rerr != nil {
			return rerr
		}
		scanned++
		bad = append(bad, closeRebindSites(t, p, string(b))...)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if scanned < 20 {
		t.Fatalf("scanned only %d test files; the walk root is wrong", scanned)
	}
	if len(bad) > 0 {
		t.Fatalf("close->rebind of an ephemeral port (use reservePort/listenReserved):\n%s", strings.Join(bad, "\n"))
	}
}

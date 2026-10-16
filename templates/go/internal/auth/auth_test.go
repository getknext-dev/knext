package auth_test

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect/v2"
	"connectrpc.com/connect/v2/connectinprocess"
	"connectrpc.com/grpchealth/v2"

	examplev1 "example.com/function/gen/example/v1"
	"example.com/function/gen/example/v1/examplev1connect"
	"example.com/function/internal/auth"
)

// recordingHandler counts how often each RPC reached the handler, so a test
// can prove a rejected call never ran the business logic.
type recordingHandler struct {
	examplev1connect.UnimplementedExampleServiceHandler
	mu    sync.Mutex
	calls int
}

func (h *recordingHandler) GetItem(context.Context, *examplev1.GetItemRequest) (*examplev1.GetItemResponse, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.calls++
	return &examplev1.GetItemResponse{Id: "a", Value: "b"}, nil
}

func (h *recordingHandler) PutItem(context.Context, *examplev1.PutItemRequest) (*examplev1.PutItemResponse, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.calls++
	return &examplev1.PutItemResponse{}, nil
}

func (h *recordingHandler) count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.calls
}

// spyVerifier accepts exactly one token and records what it was asked.
type spyVerifier struct {
	accept     string
	mu         sync.Mutex
	calls      int
	procedures []string
}

func (s *spyVerifier) Verify(_ context.Context, token, procedure string) (auth.Caller, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	s.procedures = append(s.procedures, procedure)
	if s.accept != "" && token == s.accept {
		return auth.Caller{Subject: "spy-user", Zone: "knext:zone:shop/storefront"}, nil
	}
	return auth.Caller{}, errors.New("spy: token refused")
}

type fixture struct {
	handler *recordingHandler
	example examplev1connect.ExampleServiceClient
	health  *grpchealth.Client
}

func newFixture(t *testing.T, v auth.Verifier) fixture {
	t.Helper()
	h := &recordingHandler{}
	server := connect.NewServer(auth.NewInterceptor(v))
	examplev1connect.RegisterExampleServiceHandler(server, h)
	grpchealth.Register(server, grpchealth.NewStaticChecker(examplev1connect.ExampleServiceName))
	client := connect.NewClient(connectinprocess.New(server))
	return fixture{
		handler: h,
		example: examplev1connect.NewExampleServiceClient(client),
		health:  grpchealth.NewClient(client),
	}
}

func withAuthorization(t *testing.T, value string) context.Context {
	t.Helper()
	ctx, info := connect.NewClientContext(t.Context())
	info.RequestHeader().Set("Authorization", value)
	return ctx
}

func wantUnauthenticated(t *testing.T, what string, err error) {
	t.Helper()
	if err == nil {
		t.Fatalf("%s: the call succeeded; want CodeUnauthenticated (fail closed)", what)
	}
	if got := connect.CodeOf(err); got != connect.CodeUnauthenticated {
		t.Fatalf("%s: code = %v; want %v (err: %v)", what, got, connect.CodeUnauthenticated, err)
	}
}

func absentJWKS(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "jwks", "jwks.json")
}

// mounted is the binary's verifier — issuer and audience set — reading the
// JWKS at path.
func mounted(path string) auth.Verifier {
	return auth.NewVerifier(auth.Config{
		JWKSPath: path,
		Issuer:   "knext:zone:shop/storefront",
		Audience: "knext:fn:shop/orders",
	})
}

// With no JWKS mounted, every RPC except the health check is refused —
// with no token, with a token, read or write.
func TestNoJWKSMountedRejectsEveryNonHealthRPC(t *testing.T) {
	f := newFixture(t, mounted(absentJWKS(t)))

	_, err := f.example.GetItem(t.Context(), &examplev1.GetItemRequest{Id: "a"})
	wantUnauthenticated(t, "GetItem without a token", err)

	_, err = f.example.GetItem(withAuthorization(t, "Bearer some.jwt.token"), &examplev1.GetItemRequest{Id: "a"})
	wantUnauthenticated(t, "GetItem with a token but no JWKS", err)

	_, err = f.example.PutItem(withAuthorization(t, "Bearer some.jwt.token"), &examplev1.PutItemRequest{Id: "a", Value: "b"})
	wantUnauthenticated(t, "PutItem with a token but no JWKS", err)

	if n := f.handler.count(); n != 0 {
		t.Fatalf("a rejected RPC reached the handler %d time(s)", n)
	}
}

// The health check is the one exempt RPC: the wake-ahead GET and probes
// carry no credentials.
func TestHealthCheckIsExempt(t *testing.T) {
	f := newFixture(t, mounted(absentJWKS(t)))
	res, err := f.health.Check(t.Context(), &grpchealth.CheckRequest{})
	if err != nil {
		t.Fatalf("health Check without a token: %v; want SERVING", err)
	}
	if res.Status != grpchealth.StatusServing {
		t.Fatalf("health Check status = %v; want %v", res.Status, grpchealth.StatusServing)
	}
}

// payloadSpy is a server stream that records whether the request payload was
// ever read. A rejected call must be refused before that.
type payloadSpy struct{ reads atomic.Int32 }

func (p *payloadSpy) Receive(any) error  { p.reads.Add(1); return io.EOF }
func (p *payloadSpy) SendHeaders() error { return nil }
func (p *payloadSpy) Send(any) error     { return nil }

// SCANNED, not enumerated: every procedure registered on the server — the
// example service, health Watch, and any RPC added later — is refused without
// a valid token, before its payload is read. Only health Check is exempt.
func TestEveryRegisteredProcedureExceptHealthCheckIsRefused(t *testing.T) {
	server := connect.NewServer(auth.NewInterceptor(mounted(absentJWKS(t))))
	examplev1connect.RegisterExampleServiceHandler(server, &recordingHandler{})
	grpchealth.Register(server, grpchealth.NewStaticChecker(examplev1connect.ExampleServiceName))

	var scanned, exempt int
	for spec := range server.Specs() {
		scanned++
		if spec.Procedure == auth.HealthCheckProcedure {
			exempt++
			continue
		}
		for _, header := range []string{"", "Bearer some.jwt.token"} {
			info := &connect.CallInfo{}
			if header != "" {
				info.RequestHeader().Set("Authorization", header)
			}
			spy := &payloadSpy{}
			// Bounded: a procedure that is wrongly SERVED may stream forever
			// (health Watch does), and that must red, not hang the suite.
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			err := server.Call(ctx, spec.Procedure, info, spy)
			cancel()
			wantUnauthenticated(t, spec.Procedure+" with Authorization "+strconv.Quote(header), err)
			if n := spy.reads.Load(); n != 0 {
				t.Errorf("%s: the payload was read %d time(s) before the call was refused", spec.Procedure, n)
			}
		}
	}
	// Two example RPCs plus health Check and Watch: a scan that saw fewer
	// proves nothing about the ones it missed.
	if scanned != 4 || exempt != 1 {
		t.Fatalf("scanned %d procedures (%d exempt); want 4 (1 exempt)", scanned, exempt)
	}
}

// A JWKS on disk does not open the door by itself: a token that does not
// verify against it is refused.
func TestMountedJWKSRefusesATokenThatDoesNotVerify(t *testing.T) {
	path := filepath.Join(t.TempDir(), "jwks.json")
	jwks := `{"keys":[{"kty":"OKP","crv":"Ed25519","kid":"k1","x":"11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"}]}`
	if err := os.WriteFile(path, []byte(jwks), 0o600); err != nil {
		t.Fatal(err)
	}
	f := newFixture(t, mounted(path))
	_, err := f.example.GetItem(withAuthorization(t, "Bearer some.jwt.token"), &examplev1.GetItemRequest{Id: "a"})
	wantUnauthenticated(t, "GetItem with a JWKS mounted", err)

	_, err = mounted(path).Verify(t.Context(), "some.jwt.token", examplev1connect.ExampleServiceGetItemProcedure)
	if !errors.Is(err, auth.ErrMalformed) {
		t.Fatalf("Verify with a JWKS mounted = %v; want ErrMalformed", err)
	}
	if n := f.handler.count(); n != 0 {
		t.Fatalf("a rejected RPC reached the handler %d time(s)", n)
	}
}

// Anything that is not a non-empty regular file is "no JWKS mounted".
func TestNoJWKSShapes(t *testing.T) {
	dir := t.TempDir()
	empty := filepath.Join(dir, "empty.json")
	if err := os.WriteFile(empty, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	for name, path := range map[string]string{
		"absent":       filepath.Join(dir, "absent.json"),
		"directory":    dir,
		"empty file":   empty,
		"empty string": "",
	} {
		_, err := mounted(path).Verify(t.Context(), "some.jwt.token", examplev1connect.ExampleServicePutItemProcedure)
		if !errors.Is(err, auth.ErrNoJWKS) {
			t.Errorf("%s: Verify = %v; want ErrNoJWKS", name, err)
		}
	}
}

// A missing or malformed Authorization header is refused before the verifier
// runs — even a verifier that would accept an empty token never sees one.
func TestMissingTokenIsRejectedBeforeTheVerifier(t *testing.T) {
	var verifierCalls atomic.Int32
	acceptAll := verifierFunc(func(context.Context, string, string) (auth.Caller, error) {
		verifierCalls.Add(1)
		return auth.Caller{Subject: "anyone"}, nil
	})
	f := newFixture(t, acceptAll)

	_, err := f.example.GetItem(t.Context(), &examplev1.GetItemRequest{Id: "a"})
	wantUnauthenticated(t, "no Authorization header", err)
	for _, header := range []string{"", "Bearer", "Bearer ", "Bearer    ", "Basic dXNlcjpwYXNz", "bearer", "Token abc"} {
		_, err := f.example.PutItem(withAuthorization(t, header), &examplev1.PutItemRequest{Id: "a"})
		wantUnauthenticated(t, "Authorization: "+header, err)
	}
	if n := verifierCalls.Load(); n != 0 {
		t.Fatalf("the verifier ran %d time(s) for a call with no bearer token", n)
	}
	if n := f.handler.count(); n != 0 {
		t.Fatalf("a rejected RPC reached the handler %d time(s)", n)
	}
}

type verifierFunc func(ctx context.Context, token, procedure string) (auth.Caller, error)

func (f verifierFunc) Verify(ctx context.Context, token, procedure string) (auth.Caller, error) {
	return f(ctx, token, procedure)
}

// A token the verifier refuses is rejected and never reaches the handler.
func TestRefusedTokenIsRejected(t *testing.T) {
	spy := &spyVerifier{accept: "good"}
	f := newFixture(t, spy)
	_, err := f.example.PutItem(withAuthorization(t, "Bearer forged"), &examplev1.PutItemRequest{Id: "a"})
	wantUnauthenticated(t, "PutItem with a refused token", err)
	if n := f.handler.count(); n != 0 {
		t.Fatalf("a rejected RPC reached the handler %d time(s)", n)
	}
}

// An accepted token reaches the handler, and the verifier is told which RPC
// is being called (the token's method claim is checked against it).
func TestAcceptedTokenReachesTheHandler(t *testing.T) {
	spy := &spyVerifier{accept: "good"}
	f := newFixture(t, spy)
	if _, err := f.example.PutItem(withAuthorization(t, "Bearer good"), &examplev1.PutItemRequest{Id: "a"}); err != nil {
		t.Fatalf("PutItem with an accepted token: %v", err)
	}
	if n := f.handler.count(); n != 1 {
		t.Fatalf("handler calls = %d; want 1", n)
	}
	if len(spy.procedures) != 1 || spy.procedures[0] != examplev1connect.ExampleServicePutItemProcedure {
		t.Fatalf("verifier saw procedures %v; want [%s]", spy.procedures, examplev1connect.ExampleServicePutItemProcedure)
	}
}

// A nil verifier is a wiring mistake; it must fail closed, not open.
func TestNilVerifierFailsClosed(t *testing.T) {
	f := newFixture(t, nil)
	_, err := f.example.GetItem(withAuthorization(t, "Bearer good"), &examplev1.GetItemRequest{Id: "a"})
	wantUnauthenticated(t, "GetItem with a nil verifier", err)
}

// The refusal says what is wrong without echoing the token or the cause.
func TestRejectionDoesNotLeakTheCause(t *testing.T) {
	f := newFixture(t, mounted(absentJWKS(t)))
	_, err := f.example.GetItem(withAuthorization(t, "Bearer secret-token-value"), &examplev1.GetItemRequest{Id: "a"})
	var cerr *connect.Error
	if !errors.As(err, &cerr) {
		t.Fatalf("err = %v; want a *connect.Error", err)
	}
	for _, leak := range []string{"secret-token-value", "jwks", "/"} {
		if containsFold(cerr.Message(), leak) {
			t.Fatalf("the error message %q leaks %q", cerr.Message(), leak)
		}
	}
}

func containsFold(s, sub string) bool {
	return strings.Contains(strings.ToLower(s), strings.ToLower(sub))
}

package auth_test

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect/v2"
	"connectrpc.com/connect/v2/connectinprocess"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/reflect/protoregistry"
	"google.golang.org/protobuf/types/descriptorpb"

	examplev1 "example.com/function/gen/example/v1"
	"example.com/function/gen/example/v1/examplev1connect"
	knextv1 "example.com/function/gen/knext/v1"
	"example.com/function/internal/auth"
	"example.com/function/internal/testvectors"
)

// reasonErr maps each refusal reason the shared vectors name onto the error
// the verifier returns for it. A reason the vectors add that is missing here
// reds TestSharedVectorsReasonsAreAllMapped.
var reasonErr = map[string]error{
	"malformed":       auth.ErrMalformed,
	"bad-alg":         auth.ErrBadAlg,
	"unknown-kid":     auth.ErrUnknownKID,
	"bad-signature":   auth.ErrBadSignature,
	"lifetime":        auth.ErrLifetime,
	"expired":         auth.ErrExpired,
	"not-yet-valid":   auth.ErrNotYetValid,
	"wrong-issuer":    auth.ErrWrongIssuer,
	"wrong-audience":  auth.ErrWrongAudience,
	"wrong-method":    auth.ErrWrongMethod,
	"missing-subject": auth.ErrMissingSubject,
	"bad-jwks":        auth.ErrBadJWKS,
	"missing-jti":     auth.ErrMissingJTI,
	"replayed":        auth.ErrReplayed,
	"seen-set-full":   auth.ErrSeenSetFull,
}

var authOf = map[string]knextv1.Auth{
	"AUTH_USER":   knextv1.Auth_AUTH_USER,
	"AUTH_PUBLIC": knextv1.Auth_AUTH_PUBLIC,
}

// clock is a settable test clock.
type clock struct {
	mu  sync.Mutex
	now time.Time
}

func newClock(unix int64) *clock { return &clock{now: time.Unix(unix, 0)} }

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

// Set moves the clock to an absolute reading, in Unix seconds.
func (c *clock) Set(unix int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = time.Unix(unix, 0)
}

func (c *clock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

// onlyMethod is the auth policy of a server that serves exactly one RPC.
func onlyMethod(procedure string, mode knextv1.Auth) auth.MethodAuth {
	return func(p string) knextv1.Auth {
		if p == procedure {
			return mode
		}
		return knextv1.Auth_AUTH_UNSPECIFIED
	}
}

// vectorVerifier is the verifier for one vector case: the case's JWK Set
// mounted at a fresh path, the vectors' issuer and audience, the case's clock,
// and a policy that gives the case's procedure the case's auth option.
func vectorVerifier(t *testing.T, v *testvectors.File, c testvectors.Case) (auth.Verifier, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "jwks", "jwks.json")
	v.WriteJWKS(t, path, c.JWKS)
	mode, ok := authOf[c.Auth]
	if !ok {
		t.Fatalf("%s: unknown auth %q", c.Name, c.Auth)
	}
	return auth.NewVerifier(auth.Config{
		JWKSPath:   path,
		Issuer:     v.Verifier.Issuer,
		Audience:   v.Verifier.Audience,
		MethodAuth: onlyMethod(c.Procedure, mode),
		Now:        newClock(c.Now).Now,
	}), path
}

func wantRefused(t *testing.T, what string, err, want error) {
	t.Helper()
	if err == nil {
		t.Fatalf("%s: the token was accepted; want %v", what, want)
	}
	if !errors.Is(err, want) {
		t.Fatalf("%s: refused with %v; want %v", what, err, want)
	}
}

func TestSharedVectorsReasonsAreAllMapped(t *testing.T) {
	v := testvectors.Load(t)
	for _, reason := range v.Reasons {
		if reason == "no-token" {
			continue // refused by the interceptor before any verifier runs
		}
		if _, ok := reasonErr[reason]; !ok {
			t.Errorf("the vectors name reason %q, which no verifier error maps to", reason)
		}
	}
}

// Every case in the shared vectors, through the verifier: each valid token is
// accepted with its subject, and each negative case is refused for exactly
// the reason the vectors name (so dropping one check reds that check's case).
func TestSharedVectors(t *testing.T) {
	v := testvectors.Load(t)
	var accepted, refused int
	for _, c := range v.Cases {
		t.Run(c.Name, func(t *testing.T) {
			verifier, _ := vectorVerifier(t, v, c)
			token, ok := c.Token()
			if !ok {
				// No token at all: the interceptor refuses it before the
				// verifier is asked.
				f := newFixture(t, verifier)
				_, err := f.example.PutItem(t.Context(), &examplev1.PutItemRequest{Id: "a"})
				wantUnauthenticated(t, c.Name, err)
				refused++
				return
			}
			caller, err := verifier.Verify(t.Context(), token, c.Procedure)
			switch c.Expect {
			case "accept":
				if err != nil {
					t.Fatalf("refused a valid token: %v", err)
				}
				if caller.Subject != c.Sub || caller.Zone != v.Verifier.Issuer {
					t.Fatalf("caller = %+v; want subject %q, zone %q", caller, c.Sub, v.Verifier.Issuer)
				}
				accepted++
			case "reject":
				want, ok := reasonErr[c.Reason]
				if !ok {
					t.Fatalf("unmapped reason %q", c.Reason)
				}
				wantRefused(t, c.Name, err, want)
				if caller != (auth.Caller{}) {
					t.Fatalf("a refused token still produced caller %+v", caller)
				}
				refused++
			default:
				t.Fatalf("unknown expectation %q", c.Expect)
			}
		})
	}
	// A run that saw fewer cases proves nothing about the ones it missed.
	if accepted < 10 || refused < 74 {
		t.Fatalf("ran %d accepted and %d refused cases; want at least 10 and 74", accepted, refused)
	}
}

// A refusal on the wire says only "unauthenticated": the reason is never sent.
func TestVectorRefusalsReachNoHandler(t *testing.T) {
	v := testvectors.Load(t)
	for _, name := range []string{"wrong-method", "user-empty-sub", "expired", "cross-zone", "alg-none"} {
		c := v.Case(t, name)
		verifier, _ := vectorVerifier(t, v, c)
		f := newFixture(t, verifier)
		_, err := f.example.PutItem(withAuthorization(t, "Bearer "+v.Token(t, name)), &examplev1.PutItemRequest{Id: "a"})
		wantUnauthenticated(t, name, err)
		var cerr *connect.Error
		if errors.As(err, &cerr) && strings.Contains(cerr.Message(), c.Reason) {
			t.Fatalf("%s: the refusal %q names its reason", name, cerr.Message())
		}
		if n := f.handler.count(); n != 0 {
			t.Fatalf("%s: a refused RPC reached the handler %d time(s)", name, n)
		}
	}
}

// callerRecorder is a handler that records the caller the token check put in
// the context — the only identity a function may act on.
type callerRecorder struct {
	examplev1connect.UnimplementedExampleServiceHandler
	mu      sync.Mutex
	callers []auth.Caller
	found   []bool
}

func (h *callerRecorder) PutItem(ctx context.Context, _ *examplev1.PutItemRequest) (*examplev1.PutItemResponse, error) {
	caller, ok := auth.CallerFrom(ctx)
	h.mu.Lock()
	defer h.mu.Unlock()
	h.callers = append(h.callers, caller)
	h.found = append(h.found, ok)
	return &examplev1.PutItemResponse{}, nil
}

// The user a function acts for comes from the verified token and nowhere
// else: a user id forged into the request body or a header is never the
// caller, and it never stands in for a missing or user-less token.
func TestBodyForgedUserIDIsNeverTheCaller(t *testing.T) {
	v := testvectors.Load(t)
	c := v.Case(t, "valid-user")
	verifier, _ := vectorVerifier(t, v, c)
	h := &callerRecorder{}
	server := connect.NewServer(auth.NewInterceptor(verifier))
	examplev1connect.RegisterExampleServiceHandler(server, h)
	example := examplev1connect.NewExampleServiceClient(connect.NewClient(connectinprocess.New(server)))

	forged := &examplev1.PutItemRequest{Id: "user_id=admin", Value: `{"sub":"admin","user_id":"admin"}`}
	ctx, info := connect.NewClientContext(t.Context())
	info.RequestHeader().Set("Authorization", "Bearer "+v.Token(t, "valid-user"))
	info.RequestHeader().Set("X-User-Id", "admin")
	info.RequestHeader().Set("X-Knext-Sub", "admin")
	if _, err := example.PutItem(ctx, forged); err != nil {
		t.Fatalf("PutItem with a valid token: %v", err)
	}
	h.mu.Lock()
	got, found := h.callers, h.found
	h.mu.Unlock()
	if len(got) != 1 || !found[0] {
		t.Fatalf("the handler saw callers %v (found %v); want exactly one caller from the token", got, found)
	}
	if got[0].Subject != c.Sub || got[0].Zone != v.Verifier.Issuer {
		t.Fatalf("the caller is %+v; want the token's subject %q and zone %q", got[0], c.Sub, v.Verifier.Issuer)
	}

	// The forged id does not stand in for a missing token, or a token with no user.
	_, err := example.PutItem(t.Context(), forged)
	wantUnauthenticated(t, "a body-forged user id with no token", err)
	empty := v.Case(t, "user-empty-sub")
	emptyVerifier, _ := vectorVerifier(t, v, empty)
	server2 := connect.NewServer(auth.NewInterceptor(emptyVerifier))
	examplev1connect.RegisterExampleServiceHandler(server2, h)
	example2 := examplev1connect.NewExampleServiceClient(connect.NewClient(connectinprocess.New(server2)))
	_, err = example2.PutItem(withAuthorization(t, "Bearer "+v.Token(t, "user-empty-sub")), forged)
	wantUnauthenticated(t, "a body-forged user id with a user-less token", err)
	if n := len(h.callers); n != 1 {
		t.Fatalf("a refused call reached the handler (%d calls)", n)
	}
}

// Rotation: a previous-key token verifies while the JWKS still holds the
// previous key (the overlap), and is refused once the key leaves the JWKS —
// in the same warm verifier, without a restart.
func TestRotationOverlapThenRetire(t *testing.T) {
	v := testvectors.Load(t)
	c := v.Case(t, "rotation-previous-during-overlap")
	verifier, path := vectorVerifier(t, v, c)
	previous := v.Token(t, "rotation-previous-during-overlap")
	current := v.Token(t, "valid-user")

	for name, token := range map[string]string{"previous": previous, "current": current} {
		if _, err := verifier.Verify(t.Context(), token, c.Procedure); err != nil {
			t.Fatalf("during the overlap, the %s-key token was refused: %v", name, err)
		}
	}
	replaceJWKS(t, v, path, "zone-a-current-only")
	_, err := verifier.Verify(t.Context(), previous, c.Procedure)
	wantRefused(t, "a previous-key token after the overlap", err, auth.ErrUnknownKID)
	// A token is single-use: the current key's next token is a new one.
	if _, err := verifier.Verify(t.Context(), v.Token(t, "valid-user-second-jti"), c.Procedure); err != nil {
		t.Fatalf("after the overlap, the current-key token was refused: %v", err)
	}
}

// Warm-pod rotation: switching signing to a new key BEFORE the JWKS carrying
// it reaches the pod fails, and once the new JWKS lands, the same running
// verifier accepts the new key's tokens without a restart.
func TestWarmPodPicksUpANewKeyWithoutRestart(t *testing.T) {
	v := testvectors.Load(t)
	before := v.Case(t, "rotation-next-before-propagation")
	verifier, path := vectorVerifier(t, v, before)
	next := v.Token(t, "rotation-next-before-propagation")
	if after := v.Token(t, "rotation-next-after-propagation"); after != next {
		t.Fatal("the before- and after-propagation vectors must be the same new-key token")
	}

	_, err := verifier.Verify(t.Context(), next, before.Procedure)
	wantRefused(t, "a new-key token before the JWKS propagated", err, auth.ErrUnknownKID)

	replaceJWKS(t, v, path, "zone-a-rotating")
	if _, err := verifier.Verify(t.Context(), next, before.Procedure); err != nil {
		t.Fatalf("the warm verifier refused a new-key token after the JWKS propagated: %v", err)
	}
}

// The JWKS is re-read at least every JWKSRereadInterval even when the file's
// modification time and size do not change.
func TestJWKSIsRereadAtLeastEveryInterval(t *testing.T) {
	v := testvectors.Load(t)
	c := v.Case(t, "rotation-next-before-propagation")
	path := filepath.Join(t.TempDir(), "jwks.json")
	v.WriteJWKS(t, path, "zone-a-overlap")
	if len(v.JWKSBytes(t, "zone-a-overlap")) != len(v.JWKSBytes(t, "zone-a-rotating")) {
		t.Fatal("the two JWK Sets must be the same size for this test to hold the size still")
	}
	clk := newClock(c.Now)
	verifier := auth.NewVerifier(auth.Config{
		JWKSPath:   path,
		Issuer:     v.Verifier.Issuer,
		Audience:   v.Verifier.Audience,
		MethodAuth: onlyMethod(c.Procedure, knextv1.Auth_AUTH_USER),
		Now:        clk.Now,
	})
	next := v.Token(t, "rotation-next-before-propagation")
	_, err := verifier.Verify(t.Context(), next, c.Procedure)
	wantRefused(t, "a new-key token before the JWKS changed", err, auth.ErrUnknownKID)

	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	v.WriteJWKS(t, path, "zone-a-rotating")
	if err := os.Chtimes(path, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	clk.Advance(auth.JWKSRereadInterval - time.Second)
	_, err = verifier.Verify(t.Context(), next, c.Procedure)
	wantRefused(t, "inside the reread interval, with mtime and size unchanged", err, auth.ErrUnknownKID)

	clk.Advance(time.Second)
	if _, err := verifier.Verify(t.Context(), next, c.Procedure); err != nil {
		t.Fatalf("the JWKS was not re-read after %v: %v", auth.JWKSRereadInterval, err)
	}
	if auth.JWKSRereadInterval > 10*time.Second {
		t.Fatalf("JWKSRereadInterval = %v; the contract bounds it at 10s", auth.JWKSRereadInterval)
	}
}

// A JWKS that disappears after it was loaded fails closed: the cached keys
// are not used.
func TestJWKSRemovedAfterLoadFailsClosed(t *testing.T) {
	v := testvectors.Load(t)
	c := v.Case(t, "valid-user")
	verifier, path := vectorVerifier(t, v, c)
	token := v.Token(t, "valid-user")
	if _, err := verifier.Verify(t.Context(), token, c.Procedure); err != nil {
		t.Fatalf("valid token: %v", err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	_, err := verifier.Verify(t.Context(), token, c.Procedure)
	wantRefused(t, "after the JWKS was removed", err, auth.ErrNoJWKS)
}

// A JWKS that stops parsing fails closed: the keys from the last good read
// are dropped, not kept.
func TestUnparseableJWKSFailsClosed(t *testing.T) {
	v := testvectors.Load(t)
	c := v.Case(t, "valid-user")
	verifier, path := vectorVerifier(t, v, c)
	token := v.Token(t, "valid-user")
	if _, err := verifier.Verify(t.Context(), token, c.Procedure); err != nil {
		t.Fatalf("valid token: %v", err)
	}
	for name, body := range map[string]string{
		"not JSON":    `{"keys":[`,
		"no keys":     `{"kty":"OKP"}`,
		"keys object": `{"keys":{}}`,
	} {
		writeLater(t, path, []byte(body))
		_, err := verifier.Verify(t.Context(), token, c.Procedure)
		wantRefused(t, "JWKS "+name, err, auth.ErrBadJWKS)
	}
}

// A JWKS larger than MaxJWKSBytes is refused rather than read.
func TestOversizedJWKSIsRefused(t *testing.T) {
	v := testvectors.Load(t)
	c := v.Case(t, "valid-user")
	verifier, path := vectorVerifier(t, v, c)
	set := v.JWKSBytes(t, c.JWKS)
	padded := append([]byte(strings.Repeat(" ", auth.MaxJWKSBytes)), set...)
	writeLater(t, path, padded)
	_, err := verifier.Verify(t.Context(), v.Token(t, "valid-user"), c.Procedure)
	wantRefused(t, "an oversized JWKS", err, auth.ErrBadJWKS)
}

// Without the issuer and audience it checks tokens against, the verifier
// refuses every token: an unconfigured function is closed, not open.
func TestUnconfiguredIssuerOrAudienceRefusesEveryToken(t *testing.T) {
	v := testvectors.Load(t)
	c := v.Case(t, "valid-user")
	path := filepath.Join(t.TempDir(), "jwks.json")
	v.WriteJWKS(t, path, c.JWKS)
	for name, cfg := range map[string]auth.Config{
		"no issuer":   {Audience: v.Verifier.Audience},
		"no audience": {Issuer: v.Verifier.Issuer},
		"neither":     {},
	} {
		cfg.JWKSPath = path
		cfg.MethodAuth = onlyMethod(c.Procedure, knextv1.Auth_AUTH_USER)
		cfg.Now = newClock(c.Now).Now
		_, err := auth.NewVerifier(cfg).Verify(t.Context(), v.Token(t, "valid-user"), c.Procedure)
		wantRefused(t, name, err, auth.ErrNotConfigured)
	}
}

// An RPC whose (knext.v1.auth) option is unstated — or that is not in any
// contract the function knows — is refused even with a valid token.
func TestRPCWithoutAnAuthOptionIsRefused(t *testing.T) {
	v := testvectors.Load(t)
	c := v.Case(t, "valid-user")
	for name, policy := range map[string]auth.MethodAuth{
		"unspecified": onlyMethod(c.Procedure, knextv1.Auth_AUTH_UNSPECIFIED),
		"unknown":     onlyMethod("/other.v1.Other/Call", knextv1.Auth_AUTH_USER),
		"nil policy":  nil,
	} {
		path := filepath.Join(t.TempDir(), "jwks.json")
		v.WriteJWKS(t, path, c.JWKS)
		verifier := auth.NewVerifier(auth.Config{
			JWKSPath:   path,
			Issuer:     v.Verifier.Issuer,
			Audience:   v.Verifier.Audience,
			MethodAuth: policy,
			Now:        newClock(c.Now).Now,
		})
		if name == "nil policy" {
			// A nil policy is the binary's: the descriptors. valid-user calls
			// PutItem, which the example contract marks AUTH_USER, so it is
			// served — the nil default is the real lookup, not "allow".
			if _, err := verifier.Verify(t.Context(), v.Token(t, "valid-user"), c.Procedure); err != nil {
				t.Fatalf("nil policy (the descriptors) refused PutItem: %v", err)
			}
			continue
		}
		_, err := verifier.Verify(t.Context(), v.Token(t, "valid-user"), c.Procedure)
		wantRefused(t, name, err, auth.ErrNoAuthOption)
	}
}

// The auth option is read from the compiled contract: the example's two RPCs
// are AUTH_USER, an AUTH_PUBLIC method reads as AUTH_PUBLIC, and anything
// unknown or unstated is AUTH_UNSPECIFIED.
func TestDescriptorAuthReadsTheContract(t *testing.T) {
	global := auth.DescriptorAuth(protoregistry.GlobalFiles)
	for _, procedure := range []string{
		examplev1connect.ExampleServiceGetItemProcedure,
		examplev1connect.ExampleServicePutItemProcedure,
	} {
		if got := global(procedure); got != knextv1.Auth_AUTH_USER {
			t.Errorf("%s: auth = %v; want AUTH_USER (the example contract)", procedure, got)
		}
	}
	for _, procedure := range []string{
		"",
		"/",
		"example.v1.ExampleService/GetItem",
		"/example.v1.ExampleService/",
		"/example.v1.ExampleService/GetItem/",
		"/example.v1.ExampleService/NoSuchMethod",
		"/example.v1.NoSuchService/GetItem",
		"/example.v1.GetItemRequest/GetItem",
		"/grpc.health.v1.Health/Check",
	} {
		if got := global(procedure); got != knextv1.Auth_AUTH_UNSPECIFIED {
			t.Errorf("%q: auth = %v; want AUTH_UNSPECIFIED", procedure, got)
		}
	}

	files := new(protoregistry.Files)
	registerCatalog(t, files)
	local := auth.DescriptorAuth(files)
	for procedure, want := range map[string]knextv1.Auth{
		"/catalog.v1.CatalogService/ListProducts": knextv1.Auth_AUTH_PUBLIC,
		"/catalog.v1.CatalogService/Buy":          knextv1.Auth_AUTH_USER,
		"/catalog.v1.CatalogService/Unstated":     knextv1.Auth_AUTH_UNSPECIFIED,
	} {
		if got := local(procedure); got != want {
			t.Errorf("%s: auth = %v; want %v", procedure, got, want)
		}
	}
}

// AUTH_PUBLIC, end to end through the descriptors: a public read needs a
// valid zone token but no user; the same token on an AUTH_USER method is not
// enough.
func TestPublicMethodNeedsAZoneTokenButNoUser(t *testing.T) {
	v := testvectors.Load(t)
	c := v.Case(t, "valid-public")
	files := new(protoregistry.Files)
	registerCatalog(t, files)
	path := filepath.Join(t.TempDir(), "jwks.json")
	v.WriteJWKS(t, path, c.JWKS)
	verifier := auth.NewVerifier(auth.Config{
		JWKSPath:   path,
		Issuer:     v.Verifier.Issuer,
		Audience:   v.Verifier.Audience,
		MethodAuth: auth.DescriptorAuth(files),
		Now:        newClock(c.Now).Now,
	})
	caller, err := verifier.Verify(t.Context(), v.Token(t, "valid-public"), c.Procedure)
	if err != nil {
		t.Fatalf("a public read with a zone token and no user was refused: %v", err)
	}
	if caller.Subject != "" || caller.Zone != v.Verifier.Issuer {
		t.Fatalf("caller = %+v; want no subject and zone %q", caller, v.Verifier.Issuer)
	}
	// The zone check is not skipped for a public read.
	_, err = verifier.Verify(t.Context(), v.Token(t, "unknown-kid"), c.Procedure)
	if err == nil {
		t.Fatal("a public read accepted a token from an unknown key")
	}
}

// registerCatalog registers a stand-in contract with an AUTH_PUBLIC read, an
// AUTH_USER write and a method that states no auth option.
func registerCatalog(t *testing.T, files *protoregistry.Files) {
	t.Helper()
	method := func(name string, mode *knextv1.Auth) *descriptorpb.MethodDescriptorProto {
		m := &descriptorpb.MethodDescriptorProto{
			Name:       proto.String(name),
			InputType:  proto.String(".catalog.v1.Req"),
			OutputType: proto.String(".catalog.v1.Req"),
			Options:    &descriptorpb.MethodOptions{},
		}
		if mode != nil {
			proto.SetExtension(m.Options, knextv1.E_Auth, *mode)
		}
		return m
	}
	public, user := knextv1.Auth_AUTH_PUBLIC, knextv1.Auth_AUTH_USER
	fd, err := protodesc.NewFile(&descriptorpb.FileDescriptorProto{
		Name:        proto.String("catalog/v1/catalog.proto"),
		Package:     proto.String("catalog.v1"),
		Syntax:      proto.String("proto3"),
		MessageType: []*descriptorpb.DescriptorProto{{Name: proto.String("Req")}},
		Service: []*descriptorpb.ServiceDescriptorProto{{
			Name:   proto.String("CatalogService"),
			Method: []*descriptorpb.MethodDescriptorProto{method("ListProducts", &public), method("Buy", &user), method("Unstated", nil)},
		}},
	}, protoregistry.GlobalFiles)
	if err != nil {
		t.Fatal(err)
	}
	if err := files.RegisterFile(fd); err != nil {
		t.Fatal(err)
	}
}

// replaceJWKS swaps the mounted JWK Set and moves its modification time
// forward, as a kubelet ConfigMap update does.
func replaceJWKS(t *testing.T, v *testvectors.File, path, name string) {
	t.Helper()
	writeLater(t, path, v.JWKSBytes(t, name))
}

func writeLater(t *testing.T, path string, data []byte) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	later := info.ModTime().Add(2 * time.Second)
	if err := os.Chtimes(path, later, later); err != nil {
		t.Fatal(err)
	}
}

// verifierFor is the verifier a vector sequence runs against: the sequence's JWK
// Set mounted at a fresh path, the vectors' issuer and audience, a clock the
// steps move, and the sequence's replay-set size (zero: the default).
func verifierFor(t *testing.T, v *testvectors.File, seq testvectors.Sequence) (auth.Verifier, *clock) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "jwks", "jwks.json")
	v.WriteJWKS(t, path, seq.JWKS)
	mode, ok := authOf[seq.Auth]
	if !ok {
		t.Fatalf("%s: unknown auth %q", seq.Name, seq.Auth)
	}
	capacity := 0
	if seq.Capacity != nil {
		capacity = *seq.Capacity
	}
	clk := newClock(0)
	return auth.NewVerifier(auth.Config{
		JWKSPath:     path,
		Issuer:       v.Verifier.Issuer,
		Audience:     v.Verifier.Audience,
		MethodAuth:   onlyMethod(seq.Procedure, mode),
		Now:          clk.Now,
		SeenCapacity: capacity,
	}), clk
}

// Every sequence in the shared vectors: tokens presented in order to ONE
// verifier at stated clock readings. A token seen before is refused until it
// expires, a full set refuses new tokens and forgets none, an expired entry is
// purged, and a token refused for another reason is not recorded.
func TestSharedReplaySequences(t *testing.T) {
	v := testvectors.Load(t)
	if len(v.Sequences) < 9 {
		t.Fatalf("the vectors hold %d replay sequences; want at least 9", len(v.Sequences))
	}
	t0 := v.Case(t, "valid-user").Now
	var replayed, full int
	for _, seq := range v.Sequences {
		t.Run(seq.Name, func(t *testing.T) {
			verifier, clk := verifierFor(t, v, seq)
			for i, step := range seq.Steps {
				clk.Set(step.Now)
				caller, err := verifier.Verify(t.Context(), step.Token(), seq.Procedure)
				what := fmt.Sprintf("step %d (now T0%+d)", i, step.Now-t0)
				switch step.Expect {
				case "accept":
					if err != nil {
						t.Fatalf("%s: refused: %v", what, err)
					}
					if caller.Subject != step.Sub || caller.Zone != v.Verifier.Issuer {
						t.Fatalf("%s: caller = %+v; want subject %q", what, caller, step.Sub)
					}
				case "reject":
					want, ok := reasonErr[step.Reason]
					if !ok {
						t.Fatalf("%s: unmapped reason %q", what, step.Reason)
					}
					wantRefused(t, what, err, want)
					if caller != (auth.Caller{}) {
						t.Fatalf("%s: a refused token still produced caller %+v", what, caller)
					}
					switch step.Reason {
					case "replayed":
						replayed++
					case "seen-set-full":
						full++
					}
				default:
					t.Fatalf("%s: unknown expectation %q", what, step.Expect)
				}
			}
		})
	}
	// A run that saw fewer refusals proves nothing about the rules they test.
	if replayed < 8 || full < 6 {
		t.Fatalf("ran %d replay and %d full refusals; want at least 8 and 6", replayed, full)
	}
}

// The defaults the vectors state are the defaults the verifier has.
func TestReplayDefaultsMatchTheVectors(t *testing.T) {
	v := testvectors.Load(t)
	if auth.DefaultSeenCapacity != v.Contract.DefaultSeenCapacity {
		t.Errorf("DefaultSeenCapacity = %d; the vectors say %d", auth.DefaultSeenCapacity, v.Contract.DefaultSeenCapacity)
	}
	if auth.MinJTIChars != v.Contract.JTIChars.Min || auth.MaxJTIChars != v.Contract.JTIChars.Max {
		t.Errorf("jti length = %d..%d; the vectors say %d..%d", auth.MinJTIChars, auth.MaxJTIChars, v.Contract.JTIChars.Min, v.Contract.JTIChars.Max)
	}
	if v.Contract.ClockSkewSeconds != int64(auth.ClockSkew/time.Second) {
		t.Errorf("ClockSkew = %v; the vectors say %ds", auth.ClockSkew, v.Contract.ClockSkewSeconds)
	}
}

// The same token sent twice through the interceptor: the first call reaches the
// handler, the second is refused as unauthenticated before any handler runs, and
// what the caller is told does not name the reason.
func TestReplayedTokenNeverReachesTheHandler(t *testing.T) {
	v := testvectors.Load(t)
	c := v.Case(t, "valid-user")
	verifier, _ := vectorVerifier(t, v, c)
	f := newFixture(t, verifier)
	ctx := withAuthorization(t, "Bearer "+v.Token(t, "valid-user"))
	if _, err := f.example.PutItem(ctx, &examplev1.PutItemRequest{Id: "a"}); err != nil {
		t.Fatalf("the first use of a valid token: %v", err)
	}
	_, err := f.example.PutItem(ctx, &examplev1.PutItemRequest{Id: "a", Value: "attacker-chosen"})
	wantUnauthenticated(t, "the second use of the same token", err)
	var cerr *connect.Error
	if errors.As(err, &cerr) && strings.Contains(strings.ToLower(cerr.Message()), "replay") {
		t.Fatalf("the refusal %q names its reason", cerr.Message())
	}
	if n := f.handler.count(); n != 1 {
		t.Fatalf("the handler ran %d times; want 1 (the replay must not reach it)", n)
	}
}

// A hundred goroutines presenting one token at once: exactly one is admitted.
func TestConcurrentReplayAdmitsExactlyOne(t *testing.T) {
	v := testvectors.Load(t)
	c := v.Case(t, "valid-user")
	verifier, _ := vectorVerifier(t, v, c)
	token := v.Token(t, "valid-user")
	var admitted atomic.Int32
	var wg sync.WaitGroup
	for range 100 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := verifier.Verify(t.Context(), token, c.Procedure); err == nil {
				admitted.Add(1)
			} else if !errors.Is(err, auth.ErrReplayed) {
				t.Errorf("refused with %v; want ErrReplayed", err)
			}
		}()
	}
	wg.Wait()
	if n := admitted.Load(); n != 1 {
		t.Fatalf("%d concurrent uses of one token were admitted; want exactly 1", n)
	}
}

type writerFunc func([]byte) (int, error)

func (f writerFunc) Write(p []byte) (int, error) { return f(p) }

// A pod at its cap refuses every new token, which looks like an outage from
// outside, so it says so: one warning, then at most one every ten seconds. The
// warning never carries a token.
func TestFullReplaySetIsReportedOnceInAWhile(t *testing.T) {
	v := testvectors.Load(t)
	var seq testvectors.Sequence
	for _, s := range v.Sequences {
		if s.Name == "cap-reached-refuses-new" {
			seq = s
		}
	}
	if len(seq.Steps) < 3 || seq.Capacity == nil {
		t.Fatal("no usable cap-reached-refuses-new sequence")
	}
	var buf strings.Builder
	var mu sync.Mutex
	logger := slog.New(slog.NewTextHandler(writerFunc(func(p []byte) (int, error) {
		mu.Lock()
		defer mu.Unlock()
		return buf.Write(p)
	}), nil))
	path := filepath.Join(t.TempDir(), "jwks", "jwks.json")
	v.WriteJWKS(t, path, seq.JWKS)
	clk := newClock(seq.Steps[0].Now)
	verifier := auth.NewVerifier(auth.Config{
		JWKSPath:     path,
		Issuer:       v.Verifier.Issuer,
		Audience:     v.Verifier.Audience,
		MethodAuth:   onlyMethod(seq.Procedure, knextv1.Auth_AUTH_USER),
		Now:          clk.Now,
		SeenCapacity: *seq.Capacity,
		Logger:       logger,
	})
	for _, step := range seq.Steps[:2] {
		if _, err := verifier.Verify(t.Context(), step.Token(), seq.Procedure); err != nil {
			t.Fatalf("filling the set: %v", err)
		}
	}
	full := seq.Steps[2].Token()
	warnings := func() int {
		mu.Lock()
		defer mu.Unlock()
		return strings.Count(buf.String(), "replay set is full")
	}
	for range 5 {
		_, err := verifier.Verify(t.Context(), full, seq.Procedure)
		wantRefused(t, "a new token into a full set", err, auth.ErrSeenSetFull)
	}
	if n := warnings(); n != 1 {
		t.Fatalf("%d warnings for five refusals in one second; want 1", n)
	}
	clk.Advance(9 * time.Second)
	_, _ = verifier.Verify(t.Context(), full, seq.Procedure)
	if n := warnings(); n != 1 {
		t.Fatalf("%d warnings after 9 s; want still 1", n)
	}
	clk.Advance(2 * time.Second)
	_, _ = verifier.Verify(t.Context(), full, seq.Procedure)
	if n := warnings(); n != 2 {
		t.Fatalf("%d warnings after 11 s; want 2", n)
	}
	mu.Lock()
	defer mu.Unlock()
	for _, segment := range seq.Steps[2].JWS {
		if strings.Contains(buf.String(), segment) {
			t.Fatal("the warning carries part of a token")
		}
	}
}

package rpc

// Kept apart from rpc_test.go because it reads the shared token vectors from
// the knext repository, which a function scaffolded by `knext add function`
// does not carry; the rest of the protocol tests travel with the scaffold.

import (
	"path/filepath"
	"testing"
	"time"

	"connectrpc.com/connect/v2"
	"connectrpc.com/connect/v2/connecthttp"

	examplev1 "example.com/function/gen/example/v1"
	"example.com/function/gen/example/v1/examplev1connect"
	"example.com/function/internal/testvectors"
)

// The binary's wiring with a JWKS mounted and its issuer and audience set
// (New, as main calls it): a zone token verifies on every protocol, against
// the auth option the compiled contract states for the RPC, and anything else
// is refused.
func TestProductionWiringVerifiesZoneTokens(t *testing.T) {
	v := testvectors.Load(t)
	c := v.Case(t, "valid-user")
	if c.Procedure != examplev1connect.ExampleServicePutItemProcedure {
		t.Fatalf("valid-user calls %s; this test needs PutItem", c.Procedure)
	}
	path := filepath.Join(t.TempDir(), "jwks", "jwks.json")
	v.WriteJWKS(t, path, c.JWKS)
	f, err := New(Config{
		JWKSPath: path,
		Issuer:   v.Verifier.Issuer,
		Audience: v.Verifier.Audience,
		Now:      func() time.Time { return time.Unix(c.Now, 0) },
	})
	if err != nil {
		t.Fatal(err)
	}
	base := serve(t, f)
	for _, p := range protocols() {
		t.Run(p.name, func(t *testing.T) {
			example := examplev1connect.NewExampleServiceClient(connect.NewClient(connecthttp.NewTransport(p.client, base, p.opts...)))
			if _, err := example.PutItem(bearer(t, v.Token(t, "valid-user")), &examplev1.PutItemRequest{Id: "a", Value: "b"}); err != nil {
				t.Fatalf("PutItem with a valid zone token: %v", err)
			}
			// The same token names PutItem, so it does not open GetItem.
			_, err := example.GetItem(bearer(t, v.Token(t, "valid-user")), &examplev1.GetItemRequest{Id: "a"})
			wantCode(t, "GetItem with a PutItem token", err, connect.CodeUnauthenticated)
			for _, name := range []string{"user-empty-sub", "expired", "cross-zone", "wrong-audience"} {
				_, err := example.PutItem(bearer(t, v.Token(t, name)), &examplev1.PutItemRequest{Id: "a"})
				wantCode(t, "PutItem with "+name, err, connect.CodeUnauthenticated)
			}
			_, err = example.PutItem(t.Context(), &examplev1.PutItemRequest{Id: "a"})
			wantCode(t, "PutItem with no token", err, connect.CodeUnauthenticated)
		})
	}
}

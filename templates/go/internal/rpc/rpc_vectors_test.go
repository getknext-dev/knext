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
	for _, p := range protocols() {
		t.Run(p.name, func(t *testing.T) {
			// One server per protocol: a token is single-use, and the same valid
			// token is the control on each of them.
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
			example := examplev1connect.NewExampleServiceClient(connect.NewClient(connecthttp.NewTransport(p.client, base, p.opts...)))
			// Every refusal first: a refused token is not remembered, so the valid
			// token below is still unused, and a check that was dropped would
			// admit its case (and use up the valid token) rather than be masked.
			// The valid token names PutItem, so it does not open GetItem.
			_, err = example.GetItem(bearer(t, v.Token(t, "valid-user")), &examplev1.GetItemRequest{Id: "a"})
			wantCode(t, "GetItem with a PutItem token", err, connect.CodeUnauthenticated)
			for _, name := range []string{"user-empty-sub", "expired", "cross-zone", "wrong-audience"} {
				_, err := example.PutItem(bearer(t, v.Token(t, name)), &examplev1.PutItemRequest{Id: "a"})
				wantCode(t, "PutItem with "+name, err, connect.CodeUnauthenticated)
			}
			_, err = example.PutItem(t.Context(), &examplev1.PutItemRequest{Id: "a"})
			wantCode(t, "PutItem with no token", err, connect.CodeUnauthenticated)
			if _, err := example.PutItem(bearer(t, v.Token(t, "valid-user")), &examplev1.PutItemRequest{Id: "a", Value: "b"}); err != nil {
				t.Fatalf("PutItem with a valid zone token: %v", err)
			}
			// A token is single-use: the same one again, with a body of the
			// attacker's choosing, is refused on every protocol.
			_, err = example.PutItem(bearer(t, v.Token(t, "valid-user")), &examplev1.PutItemRequest{Id: "a", Value: "attacker-chosen"})
			wantCode(t, "PutItem with a token already used", err, connect.CodeUnauthenticated)
		})
	}
}

// Config.SeenCapacity reaches the token check: with room for one token, the
// first valid token is served and a second, different valid token is refused
// because the replay set is full (not because anything is wrong with it).
func TestSeenCapacityReachesTheTokenCheck(t *testing.T) {
	v := testvectors.Load(t)
	c := v.Case(t, "valid-user")
	path := filepath.Join(t.TempDir(), "jwks", "jwks.json")
	v.WriteJWKS(t, path, c.JWKS)
	f, err := New(Config{
		JWKSPath:     path,
		Issuer:       v.Verifier.Issuer,
		Audience:     v.Verifier.Audience,
		Now:          func() time.Time { return time.Unix(c.Now, 0) },
		SeenCapacity: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	base := serve(t, f)
	p := protocols()[0]
	example := examplev1connect.NewExampleServiceClient(connect.NewClient(connecthttp.NewTransport(p.client, base, p.opts...)))
	if _, err := example.PutItem(bearer(t, v.Token(t, "valid-user")), &examplev1.PutItemRequest{Id: "a", Value: "b"}); err != nil {
		t.Fatalf("the first token: %v", err)
	}
	_, err = example.PutItem(bearer(t, v.Token(t, "valid-user-second-jti")), &examplev1.PutItemRequest{Id: "a", Value: "b"})
	wantCode(t, "a second, different token with room for one", err, connect.CodeUnauthenticated)
}

// Package auth is the function's token check: a connect-go server interceptor
// that runs before any request payload is read, and rejects every RPC except
// the health check unless it carries a zone identity token that verifies.
//
// The token is a JWS signed by the owning zone with Ed25519 (alg EdDSA). It is
// checked against the zone's public keys, mounted as a JWK Set at
// DefaultJWKSPath: its signature and key id, its issuer (the owning zone), its
// audience (this function), its method (the RPC being called), its lifetime,
// and — for an RPC whose (knext.v1.auth) option is AUTH_USER — a non-empty
// subject. The subject is the only user identity a handler may act on:
// CallerFrom returns it. A user id in the request is never trusted.
//
// It fails closed. A missing token, a malformed Authorization header, a
// missing or unreadable JWKS, an unset issuer or audience, an RPC that states
// no auth option, a verifier error and a nil verifier all end the call with
// CodeUnauthenticated before the handler runs. The function is reachable only
// from its zone (cluster-local), and the token is the control that decides
// which calls it serves, so there is no setting here that turns the check off.
package auth

import (
	"context"
	"errors"
	"strings"

	"connectrpc.com/connect/v2"
)

// HealthCheckProcedure is the one RPC served without a token: the standard
// gRPC health check, used by probes and by the zone's wake-ahead call, which
// carry no credentials. Health Watch is not exempt.
const HealthCheckProcedure = "/grpc.health.v1.Health/Check"

// DefaultJWKSPath is where the zone's public keys are mounted, as a volume.
const DefaultJWKSPath = "/var/run/knext/jwks/jwks.json"

// The environment the operator sets on the function: the issuer (the owning
// zone) and the audience (this function) every token must name.
const (
	EnvIssuer   = "KNEXT_TOKEN_ISSUER"
	EnvAudience = "KNEXT_TOKEN_AUDIENCE"
)

var errNoVerifier = errors.New("auth: no verifier configured")

// Caller is who a verified call is from: the zone that signed its token, and
// the user that zone vouched for (empty on an AUTH_PUBLIC RPC called without
// one).
type Caller struct {
	// Subject is the token's sub: the user id from the zone's authorize().
	Subject string
	// Zone is the token's iss: knext:zone:<namespace>/<zone>.
	Zone string
}

type callerKey struct{}

// CallerFrom returns the caller of a call that passed the token check. It is
// the only source of user identity a handler may use.
func CallerFrom(ctx context.Context) (Caller, bool) {
	c, ok := ctx.Value(callerKey{}).(Caller)
	return c, ok
}

func withCaller(ctx context.Context, c Caller) context.Context {
	return context.WithValue(ctx, callerKey{}, c)
}

// Verifier decides whether a bearer token may call procedure. A nil error
// admits the call, as the returned caller; any error rejects it.
type Verifier interface {
	Verify(ctx context.Context, token, procedure string) (Caller, error)
}

type denyAll struct{ err error }

func (d denyAll) Verify(context.Context, string, string) (Caller, error) { return Caller{}, d.err }

// NewInterceptor returns the server interceptor that checks every RPC's
// bearer token with v. A nil v rejects every call except the health check.
func NewInterceptor(v Verifier) connect.ServerInterceptor {
	if v == nil {
		v = denyAll{err: errNoVerifier}
	}
	return func(next connect.ServerFunc) connect.ServerFunc {
		return func(ctx context.Context, spec connect.Spec, stream connect.ServerStream) error {
			if spec.Procedure == HealthCheckProcedure {
				return next(ctx, spec, stream)
			}
			info, ok := connect.CallInfoForServerContext(ctx)
			if !ok {
				return connect.NewError(connect.CodeUnauthenticated, "unauthenticated")
			}
			token, ok := bearerToken(info.RequestHeader().Get("Authorization"))
			if !ok {
				return connect.NewError(connect.CodeUnauthenticated, "missing bearer token")
			}
			caller, err := v.Verify(ctx, token, spec.Procedure)
			if err != nil {
				return connect.NewError(connect.CodeUnauthenticated, "token rejected").WithCause(err)
			}
			return next(withCaller(ctx, caller), spec, stream)
		}
	}
}

// bearerToken returns the token of an "Authorization: Bearer <token>" value.
func bearerToken(header string) (string, bool) {
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return "", false
	}
	token := strings.TrimSpace(header[len(prefix):])
	return token, token != ""
}

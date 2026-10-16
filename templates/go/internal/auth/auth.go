// Package auth is the function's token check: a connect-go server interceptor
// that runs before any request payload is read, and rejects every RPC except
// the health check unless its bearer token verifies.
//
// It fails closed. A missing token, a malformed Authorization header, a
// missing JWKS, a verifier error and a nil verifier all end the call with
// CodeUnauthenticated before the handler runs.
//
// Token verification against the zone's JWKS is not in this version of the
// template: until it is, a mounted JWKS rejects every non-health RPC too.
// The function is reachable only from its zone (cluster-local), and the token
// is the control that decides which calls it serves, so there is no setting
// here that turns the check off.
package auth

import (
	"context"
	"errors"
	"os"
	"strings"

	"connectrpc.com/connect/v2"
)

// HealthCheckProcedure is the one RPC served without a token: the standard
// gRPC health check, used by probes and by the zone's wake-ahead call, which
// carry no credentials. Health Watch is not exempt.
const HealthCheckProcedure = "/grpc.health.v1.Health/Check"

// DefaultJWKSPath is where the zone's public keys are mounted, as a volume.
const DefaultJWKSPath = "/var/run/knext/jwks/jwks.json"

var (
	// ErrNoJWKS means nothing usable is mounted at the JWKS path.
	ErrNoJWKS = errors.New("auth: no JWKS is mounted")
	// ErrVerificationUnavailable means a JWKS is mounted but this version of
	// the template cannot verify tokens against it, so it refuses them all.
	ErrVerificationUnavailable = errors.New("auth: token verification is not available in this template version")
	errNoVerifier              = errors.New("auth: no verifier configured")
)

// Verifier decides whether a bearer token may call procedure. A nil error
// admits the call; any error rejects it.
type Verifier interface {
	Verify(ctx context.Context, token, procedure string) error
}

// MountedJWKS returns the verifier for the JWKS mounted at path. The mount is
// checked on every call, so a JWKS that appears or disappears after start is
// seen without a restart.
func MountedJWKS(path string) Verifier {
	return jwksVerifier{path: path}
}

type jwksVerifier struct {
	path string
}

func (j jwksVerifier) Verify(context.Context, string, string) error {
	if !jwksMounted(j.path) {
		return ErrNoJWKS
	}
	// TODO(#2051): verify the token's signature, kid, exp, aud, iss and
	// method claim against the mounted JWKS. Until then, refuse every token.
	return ErrVerificationUnavailable
}

// jwksMounted reports whether path is a non-empty regular file.
func jwksMounted(path string) bool {
	if path == "" {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Size() > 0
}

type denyAll struct{ err error }

func (d denyAll) Verify(context.Context, string, string) error { return d.err }

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
			if err := v.Verify(ctx, token, spec.Procedure); err != nil {
				return connect.NewError(connect.CodeUnauthenticated, "token rejected").WithCause(err)
			}
			return next(ctx, spec, stream)
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

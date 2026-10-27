package auth

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync/atomic"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
	"google.golang.org/protobuf/types/descriptorpb"

	knextv1 "example.com/function/gen/knext/v1"
)

// The token contract's time bounds.
const (
	// MaxTokenLifetime bounds exp - iat.
	MaxTokenLifetime = 60 * time.Second
	// ClockSkew is how far exp and iat may be off this pod's clock.
	ClockSkew = 5 * time.Second
	// JWKSRereadInterval is the longest a JWKS read is trusted without
	// re-reading the file, even when its modification time has not changed.
	JWKSRereadInterval = 10 * time.Second
	// MaxJWKSBytes bounds the mounted JWKS: a larger file is refused unread.
	MaxJWKSBytes = 64 << 10
)

// Why a call was refused. Never sent to the caller: a refusal on the wire
// says only "unauthenticated".
var (
	// ErrNoJWKS means nothing usable is mounted at the JWKS path.
	ErrNoJWKS = errors.New("auth: no JWKS is mounted")
	// ErrBadJWKS means the mounted JWKS is too large or is not a JWK Set.
	ErrBadJWKS = errors.New("auth: the mounted JWKS is not a usable JWK Set")
	// ErrNotConfigured means the issuer or the audience is not set.
	ErrNotConfigured = errors.New("auth: the token issuer or audience is not configured")
	// ErrNoAuthOption means the RPC states no (knext.v1.auth) option.
	ErrNoAuthOption = errors.New("auth: the RPC states no auth option")

	ErrMalformed      = errors.New("auth: malformed token")
	ErrBadAlg         = errors.New("auth: token algorithm is not EdDSA")
	ErrUnknownKID     = errors.New("auth: token key id is not in the JWKS")
	ErrBadSignature   = errors.New("auth: token signature does not verify")
	ErrLifetime       = errors.New("auth: token lifetime is out of bounds")
	ErrExpired        = errors.New("auth: token expired")
	ErrNotYetValid    = errors.New("auth: token issued in the future")
	ErrWrongIssuer    = errors.New("auth: token issuer is not this function's zone")
	ErrWrongAudience  = errors.New("auth: token audience is not this function")
	ErrWrongMethod    = errors.New("auth: token method is not the RPC called")
	ErrMissingSubject = errors.New("auth: token names no user for a user RPC")
	// ErrMissingJTI means the token has no jti, so it could not be remembered
	// and could be replayed: it is refused.
	ErrMissingJTI = errors.New("auth: token has no jti")
	// ErrReplayed means this token was already accepted by this pod.
	ErrReplayed = errors.New("auth: token already used")
	// ErrSeenSetFull means the replay set is at its cap: a new token is refused
	// rather than a seen one forgotten.
	ErrSeenSetFull = errors.New("auth: the replay set is full")
)

// MethodAuth returns the (knext.v1.auth) option of an RPC, by its procedure
// path, or AUTH_UNSPECIFIED when it states none or is unknown.
type MethodAuth func(procedure string) knextv1.Auth

// DescriptorAuth reads the (knext.v1.auth) option from the compiled contracts
// in files: the generated code registers every contract the function serves
// in protoregistry.GlobalFiles.
func DescriptorAuth(files *protoregistry.Files) MethodAuth {
	return func(procedure string) knextv1.Auth {
		service, method, ok := splitProcedure(procedure)
		if !ok {
			return knextv1.Auth_AUTH_UNSPECIFIED
		}
		d, err := files.FindDescriptorByName(protoreflect.FullName(service))
		if err != nil {
			return knextv1.Auth_AUTH_UNSPECIFIED
		}
		sd, ok := d.(protoreflect.ServiceDescriptor)
		if !ok {
			return knextv1.Auth_AUTH_UNSPECIFIED
		}
		md := sd.Methods().ByName(protoreflect.Name(method))
		if md == nil {
			return knextv1.Auth_AUTH_UNSPECIFIED
		}
		opts, ok := md.Options().(*descriptorpb.MethodOptions)
		if !ok || opts == nil {
			return knextv1.Auth_AUTH_UNSPECIFIED
		}
		mode, _ := proto.GetExtension(opts, knextv1.E_Auth).(knextv1.Auth)
		return mode
	}
}

// splitProcedure splits "/<package>.<Service>/<Method>".
func splitProcedure(procedure string) (service, method string, ok bool) {
	rest, ok := strings.CutPrefix(procedure, "/")
	if !ok {
		return "", "", false
	}
	// An empty or malformed name finds no descriptor below.
	service, method, _ = strings.Cut(rest, "/")
	return service, method, true
}

// Config is what the verifier holds tokens to.
type Config struct {
	// JWKSPath is the mounted JWK Set of the owning zone.
	JWKSPath string
	// Issuer is the owning zone, knext:zone:<namespace>/<zone> ($KNEXT_TOKEN_ISSUER).
	Issuer string
	// Audience is this function, knext:fn:<namespace>/<function> ($KNEXT_TOKEN_AUDIENCE).
	Audience string
	// MethodAuth defaults to the compiled contracts (DescriptorAuth over
	// protoregistry.GlobalFiles).
	MethodAuth MethodAuth
	// Now defaults to time.Now; tests set it.
	Now func() time.Time
	// SeenCapacity is how many accepted tokens the verifier remembers to refuse
	// a replay; zero is DefaultSeenCapacity. At the cap new tokens are refused.
	SeenCapacity int
	// Logger receives the warning that the replay set is full; it defaults to
	// slog.Default().
	Logger *slog.Logger
}

// NewVerifier returns the verifier that checks zone identity tokens against
// the JWKS mounted at cfg.JWKSPath, re-reading it when it changes, and at
// least every JWKSRereadInterval, without a restart.
func NewVerifier(cfg Config) Verifier {
	if cfg.MethodAuth == nil {
		cfg.MethodAuth = DescriptorAuth(protoregistry.GlobalFiles)
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	return &tokenVerifier{
		cfg:  cfg,
		jwks: &jwksFile{path: cfg.JWKSPath, now: cfg.Now},
		seen: newSeenSet(cfg.SeenCapacity),
	}
}

type tokenVerifier struct {
	cfg  Config
	jwks *jwksFile
	seen *seenSet
	// fullLoggedAt is when the "replay set is full" warning last went out.
	fullLoggedAt atomic.Int64
}

// fullWarningEvery bounds how often a full replay set is reported: a pod at its
// cap refuses every new token, and one line a call would bury the log.
const fullWarningEvery = 10 // seconds

func (v *tokenVerifier) warnFull(now int64) {
	last := v.fullLoggedAt.Load()
	if (last == 0 || now-last >= fullWarningEvery) && v.fullLoggedAt.CompareAndSwap(last, now) {
		v.cfg.Logger.Warn("the token replay set is full: new tokens are refused until entries expire",
			"capacity", v.seen.capacity)
	}
}

func (v *tokenVerifier) Verify(_ context.Context, token, procedure string) (Caller, error) {
	keys, err := v.jwks.keys()
	if err != nil {
		return Caller{}, err
	}
	if v.cfg.Issuer == "" || v.cfg.Audience == "" {
		return Caller{}, ErrNotConfigured
	}
	mode := v.cfg.MethodAuth(procedure)
	if mode != knextv1.Auth_AUTH_USER && mode != knextv1.Auth_AUTH_PUBLIC {
		return Caller{}, ErrNoAuthOption
	}
	c, err := verifyToken(token, keys)
	if err != nil {
		return Caller{}, err
	}
	now := v.cfg.Now().Unix()
	if err := c.check(now, v.cfg.Issuer, v.cfg.Audience, procedure, mode); err != nil {
		return Caller{}, err
	}
	// Last, so only a token that passed every check is remembered: a refused
	// token burns nothing. The issuer is the configured string, which every
	// entry shares.
	if err := v.seen.admit(v.cfg.Issuer, c.jti, c.exp+seenSkew, now); err != nil {
		if errors.Is(err, ErrSeenSetFull) {
			v.warnFull(now)
		}
		return Caller{}, err
	}
	return Caller{Subject: c.sub, Zone: c.iss}, nil
}

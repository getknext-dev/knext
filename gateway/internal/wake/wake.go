// Package wake resolves compute targets and wakes/sleeps them. STUB — red.
package wake

import (
	"context"
	"net"
	"os"
	"time"
)

// Env is injected config (GW_* keys) so tests never mutate the process env.
type Env map[string]string

func (e Env) get(key, def string) string {
	if v, ok := e[key]; ok && v != "" {
		return v
	}
	return def
}

// EnvFromOS reads the GW_* keys from the process environment.
func EnvFromOS() Env {
	keys := []string{
		"GW_COMPUTE_MODE", "GW_TARGET", "GW_TARGET_PORT", "GW_TARGET_TEMPLATE",
		"GW_K8S_NAMESPACE", "GW_K8S_DEPLOYMENT", "GW_K8S_DEPLOYMENT_TEMPLATE",
		"GW_WAKE_CMD", "GW_SLEEP_CMD",
	}
	e := Env{}
	for _, k := range keys {
		if v := os.Getenv(k); v != "" {
			e[k] = v
		}
	}
	return e
}

// Target is a resolved compute endpoint plus its idle-tracking key.
type Target struct {
	Host string
	Port int
	Key  string
}

// Opts tunes the connect/wake retry loop.
type Opts struct {
	ConnectTimeoutMs int
	WakeTimeoutMs    int
	RetryMs          int
}

// Driver is the mode-agnostic compute interface.
type Driver interface {
	Mode() string
	Resolve(systemID string) Target
	Wake(ctx context.Context, t Target) error
	Sleep(ctx context.Context, t Target) error
	CanSleep() bool
}

// ParseHostPort splits "host" or "host:port". STUB.
func ParseHostPort(s string, defPort int) (host string, port int) {
	return "", 0
}

// MakeDriver builds a driver from env with the default k8s scaler. STUB.
func MakeDriver(env Env) (Driver, error) {
	return nil, nil
}

// MakeDriverWithScaler builds a driver with an injected scaler. STUB.
func MakeDriverWithScaler(env Env, scaler Scaler) (Driver, error) {
	return nil, nil
}

// TryConnect opens a TCP connection with a timeout. STUB.
func TryConnect(t Target, timeout time.Duration) (net.Conn, error) {
	return nil, nil
}

// ConnectWithWake connects, waking the compute once if needed. STUB.
func ConnectWithWake(ctx context.Context, driver Driver, t Target, opts Opts, onWake func()) (conn net.Conn, woke bool, wakeMs int64, err error) {
	return nil, false, 0, nil
}

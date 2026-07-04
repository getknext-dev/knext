// Package wake resolves compute targets and wakes/sleeps them. The gateway stays
// mode-agnostic: every mode exposes Resolve(systemID) -> Target plus Wake/Sleep.
//
// Modes (GW_COMPUTE_MODE):
//
//	static   - fixed GW_TARGET host:port; wake/sleep are no-ops (compute always on)
//	exec     - GW_WAKE_CMD / GW_SLEEP_CMD shell commands (docker compose, scripts)
//	template - GW_TARGET_TEMPLATE with {system}; wake/sleep via the k8s scale API
//	kubectl  - single deployment GW_K8S_DEPLOYMENT in GW_K8S_NAMESPACE, scaled 0<->1
//
// kubectl-family modes scale the Deployment via the Kubernetes API using
// client-go (in-cluster config if available, else default kubeconfig rules).
package wake

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
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

// EnvFromOS reads every GW_* variable from the process environment.
// Deliberately no whitelist: a stale list silently reverts tuning knobs
// to their compiled-in defaults.
func EnvFromOS() Env {
	e := Env{}
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "GW_") {
			continue
		}
		if i := strings.IndexByte(kv, '='); i > 0 && i < len(kv)-1 {
			e[kv[:i]] = kv[i+1:]
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

// ParseHostPort splits "host" or "host:port", defaulting the port.
func ParseHostPort(s string, defPort int) (host string, port int) {
	i := strings.LastIndex(s, ":")
	if i == -1 {
		return s, defPort
	}
	p, err := strconv.Atoi(s[i+1:])
	if err != nil {
		p = defPort
	}
	return s[:i], p
}

// sh runs a shell command with a 60s timeout, mirroring the Node driver.
func sh(cmd string) error {
	if cmd == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	c := exec.CommandContext(ctx, "/bin/sh", "-c", cmd)
	out, err := c.CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			msg = err.Error()
		}
		return fmt.Errorf("%s: %s", cmd, msg)
	}
	return nil
}

// staticDriver: fixed target, compute always on.
type staticDriver struct{ t Target }

func (d *staticDriver) Mode() string                        { return "static" }
func (d *staticDriver) Resolve(string) Target               { return d.t }
func (d *staticDriver) Wake(context.Context, Target) error  { return nil }
func (d *staticDriver) Sleep(context.Context, Target) error { return nil }
func (d *staticDriver) CanSleep() bool                      { return false }

// execDriver: shell wake/sleep commands.
type execDriver struct {
	t        Target
	wakeCmd  string
	sleepCmd string
}

func (d *execDriver) Mode() string                        { return "exec" }
func (d *execDriver) Resolve(string) Target               { return d.t }
func (d *execDriver) Wake(context.Context, Target) error  { return sh(d.wakeCmd) }
func (d *execDriver) Sleep(context.Context, Target) error { return sh(d.sleepCmd) }
func (d *execDriver) CanSleep() bool                      { return d.sleepCmd != "" }

// kubeDriver: scale a Deployment 0<->wakeReplicas via the k8s API. The writer
// keeps wakeReplicas=1 (single-writer); the read-only pool sets it higher to
// bring N replicas online on wake. When an HPA owns the Deployment it manages
// the count between wakeReplicas and its own max while traffic flows; Sleep
// still returns the pool all the way to 0 on idle (see ROEnv + 26-compute-ro).
type kubeDriver struct {
	t            Target
	namespace    string
	deployment   string
	wakeReplicas int32
	scaler       Scaler
}

func (d *kubeDriver) Mode() string          { return "kubectl" }
func (d *kubeDriver) Resolve(string) Target { return d.t }
func (d *kubeDriver) Wake(ctx context.Context, _ Target) error {
	return d.scaler.Scale(ctx, d.namespace, d.deployment, d.wakeReplicas)
}
func (d *kubeDriver) Sleep(ctx context.Context, _ Target) error {
	return d.scaler.Scale(ctx, d.namespace, d.deployment, 0)
}
func (d *kubeDriver) CanSleep() bool { return true }

// templateDriver: per-system target/deployment from a {system} template.
type templateDriver struct {
	namespace  string
	targetTpl  string
	depTpl     string
	servedDB   string
	defPort    int
	scaler     Scaler
	rolePrefix string          // per-app role prefix (GW_APP_ROLE_PREFIX, default "app_")
	reserved   map[string]bool // system names that must NOT resolve to an app (tmpl/warm/ro)
}

func (d *templateDriver) Mode() string { return "template" }

// ServedDatabase is the physical database every app branch actually serves
// (default "postgres", carrying the inherited template schema). The DSN database
// name only routes to the per-app compute; the gateway rewrites it to this before
// replaying startup. Empty disables rewriting. Only template mode implements it.
func (d *templateDriver) ServedDatabase() string { return d.servedDB }
func (d *templateDriver) Resolve(systemID string) Target {
	host, port := ParseHostPort(strings.ReplaceAll(d.targetTpl, "{system}", systemID), d.defPort)
	return Target{Host: host, Port: port, Key: systemID}
}
func (d *templateDriver) Wake(ctx context.Context, t Target) error {
	return d.scaler.Scale(ctx, d.namespace, strings.ReplaceAll(d.depTpl, "{system}", t.Key), 1)
}
func (d *templateDriver) Sleep(ctx context.Context, t Target) error {
	return d.scaler.Scale(ctx, d.namespace, strings.ReplaceAll(d.depTpl, "{system}", t.Key), 0)
}
func (d *templateDriver) CanSleep() bool { return true }

// MakeDriver builds a driver from env with the default (lazy) k8s scaler.
func MakeDriver(env Env) (Driver, error) {
	return MakeDriverWithScaler(env, nil)
}

// MakeDriverWithScaler builds a driver with an injected scaler (nil = default).
func MakeDriverWithScaler(env Env, scaler Scaler) (Driver, error) {
	mode := env.get("GW_COMPUTE_MODE", "static")
	defPort, err := strconv.Atoi(env.get("GW_TARGET_PORT", "55432"))
	if err != nil {
		defPort = 55432
	}
	ns := env.get("GW_K8S_NAMESPACE", "scale-zero-pg")

	switch mode {
	case "static":
		host, port := ParseHostPort(env.get("GW_TARGET", "127.0.0.1:55432"), defPort)
		return &staticDriver{t: Target{Host: host, Port: port, Key: "static"}}, nil

	case "exec":
		host, port := ParseHostPort(env.get("GW_TARGET", "127.0.0.1:55432"), defPort)
		return &execDriver{
			t:        Target{Host: host, Port: port, Key: "exec"},
			wakeCmd:  env.get("GW_WAKE_CMD", ""),
			sleepCmd: env.get("GW_SLEEP_CMD", ""),
		}, nil

	case "kubectl":
		if scaler == nil {
			scaler = newK8sScaler()
		}
		deployment := env.get("GW_K8S_DEPLOYMENT", "compute")
		host, port := ParseHostPort(env.get("GW_TARGET", fmt.Sprintf("%s.%s.svc:55432", deployment, ns)), defPort)
		wake, err := strconv.Atoi(env.get("GW_WAKE_REPLICAS", "1"))
		if err != nil || wake < 1 {
			wake = 1
		}
		return &kubeDriver{
			t:            Target{Host: host, Port: port, Key: ns + "/" + deployment},
			namespace:    ns,
			deployment:   deployment,
			wakeReplicas: int32(wake),
			scaler:       scaler,
		}, nil

	case "template":
		if scaler == nil {
			scaler = newK8sScaler()
		}
		depTpl := env.get("GW_K8S_DEPLOYMENT_TEMPLATE", "compute-{system}")
		// A deployment template with no {system} placeholder maps every database
		// onto ONE Deployment — silently collapsing per-app computes and violating
		// single-writer the moment two apps connect. Fail fast at construction.
		if !strings.Contains(depTpl, "{system}") {
			return nil, fmt.Errorf("template mode: GW_K8S_DEPLOYMENT_TEMPLATE=%q must contain {system}", depTpl)
		}
		return &templateDriver{
			namespace:  ns,
			targetTpl:  env.get("GW_TARGET_TEMPLATE", fmt.Sprintf("compute-{system}.%s.svc:55433", ns)),
			depTpl:     depTpl,
			servedDB:   env.get("GW_SERVED_DATABASE", "postgres"),
			defPort:    defPort,
			scaler:     scaler,
			rolePrefix: env.get("GW_APP_ROLE_PREFIX", "app_"),
			reserved:   parseReserved(env.get("GW_RESERVED_SYSTEMS", "tmpl,warm,ro")),
		}, nil

	case "warmpool":
		// The warm-standby tier (ADR-0002): a gated pod parked on the gateway's
		// gate port. Needs the richer k8s surface (WarmOps) + the gate listener;
		// the injected scaler, if it also implements WarmOps, is reused (tests).
		ops, ok := scaler.(WarmOps)
		if !ok {
			ops = newK8sScaler()
		}
		gate := NewGate(":" + env.get("GW_GATE_PORT", "9091"))
		return newWarmDriver(env, ops, gate), nil
	}

	return nil, fmt.Errorf("unknown GW_COMPUTE_MODE=%s", mode)
}

// TryConnect opens a TCP connection with a timeout.
func TryConnect(t Target, timeout time.Duration) (net.Conn, error) {
	return net.DialTimeout("tcp", fmt.Sprintf("%s:%d", t.Host, t.Port), timeout)
}

// ConnectWithWake connects to the target, waking the compute if needed. The wake
// is issued exactly once, then we poll every RetryMs until the wake deadline.
func ConnectWithWake(ctx context.Context, driver Driver, t Target, opts Opts, onWake func()) (conn net.Conn, woke bool, wakeMs int64, err error) {
	connectTimeout := time.Duration(opts.ConnectTimeoutMs) * time.Millisecond
	retry := time.Duration(opts.RetryMs) * time.Millisecond
	deadline := time.Now().Add(time.Duration(opts.WakeTimeoutMs) * time.Millisecond)

	if c, e := TryConnect(t, connectTimeout); e == nil {
		return c, false, 0, nil
	}

	wakeStart := time.Now()
	if onWake != nil {
		onWake()
	}
	if e := driver.Wake(ctx, t); e != nil {
		return nil, false, 0, e
	}
	for {
		c, e := TryConnect(t, connectTimeout)
		if e == nil {
			return c, true, time.Since(wakeStart).Milliseconds(), nil
		}
		if time.Now().After(deadline) {
			return nil, false, 0, fmt.Errorf("wake timed out for %s: %v", t.Key, e)
		}
		time.Sleep(retry)
	}
}

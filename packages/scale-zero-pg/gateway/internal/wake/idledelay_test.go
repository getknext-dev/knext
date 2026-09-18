package wake

import (
	"context"
	"errors"
	"testing"
)

// annScaler is a Scaler that also implements AnnotationReader, so the idle-window
// resolution (#779) can be exercised without a cluster.
type annScaler struct {
	Scaler
	byDeploy map[string]string // deployment -> raw annotation value
	err      error
}

func (s *annScaler) DeploymentAnnotation(_ context.Context, _, deployment, _ string) (string, bool, error) {
	if s.err != nil {
		return "", false, s.err
	}
	v, ok := s.byDeploy[deployment]
	return v, ok, nil
}

// plainScaler implements ONLY Scale (no AnnotationReader).
type plainScaler struct{}

func (plainScaler) Scale(context.Context, string, string, int32) error { return nil }

func TestDeploymentIdleDelayMs(t *testing.T) {
	cases := []struct {
		name   string
		scaler Scaler
		wantMs int
		wantOK bool
	}{
		{"present valid", &annScaler{byDeploy: map[string]string{"compute-shop": "300000"}}, 300000, true},
		{"absent", &annScaler{byDeploy: map[string]string{}}, 0, false},
		{"malformed", &annScaler{byDeploy: map[string]string{"compute-shop": "notanumber"}}, 0, false},
		{"zero", &annScaler{byDeploy: map[string]string{"compute-shop": "0"}}, 0, false},
		{"negative", &annScaler{byDeploy: map[string]string{"compute-shop": "-5"}}, 0, false},
		{"whitespace", &annScaler{byDeploy: map[string]string{"compute-shop": "  60000 "}}, 60000, true},
		{"get error ⇒ fleet default", &annScaler{err: errors.New("apiserver down")}, 0, false},
		{"scaler cannot read annotations", plainScaler{}, 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ms, ok := deploymentIdleDelayMs(context.Background(), tc.scaler, "scale-zero-pg", "compute-shop")
			if ms != tc.wantMs || ok != tc.wantOK {
				t.Fatalf("deploymentIdleDelayMs = (%d,%v), want (%d,%v)", ms, ok, tc.wantMs, tc.wantOK)
			}
		})
	}
}

// The template driver maps a target key to compute-<system> and reads that
// Deployment's annotation, so each app honours its OWN idleDelay.
func TestTemplateDriverIdleDelayMs(t *testing.T) {
	sc := &annScaler{byDeploy: map[string]string{"compute-shop": "120000"}}
	d := &templateDriver{namespace: "scale-zero-pg", depTpl: "compute-{system}", scaler: sc}

	ms, ok := d.IdleDelayMs(context.Background(), Target{Key: "shop"})
	if !ok || ms != 120000 {
		t.Fatalf("template IdleDelayMs(shop) = (%d,%v), want (120000,true)", ms, ok)
	}
	// A different app with no annotation ⇒ fleet default.
	if ms, ok := d.IdleDelayMs(context.Background(), Target{Key: "blog"}); ok || ms != 0 {
		t.Fatalf("template IdleDelayMs(blog) = (%d,%v), want (0,false)", ms, ok)
	}
}

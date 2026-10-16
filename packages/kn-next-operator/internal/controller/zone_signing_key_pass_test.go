/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package controller

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// The zone key's reconcile pass against a fake apiserver whose writes take
// time: the clock moves while each write is in flight, the way a slow
// apiserver (or an admission webhook) makes it move.

// slowWriteClient builds a fake client whose every Create/Update advances the
// clock by latency BEFORE the write lands (the worst case: the apiserver
// commits at the moment it confirms), and reports each confirmed write.
func slowWriteClient(t *testing.T, clock *zoneClock, latency time.Duration, app *appsv1alpha1.NextApp,
	confirmed func(obj client.Object, at time.Time),
) client.Client {
	t.Helper()
	return fake.NewClientBuilder().WithScheme(fakeScheme()).WithObjects(app).WithInterceptorFuncs(interceptor.Funcs{
		Create: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.CreateOption) error {
			clock.Advance(latency)
			if err := c.Create(ctx, obj, opts...); err != nil {
				return err
			}
			confirmed(obj, clock.Now())
			return nil
		},
		Update: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.UpdateOption) error {
			clock.Advance(latency)
			if err := c.Update(ctx, obj, opts...); err != nil {
				return err
			}
			confirmed(obj, clock.Now())
			return nil
		},
	}).Build()
}

func fakeZoneApp() *appsv1alpha1.NextApp {
	return &appsv1alpha1.NextApp{ObjectMeta: metav1.ObjectMeta{Name: "orders", Namespace: "shop", UID: "uid-orders"}}
}

func readFakeSigningKey(t *testing.T, c client.Client) signingKeySet {
	t.Helper()
	sec := &corev1.Secret{}
	if err := c.Get(context.Background(), client.ObjectKey{Namespace: "shop", Name: ZoneSigningKeySecretName("orders")}, sec); err != nil {
		t.Fatalf("reading the key Secret: %v", err)
	}
	keys, err := readSigningKeySecret(sec)
	if err != nil {
		t.Fatalf("parsing the key Secret: %v", err)
	}
	return keys
}

// The propagation bound is counted from the JWKS write the apiserver CONFIRMED,
// and the overlap from the switch write it confirmed: never from a clock
// reading taken before either write returned.
func TestZoneKeyStampsFollowTheConfirmedWrite(t *testing.T) {
	ctx := context.Background()
	t0 := time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC)
	clock := &zoneClock{now: t0}
	const latency = 30 * time.Second
	app := fakeZoneApp()

	var jwksConfirmedAt, switchConfirmedAt time.Time
	signing := ""
	c := slowWriteClient(t, clock, latency, app, func(obj client.Object, at time.Time) {
		switch o := obj.(type) {
		case *corev1.ConfigMap:
			jwksConfirmedAt = at
		case *corev1.Secret:
			if kid := string(o.Data[signingKeyCurrentKid]); signing != "" && kid != signing {
				switchConfirmedAt = at
			}
			signing = string(o.Data[signingKeyCurrentKid])
		}
	})
	r := &NextAppReconciler{Client: c, Scheme: fakeScheme(), Clock: clock.Now}
	bound := DefaultZoneKeyPropagationBound

	if _, err := r.reconcileZoneSigningKey(ctx, app, boundZone()); err != nil {
		t.Fatalf("first pass: %v", err)
	}
	first := signing

	// One pass stages the key (a Secret write), publishes it (the JWKS write)
	// and stamps the publish (a Secret write): 90 s of writes in all.
	app.Annotations = map[string]string{RotateSigningKeyAnnotation: "r1"}
	clock.Advance(time.Minute)
	jwksConfirmedAt = time.Time{}
	if _, err := r.reconcileZoneSigningKey(ctx, app, boundZone()); err != nil {
		t.Fatalf("rotation pass: %v", err)
	}
	if jwksConfirmedAt.IsZero() {
		t.Fatalf("the rotation pass never published the staged key; the proof is vacuous")
	}
	keys := readFakeSigningKey(t, c)
	if keys.next == nil {
		t.Fatalf("the rotation pass must leave a staged key")
	}
	if keys.nextPublishedAt.Before(jwksConfirmedAt) {
		t.Fatalf("next-published-at %s predates the confirmed JWKS write at %s by %s: the bound would start early",
			formatStamp(keys.nextPublishedAt), formatStamp(jwksConfirmedAt), jwksConfirmedAt.Sub(keys.nextPublishedAt))
	}

	// One nanosecond short of the bound after the confirmed publish: no switch.
	clock.Advance(jwksConfirmedAt.Add(bound - time.Nanosecond).Sub(clock.Now()))
	if _, err := r.reconcileZoneSigningKey(ctx, app, boundZone()); err != nil {
		t.Fatalf("pre-bound pass: %v", err)
	}
	if signing != first {
		t.Fatalf("signing switched %s after the confirmed JWKS write; the bound is %s",
			clock.Now().Sub(jwksConfirmedAt), bound)
	}
	clock.Advance(time.Nanosecond)
	if _, err := r.reconcileZoneSigningKey(ctx, app, boundZone()); err != nil {
		t.Fatalf("bound pass: %v", err)
	}
	if signing == first || switchConfirmedAt.IsZero() {
		t.Fatalf("at the bound the staged key must sign")
	}
	keys = readFakeSigningKey(t, c)
	if keys.switchedAt.Before(switchConfirmedAt) {
		t.Fatalf("switched-at %s predates the confirmed switch write at %s: the overlap would end early",
			formatStamp(keys.switchedAt), formatStamp(switchConfirmedAt))
	}
}

// A RetirePrevious write that fails with an error echoing the STORED object
// (an admission webhook that quotes oldObject, whose Secret data is base64)
// must not leak the key the pass has already dropped from memory.
func TestRetirePreviousWriteErrorNeverEchoesTheRetiredKey(t *testing.T) {
	ctx := context.Background()
	clock := &zoneClock{now: time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC)}
	app := fakeZoneApp()
	var stored *corev1.Secret
	echoOld := false
	c := fake.NewClientBuilder().WithScheme(fakeScheme()).WithObjects(app).WithInterceptorFuncs(interceptor.Funcs{
		Update: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.UpdateOption) error {
			if _, ok := obj.(*corev1.Secret); ok && echoOld {
				old := &corev1.Secret{}
				if err := c.Get(ctx, client.ObjectKeyFromObject(obj), old); err != nil {
					return err
				}
				stored = old
				raw, _ := json.Marshal(old)
				return fmt.Errorf("admission webhook \"echo-old\" denied the request: oldObject=%s", raw)
			}
			return c.Update(ctx, obj, opts...)
		},
	}).Build()
	r := &NextAppReconciler{Client: c, Scheme: fakeScheme(), Clock: clock.Now}
	pass := func(label string) {
		if _, err := r.reconcileZoneSigningKey(ctx, app, boundZone()); err != nil {
			t.Fatalf("%s: %v", label, err)
		}
	}
	pass("create")
	app.Annotations = map[string]string{RotateSigningKeyAnnotation: "r1"}
	pass("stage and publish")
	clock.Advance(DefaultZoneKeyPropagationBound)
	pass("switch")
	if keys := readFakeSigningKey(t, c); keys.previous == nil {
		t.Fatalf("setup: the zone must be in its overlap, holding a previous key")
	}

	clock.Advance(ZoneKeyOverlap)
	echoOld = true
	_, err := r.reconcileZoneSigningKey(ctx, app, boundZone())
	if err == nil || !strings.Contains(err.Error(), string(zkRetirePrevious)) {
		t.Fatalf("want the RetirePrevious write refused, got %v", err)
	}
	if stored == nil || len(stored.Data[signingKeyPreviousKey]) == 0 {
		t.Fatalf("the echoed old object must carry the previous key; the proof is vacuous")
	}
	keys, _ := readSigningKeySecretLenient(stored)
	if len(keys) != 2 {
		t.Fatalf("the echoed old object must carry two keys, got %d", len(keys))
	}
	for _, k := range keys {
		for _, m := range keyLeakMarkers(*k) {
			if strings.Contains(err.Error(), m) {
				t.Fatalf("the returned error carries key material of %s: %.24s...", k.kid, m)
			}
		}
	}
}

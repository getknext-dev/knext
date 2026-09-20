package pswatcher

import (
	"context"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
)

// k8s.go carries the two branches the whole #1099 discrimination rests on
// (containersRunning / PodReady) and the freeze read. Both are exercised here
// against client-go's fake clientset so the POD SHAPES — not a hand-rolled stub's
// booleans — decide the verdict.

const testNS = "scale-zero-pg"

func newTestK8sClient(objs ...runtime.Object) *K8sClient {
	// A real apiserver assigns a resourceVersion to every stored object; the stock fake
	// leaves it empty on seeded objects. GetGeneration hands its caller that value as the
	// D4 CAS token, and SetGeneration branches on rv=="" (ledger ABSENT → Create) vs rv!=""
	// (ledger PRESENT → optimistic Update). An existing-but-RV-less ConfigMap would be
	// misread as absent and wrongly Create→AlreadyExists. Stamp seeded ConfigMaps so the
	// fake models the apiserver: an existing ledger reports a non-empty rv, a genuinely
	// absent one is simply not seeded (rv stays "").
	for _, o := range objs {
		if cm, ok := o.(*corev1.ConfigMap); ok && cm.ResourceVersion == "" {
			cm.ResourceVersion = "1"
		}
	}
	return &K8sClient{
		cs:               fake.NewClientset(objs...),
		namespace:        testNS,
		genConfigMap:     "pageserver-generation",
		genKey:           genKeyDefault,
		freezeConfigMap:  "pageserver-failover-freeze",
		primaryContainer: primaryContainerDefault,
	}
}

// running/waiting/terminated build the three container-status shapes.
func runningCS(name string) corev1.ContainerStatus {
	return corev1.ContainerStatus{Name: name, State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}}
}

func waitingCS(name, reason string) corev1.ContainerStatus {
	return corev1.ContainerStatus{Name: name, State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: reason}}}
}

func terminatedCS(name string) corev1.ContainerStatus {
	return corev1.ContainerStatus{Name: name, State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{ExitCode: 1}}}
}

func psPod(name string, ready bool, cs ...corev1.ContainerStatus) *corev1.Pod {
	readyStatus := corev1.ConditionFalse
	if ready {
		readyStatus = corev1.ConditionTrue
	}
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: testNS, Labels: map[string]string{"app": "pageserver"}},
		Status: corev1.PodStatus{
			Phase:             corev1.PodRunning,
			ContainerStatuses: cs,
			Conditions:        []corev1.PodCondition{{Type: corev1.PodReady, Status: readyStatus}},
		},
	}
}

const primarySel = "app=pageserver"

// (1) containersRunning / PodReady over every container-status shape. The RUNNING bit
// is the discrimination: Running ⇒ the process is alive (a degraded dependency, HOLD);
// Waiting/Terminated/empty ⇒ no positive evidence of liveness (a death, PROMOTE).
func TestPodReadyContainerStateShapes(t *testing.T) {
	cases := []struct {
		name        string
		pod         *corev1.Pod
		wantReady   bool
		wantPresent bool
		wantRunning bool
	}{
		{"running and ready", psPod("ps-0", true, runningCS("pageserver")), true, true, true},
		{"running but NotReady (dependency degraded)", psPod("ps-0", false, runningCS("pageserver")), false, true, true},
		{"crashloop (Waiting) is a death", psPod("ps-0", false, waitingCS("pageserver", "CrashLoopBackOff")), false, true, false},
		{"Terminated is a death", psPod("ps-0", false, terminatedCS("pageserver")), false, true, false},
		{"empty containerStatuses is NOT positive evidence of liveness", psPod("ps-0", false), false, true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			k := newTestK8sClient(tc.pod)
			ready, present, running, err := k.PodReady(context.Background(), primarySel)
			if err != nil {
				t.Fatal(err)
			}
			if ready != tc.wantReady || present != tc.wantPresent || running != tc.wantRunning {
				t.Fatalf("PodReady = (ready=%v present=%v running=%v), want (%v %v %v)", ready, present, running, tc.wantReady, tc.wantPresent, tc.wantRunning)
			}
		})
	}
}

// (2) no pod matching the selector ⇒ absent on every bit.
func TestPodReadyAbsent(t *testing.T) {
	k := newTestK8sClient()
	ready, present, running, err := k.PodReady(context.Background(), primarySel)
	if err != nil {
		t.Fatal(err)
	}
	if ready || present || running {
		t.Fatalf("an empty pod list must report absent, got (ready=%v present=%v running=%v)", ready, present, running)
	}
}

// (3) a TERMINATING pod (DeletionTimestamp set) is not counted as a live vantage —
// its containers may still report Running while the pod is on its way out.
func TestPodReadyIgnoresTerminatingPod(t *testing.T) {
	p := psPod("ps-0", true, runningCS("pageserver"))
	now := metav1.NewTime(time.Now())
	p.DeletionTimestamp = &now
	p.Finalizers = []string{"test/keep"} // the fake tracker drops an object deleted with no finalizer
	k := newTestK8sClient(p)
	ready, present, running, err := k.PodReady(context.Background(), primarySel)
	if err != nil {
		t.Fatal(err)
	}
	if ready || running {
		t.Fatalf("a terminating pod must not report ready/running, got (ready=%v running=%v)", ready, running)
	}
	if !present {
		t.Fatal("a terminating pod is still PRESENT (it matches the selector)")
	}
}

// (4) #1099 FIX — a TRUE NODE DEATH. When a node dies there is no kubelet left to
// update pod status, so `containerStatuses` stays FROZEN at Running forever. Reading
// that as "process alive ⇒ dependency degraded ⇒ hold" turns a node death into a
// multi-minute (or, with an `unreachable` toleration, PERMANENT) HA outage. The node
// controller's Ready=False/NodeLost (or NodeStatusUnknown) marking is the signal that
// the Running status is STALE: it is a DEATH, so running must be false → promote.
func TestPodReadyNodeLostIsDeathNotDegradation(t *testing.T) {
	cases := []struct {
		name       string
		mutate     func(*corev1.Pod)
		wantRunnng bool
	}{
		{
			name: "Ready=False reason NodeLost",
			mutate: func(p *corev1.Pod) {
				p.Status.Conditions = []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionFalse, Reason: "NodeLost"}}
			},
		},
		{
			name: "Ready=False reason NodeStatusUnknown",
			mutate: func(p *corev1.Pod) {
				p.Status.Conditions = []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionFalse, Reason: "NodeStatusUnknown"}}
			},
		},
		{
			name:   "pod-level status.reason NodeLost",
			mutate: func(p *corev1.Pod) { p.Status.Reason = "NodeLost" },
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// The kubelet is gone, so the container status is STALE-Running.
			p := psPod("ps-0", false, runningCS("pageserver"))
			tc.mutate(p)
			k := newTestK8sClient(p)
			ready, present, running, err := k.PodReady(context.Background(), primarySel)
			if err != nil {
				t.Fatal(err)
			}
			if !present {
				t.Fatal("the pod object still exists, so present must be true")
			}
			if ready {
				t.Fatal("a node-lost pod is not Ready")
			}
			if running {
				t.Fatal("a node-lost pod's frozen Running containerStatus is STALE — it must read as a DEATH (running=false) so failover promotes, not as a dependency degradation that holds")
			}
		})
	}
}

// (4b) a node-lost pod whose Ready condition was last written TRUE (the node died
// while the pod was healthy) must also read as a death, not as a live-and-ready
// primary — otherwise the watcher reports a suspected partition forever.
func TestPodReadyNodeLostWithStaleReadyTrue(t *testing.T) {
	p := psPod("ps-0", true, runningCS("pageserver"))
	p.Status.Reason = "NodeLost"
	k := newTestK8sClient(p)
	ready, present, running, err := k.PodReady(context.Background(), primarySel)
	if err != nil {
		t.Fatal(err)
	}
	if !present {
		t.Fatal("present must be true")
	}
	if ready || running {
		t.Fatalf("a node-lost pod's status is stale in BOTH bits, got (ready=%v running=%v)", ready, running)
	}
}

// (5) the running bit is scoped to the PAGESERVER container by name, so a future
// sidecar crashlooping is not misread as the primary dying.
func TestContainersRunningIsScopedToThePageserverContainer(t *testing.T) {
	p := psPod("ps-0", false, runningCS("pageserver"), waitingCS("metrics-sidecar", "CrashLoopBackOff"))
	k := newTestK8sClient(p)
	_, _, running, err := k.PodReady(context.Background(), primarySel)
	if err != nil {
		t.Fatal(err)
	}
	if !running {
		t.Fatal("a crashlooping SIDECAR must not read as the pageserver process dying — the running bit is scoped to the pageserver container")
	}
}

// (5b) if the configured container name matches nothing in the status list we have NO
// positive evidence of liveness, so running=false (the pre-#1099 posture) rather than
// a fabricated "alive" that could hold through a real death forever.
func TestContainersRunningWithUnknownContainerNameIsNotRunning(t *testing.T) {
	p := psPod("ps-0", false, runningCS("something-else"))
	k := newTestK8sClient(p)
	_, _, running, err := k.PodReady(context.Background(), primarySel)
	if err != nil {
		t.Fatal(err)
	}
	if running {
		t.Fatal("the configured pageserver container is absent from containerStatuses — that is not positive evidence of liveness")
	}
}

// (6) FailoverFreeze — the read contract. Absent CM / empty value ⇒ no freeze, no
// error. A malformed `until` is an ERROR (the Controller turns it into a counted,
// alertable fail-SAFE, never a silent HA disable — see the watcher tests).
func TestFailoverFreezeRead(t *testing.T) {
	until := time.Date(2026, 9, 20, 12, 30, 0, 0, time.UTC)
	created := time.Date(2026, 9, 20, 12, 0, 0, 0, time.UTC)

	t.Run("absent ConfigMap is no freeze", func(t *testing.T) {
		k := newTestK8sClient()
		_, _, present, err := k.FailoverFreeze(context.Background())
		if err != nil {
			t.Fatalf("an absent freeze CM must not error: %v", err)
		}
		if present {
			t.Fatal("no freeze CM ⇒ present=false")
		}
	})

	t.Run("empty until is no freeze", func(t *testing.T) {
		cm := &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{Name: "pageserver-failover-freeze", Namespace: testNS},
			Data:       map[string]string{"until": ""},
		}
		k := newTestK8sClient(cm)
		_, _, present, err := k.FailoverFreeze(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if present {
			t.Fatal("an empty until ⇒ present=false (no freeze)")
		}
	})

	t.Run("malformed until is an error", func(t *testing.T) {
		cm := &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{Name: "pageserver-failover-freeze", Namespace: testNS},
			Data:       map[string]string{"until": "2026-09-20 12:00:00"}, // space, not T — the fat-finger
		}
		k := newTestK8sClient(cm)
		_, _, _, err := k.FailoverFreeze(context.Background())
		if err == nil {
			t.Fatal("a non-RFC3339 until must surface an error, not be silently ignored")
		}
		if !strings.Contains(err.Error(), "RFC3339") {
			t.Fatalf("the error must name the expected format, got %v", err)
		}
	})

	t.Run("valid until returns until + createdAt", func(t *testing.T) {
		cm := &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{
				Name: "pageserver-failover-freeze", Namespace: testNS,
				CreationTimestamp: metav1.NewTime(created),
			},
			Data: map[string]string{"until": until.Format(time.RFC3339), "reason": "cred rotation"},
		}
		k := newTestK8sClient(cm)
		gotUntil, gotCreated, present, err := k.FailoverFreeze(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if !present {
			t.Fatal("a valid freeze CM ⇒ present=true")
		}
		if !gotUntil.Equal(until) {
			t.Fatalf("until = %v, want %v", gotUntil, until)
		}
		if !gotCreated.Equal(created) {
			t.Fatalf("createdAt = %v, want %v", gotCreated, created)
		}
	})
}

package pswatcher

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

// K8sClient implements K8sOps against a real cluster via client-go. Config
// resolution: in-cluster first, else the default kubeconfig rules.
type K8sClient struct {
	cs              kubernetes.Interface
	namespace       string
	genConfigMap    string
	genKey          string
	freezeConfigMap string
	// primaryContainer is the container in the primary pageserver pod whose Running
	// state is the liveness evidence (see containersRunning). Scoping by NAME means a
	// future sidecar crashlooping is not misread as the pageserver process dying.
	primaryContainer string
}

const genKeyDefault = "generation"

// primaryContainerDefault is the pageserver container's name in
// deploy/53-pageserver.yaml. Overridable via PSW_PRIMARY_CONTAINER.
const primaryContainerDefault = "pageserver"

// freezeUntilKey is the maintenance-freeze ConfigMap key holding the RFC3339 expiry.
const freezeUntilKey = "until"

// NewK8sClient builds a client-go-backed K8sOps. genConfigMap is the ConfigMap
// (in namespace) that persists the last-used generation under key "generation";
// freezeConfigMap is the ConfigMap an admin/operator sets to pause failover during a
// planned op (its "until" key is an RFC3339 expiry). Absence of the freeze CM means
// "no freeze". primaryContainer names the pageserver container inside the primary pod
// whose Running state is read as liveness evidence; empty falls back to
// primaryContainerDefault.
func NewK8sClient(namespace, genConfigMap, freezeConfigMap, primaryContainer string) (*K8sClient, error) {
	if primaryContainer == "" {
		primaryContainer = primaryContainerDefault
	}
	cfg, err := rest.InClusterConfig()
	if err != nil {
		loading := clientcmd.NewDefaultClientConfigLoadingRules()
		cc := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(loading, &clientcmd.ConfigOverrides{})
		if cfg, err = cc.ClientConfig(); err != nil {
			return nil, err
		}
	}
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	return &K8sClient{cs: cs, namespace: namespace, genConfigMap: genConfigMap, genKey: genKeyDefault, freezeConfigMap: freezeConfigMap, primaryContainer: primaryContainer}, nil
}

// FailoverFreeze reads the maintenance-freeze ConfigMap. present=false when the CM is
// absent or carries no "until" value (no freeze). The returned `until` is the raw
// RFC3339 expiry the admin/operator set and `createdAt` is the CM's creation time;
// the Controller applies the TTL clamp so the bound is unit-tested. A malformed
// "until" is surfaced as an ERROR rather than silently ignored — but the error is a
// REPORT, not a verdict: the Controller treats it as "no freeze" (HA stays ON) and
// counts it (pswatcher_freeze_read_errors_total), because a permanent parse error
// aborting every tick would silently disable HA altogether (#1099 review, FIX 1).
func (k *K8sClient) FailoverFreeze(ctx context.Context) (time.Time, time.Time, bool, error) {
	cm, err := k.cs.CoreV1().ConfigMaps(k.namespace).Get(ctx, k.freezeConfigMap, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			return time.Time{}, time.Time{}, false, nil // no freeze set
		}
		return time.Time{}, time.Time{}, false, err
	}
	raw, ok := cm.Data[freezeUntilKey]
	if !ok || raw == "" {
		return time.Time{}, time.Time{}, false, nil
	}
	until, perr := time.Parse(time.RFC3339, raw)
	if perr != nil {
		return time.Time{}, time.Time{}, false, fmt.Errorf("failover-freeze ConfigMap %q key %q is not RFC3339: %q: %w", k.freezeConfigMap, freezeUntilKey, raw, perr)
	}
	return until, cm.CreationTimestamp.Time, true, nil
}

func (k *K8sClient) ServiceSelectorApp(ctx context.Context, service string) (string, error) {
	svc, err := k.cs.CoreV1().Services(k.namespace).Get(ctx, service, metav1.GetOptions{})
	if err != nil {
		return "", err
	}
	return svc.Spec.Selector["app"], nil
}

func (k *K8sClient) FlipServiceSelector(ctx context.Context, service, app string) error {
	// Merge-patch only the app key; any other selector keys are left untouched.
	patch := []byte(fmt.Sprintf(`{"spec":{"selector":{"app":%q}}}`, app))
	_, err := k.cs.CoreV1().Services(k.namespace).Patch(ctx, service, types.MergePatchType, patch, metav1.PatchOptions{})
	return err
}

// DeletePods deletes each matching pod by name — needs only the `delete` verb
// (DeleteCollection would demand the broader `deletecollection` verb).
func (k *K8sClient) DeletePods(ctx context.Context, selector string) (int, error) {
	list, err := k.cs.CoreV1().Pods(k.namespace).List(ctx, metav1.ListOptions{LabelSelector: selector})
	if err != nil {
		return 0, err
	}
	for i := range list.Items {
		if derr := k.cs.CoreV1().Pods(k.namespace).Delete(ctx, list.Items[i].Name, metav1.DeleteOptions{}); derr != nil {
			if apierrors.IsNotFound(derr) {
				continue
			}
			return 0, derr
		}
	}
	return len(list.Items), nil
}

// PodReady is the API-server (kubelet) vantage on the primary pageserver's health,
// independent of the watcher's own HTTP probe. It returns:
//   - ready:   a matching, non-terminating pod is Running with a Ready condition True;
//   - present: at least one pod matches selector;
//   - running: a matching, non-terminating pod has ALL its containers in the Running
//     state (the process is alive) regardless of the Ready condition.
//
// The running bit discriminates a dependency degradation from a node death (#1099):
// present + NotReady + running is a live pageserver whose readiness probe (also
// /v1/status) is failing because a DEPENDENCY degraded (object-store creds
// mid-rotation), not a dead node. A container that is Waiting (CrashLoopBackOff) or
// Terminated reports running=false — a genuine death.
//
// A NODE-LOST pod reports BOTH bits false regardless of what its status says: with no
// kubelet left to write status, `ready` and `containerStatuses` are frozen at whatever
// they last were, so trusting them would read a dead node as either "healthy" (a
// suspected partition, forever) or "degraded" (a hold, forever). See nodeLost.
func (k *K8sClient) PodReady(ctx context.Context, selector string) (bool, bool, bool, error) {
	list, err := k.cs.CoreV1().Pods(k.namespace).List(ctx, metav1.ListOptions{LabelSelector: selector})
	if err != nil {
		return false, false, false, err
	}
	if len(list.Items) == 0 {
		return false, false, false, nil // absent — genuinely gone
	}
	running := false
	for i := range list.Items {
		p := &list.Items[i]
		if p.DeletionTimestamp != nil || p.Status.Phase != corev1.PodRunning {
			continue
		}
		if nodeLost(p) {
			// Stale status from a node with no kubelet: neither bit may be trusted.
			// Leave running as-is (false unless another pod is genuinely running) and
			// never return ready=true off a frozen condition.
			continue
		}
		if containersRunning(p, k.primaryContainer) {
			running = true
		}
		for _, cond := range p.Status.Conditions {
			if cond.Type == corev1.PodReady && cond.Status == corev1.ConditionTrue {
				return true, true, running, nil // present & ready per the kubelet
			}
		}
	}
	return false, true, running, nil // present but not ready
}

// nodeLost reports whether the pod's status is STALE because its node stopped
// reporting — a true node death (#1099 FIX 2).
//
// This is the failure mode the container-running discrimination would otherwise invert
// into an outage: when a node dies there is no kubelet to update pod status, so
// `containerStatuses` stays frozen at `Running` indefinitely. The naive read is
// "process alive ⇒ dependency degraded ⇒ HOLD", which defers recovery until
// taint-based eviction (~5.5 min on cluster defaults, versus ~40s before #1099) — and
// with an `unreachable` toleration on the storage plane, defers it FOREVER: a silent,
// permanent HA outage. (deploy/_validate.sh asserts the storage plane carries no such
// toleration so the permanent variant cannot be introduced silently.)
//
// The node-lifecycle controller is the vantage: it marks the pods of an unreachable
// node `Ready=False` with reason `NodeLost` (and the node itself `Ready=Unknown` with
// reason `NodeStatusUnknown`); some paths stamp `pod.status.reason = NodeLost`. Any of
// those means the Running status is not evidence of anything, so we classify it as a
// DEATH — the direction that promotes and restores reads.
func nodeLost(p *corev1.Pod) bool {
	if p.Status.Reason == "NodeLost" || p.Status.Reason == "NodeStatusUnknown" {
		return true
	}
	for _, cond := range p.Status.Conditions {
		if cond.Type != corev1.PodReady || cond.Status != corev1.ConditionFalse {
			continue
		}
		if cond.Reason == "NodeLost" || cond.Reason == "NodeStatusUnknown" {
			return true
		}
	}
	return false
}

// containersRunning reports whether the PAGESERVER container (by name) is in the
// Running state. A container that is Waiting (CrashLoopBackOff / ImagePullBackOff) or
// Terminated makes the process "not running" — the death signal the failover trigger
// promotes on.
//
// Two deliberate fail-to-"not running" cases, both because we only assert liveness on
// POSITIVE evidence:
//   - an empty container-status list (status not yet reported);
//   - a `primary` name that matches nothing in the status list (a renamed container /
//     misconfigured PSW_PRIMARY_CONTAINER). Failing this way costs the discrimination
//     — i.e. the pre-#1099 posture of promoting on a degradation — whereas the other
//     direction would fabricate liveness and could HOLD through a real death forever.
//
// Scoping by name means a future SIDECAR crashlooping is not read as the pageserver
// process dying. `primary` empty falls back to "every container must be Running".
func containersRunning(p *corev1.Pod, primary string) bool {
	if len(p.Status.ContainerStatuses) == 0 {
		return false
	}
	if primary != "" {
		for _, cs := range p.Status.ContainerStatuses {
			if cs.Name == primary {
				return cs.State.Running != nil
			}
		}
		return false // the configured container is not in the status list
	}
	for _, cs := range p.Status.ContainerStatuses {
		if cs.State.Running == nil {
			return false
		}
	}
	return true
}

func (k *K8sClient) GetGeneration(ctx context.Context) (int, bool, string, error) {
	cm, err := k.cs.CoreV1().ConfigMaps(k.namespace).Get(ctx, k.genConfigMap, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			// The ConfigMap itself is absent: no version to CAS against yet.
			return 0, false, "", nil
		}
		return 0, false, "", err
	}
	// The ConfigMap exists: hand back its resourceVersion even when the key is unset, so a
	// caller that seeds an absent key still CASes against the object it read (D4).
	rv := cm.ResourceVersion
	raw, ok := cm.Data[k.genKey]
	if !ok || raw == "" {
		return 0, false, rv, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return 0, false, rv, fmt.Errorf("generation ConfigMap %q key %q is not an int: %q", k.genConfigMap, k.genKey, raw)
	}
	return n, true, rv, nil
}

// SetGeneration persists the generation with an optimistic-concurrency precondition
// (D4, ADR-0010 §4). A merge-patch carries NO precondition, so a loser in the
// two-writers-during-a-partition window would clobber a higher write. Instead we read the
// object (preserving any other keys), set the generation key, and Update at the EXPECTED
// resourceVersion so the API server rejects the write if a racing writer advanced it
// since. A stale rv detected before the Update, or a Conflict from the Update itself, is
// surfaced as ErrLedgerConflict — never a silent overwrite.
//
// rv == "" means the ledger did not EXIST at read time (GetGeneration returns rv=="" when
// the ConfigMap/key is absent — the seed case, and the #1095 absent-ledger failover). We
// CREATE it rather than Get-then-unconditionally-Update: a Create is itself a compare-and-
// swap against non-existence, so if a concurrent writer (a second, partitioned pswatcher
// reserving from the same absent-ledger state) created it first, we get AlreadyExists and
// surface ErrLedgerConflict — fail CLOSED. The old unconditional-Update path was a
// fail-OPEN hole: two partitioned watchers both reading rv=="" would both Update and both
// promote (D4/BLOCK-1). Create closes it so the reserve is CAS-safe from BOTH the
// ledger-present and ledger-absent states.
func (k *K8sClient) SetGeneration(ctx context.Context, gen int, rv string) error {
	if rv == "" {
		cm := &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{Name: k.genConfigMap, Namespace: k.namespace},
			Data:       map[string]string{k.genKey: strconv.Itoa(gen)},
		}
		if _, cerr := k.cs.CoreV1().ConfigMaps(k.namespace).Create(ctx, cm, metav1.CreateOptions{}); cerr != nil {
			if apierrors.IsAlreadyExists(cerr) {
				return fmt.Errorf("ledger already established by a concurrent writer while reserving at generation %d: %w", gen, errors.Join(ErrLedgerConflict, cerr))
			}
			return cerr
		}
		return nil
	}
	cm, err := k.cs.CoreV1().ConfigMaps(k.namespace).Get(ctx, k.genConfigMap, metav1.GetOptions{})
	if err != nil {
		return err
	}
	if rv != "" && cm.ResourceVersion != rv {
		// The ledger moved between our read and now — the caller's rv is stale, so an
		// Update would either clobber (if we reset rv) or 409. Fail closed, loudly.
		return fmt.Errorf("ledger at resourceVersion %q, expected %q: %w", cm.ResourceVersion, rv, ErrLedgerConflict)
	}
	if cm.Data == nil {
		cm.Data = map[string]string{}
	}
	cm.Data[k.genKey] = strconv.Itoa(gen)
	// cm.ResourceVersion is the fresh value from Get (== rv when a precondition was
	// requested); passing it to Update makes the API server enforce the CAS against any
	// write that lands between our Get and our Update.
	if _, uerr := k.cs.CoreV1().ConfigMaps(k.namespace).Update(ctx, cm, metav1.UpdateOptions{}); uerr != nil {
		if apierrors.IsConflict(uerr) {
			return fmt.Errorf("ledger update conflicted: %w", errors.Join(ErrLedgerConflict, uerr))
		}
		return uerr
	}
	return nil
}

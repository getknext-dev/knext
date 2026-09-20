package pswatcher

import (
	"context"
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
}

const (
	genKeyDefault  = "generation"
	freezeUntilKey = "until" // RFC3339 absolute expiry of the maintenance freeze
)

// NewK8sClient builds a client-go-backed K8sOps. genConfigMap is the ConfigMap
// (in namespace) that persists the last-used generation under key "generation";
// freezeConfigMap is the ConfigMap an admin/operator sets to pause failover during a
// planned op (its "until" key is an RFC3339 expiry). Absence of the freeze CM means
// "no freeze".
func NewK8sClient(namespace, genConfigMap, freezeConfigMap string) (*K8sClient, error) {
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
	return &K8sClient{cs: cs, namespace: namespace, genConfigMap: genConfigMap, genKey: genKeyDefault, freezeConfigMap: freezeConfigMap}, nil
}

// FailoverFreeze reads the maintenance-freeze ConfigMap. present=false when the CM is
// absent or carries no "until" value (no freeze). The returned `until` is the raw
// RFC3339 expiry the admin/operator set and `createdAt` is the CM's creation time;
// the Controller applies the TTL clamp so the bound is unit-tested. A malformed
// "until" is surfaced as an error (loud) rather than silently ignored — a freeze the
// operator meant to set must not fail open.
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
		if containersRunning(p) {
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

// containersRunning reports whether EVERY container in the pod is in the Running
// state. A single container that is Waiting (CrashLoopBackOff / ImagePullBackOff) or
// Terminated makes the process "not running" — the death signal the failover trigger
// promotes on. An empty container-status list (status not yet reported) is NOT
// treated as running: we only assert liveness on positive evidence.
func containersRunning(p *corev1.Pod) bool {
	if len(p.Status.ContainerStatuses) == 0 {
		return false
	}
	for _, cs := range p.Status.ContainerStatuses {
		if cs.State.Running == nil {
			return false
		}
	}
	return true
}

func (k *K8sClient) GetGeneration(ctx context.Context) (int, bool, error) {
	cm, err := k.cs.CoreV1().ConfigMaps(k.namespace).Get(ctx, k.genConfigMap, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			return 0, false, nil
		}
		return 0, false, err
	}
	raw, ok := cm.Data[k.genKey]
	if !ok || raw == "" {
		return 0, false, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return 0, false, fmt.Errorf("generation ConfigMap %q key %q is not an int: %q", k.genConfigMap, k.genKey, raw)
	}
	return n, true, nil
}

func (k *K8sClient) SetGeneration(ctx context.Context, gen int) error {
	patch := []byte(fmt.Sprintf(`{"data":{%q:%q}}`, k.genKey, strconv.Itoa(gen)))
	_, err := k.cs.CoreV1().ConfigMaps(k.namespace).Patch(ctx, k.genConfigMap, types.MergePatchType, patch, metav1.PatchOptions{})
	return err
}

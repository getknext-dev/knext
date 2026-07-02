package wake

import (
	"context"
	"sync"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

// k8sScaler also satisfies WarmOps: the warmpool driver's single-writer check
// and re-park both go through the same lazily-built client.
var _ WarmOps = (*k8sScaler)(nil)

// Scaler scales a Deployment's replica count. Behind an interface so tests can
// fake it without a cluster.
type Scaler interface {
	Scale(ctx context.Context, namespace, deployment string, replicas int32) error
}

// k8sScaler talks to the Kubernetes API via client-go. Config resolution:
// in-cluster config when available, else the default kubeconfig loading rules.
// The client is built lazily on first Scale so constructing a kubectl/template
// driver never requires a cluster.
type k8sScaler struct {
	once   sync.Once
	client kubernetes.Interface
	err    error
}

func newK8sScaler() *k8sScaler { return &k8sScaler{} }

func (k *k8sScaler) init() error {
	k.once.Do(func() {
		cfg, err := rest.InClusterConfig()
		if err != nil {
			loading := clientcmd.NewDefaultClientConfigLoadingRules()
			cc := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(loading, &clientcmd.ConfigOverrides{})
			cfg, err = cc.ClientConfig()
			if err != nil {
				k.err = err
				return
			}
		}
		cs, err := kubernetes.NewForConfig(cfg)
		if err != nil {
			k.err = err
			return
		}
		k.client = cs
	})
	return k.err
}

func (k *k8sScaler) Scale(ctx context.Context, namespace, deployment string, replicas int32) error {
	if err := k.init(); err != nil {
		return err
	}
	scale, err := k.client.AppsV1().Deployments(namespace).GetScale(ctx, deployment, metav1.GetOptions{})
	if err != nil {
		return err
	}
	scale.Spec.Replicas = replicas
	_, err = k.client.AppsV1().Deployments(namespace).UpdateScale(ctx, deployment, scale, metav1.UpdateOptions{})
	return err
}

// Replicas reads a deployment's desired replica count (the single-writer check
// wants desired, not observed: a just-scaled-up deployment must count as active
// even before its pod appears).
func (k *k8sScaler) Replicas(ctx context.Context, namespace, deployment string) (int32, error) {
	if err := k.init(); err != nil {
		return 0, err
	}
	scale, err := k.client.AppsV1().Deployments(namespace).GetScale(ctx, deployment, metav1.GetOptions{})
	if err != nil {
		return 0, err
	}
	return scale.Spec.Replicas, nil
}

// CountPods counts pods matching selector in namespace, in ANY phase — a
// Terminating pod still holds the timeline, so it must count toward "active".
func (k *k8sScaler) CountPods(ctx context.Context, namespace, selector string) (int, error) {
	if err := k.init(); err != nil {
		return 0, err
	}
	list, err := k.client.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{LabelSelector: selector})
	if err != nil {
		return 0, err
	}
	return len(list.Items), nil
}

// DeletePods deletes every pod matching selector individually by name (re-park:
// the warm Deployment respawns a fresh pod that blocks on the now-closed gate).
// Per-name Delete needs only the `delete` verb — DeleteCollection would demand
// the broader `deletecollection` verb. Returns the count that existed.
func (k *k8sScaler) DeletePods(ctx context.Context, namespace, selector string) (int, error) {
	if err := k.init(); err != nil {
		return 0, err
	}
	list, err := k.client.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{LabelSelector: selector})
	if err != nil {
		return 0, err
	}
	for i := range list.Items {
		name := list.Items[i].Name
		if derr := k.client.CoreV1().Pods(namespace).Delete(ctx, name, metav1.DeleteOptions{}); derr != nil {
			return 0, derr
		}
	}
	return len(list.Items), nil
}

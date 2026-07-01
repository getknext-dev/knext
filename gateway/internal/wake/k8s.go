package wake

import (
	"context"
	"sync"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

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

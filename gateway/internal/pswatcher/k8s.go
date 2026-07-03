package pswatcher

import (
	"context"
	"fmt"
	"strconv"

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
	cs           kubernetes.Interface
	namespace    string
	genConfigMap string
	genKey       string
}

const genKeyDefault = "generation"

// NewK8sClient builds a client-go-backed K8sOps. genConfigMap is the ConfigMap
// (in namespace) that persists the last-used generation under key "generation".
func NewK8sClient(namespace, genConfigMap string) (*K8sClient, error) {
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
	return &K8sClient{cs: cs, namespace: namespace, genConfigMap: genConfigMap, genKey: genKeyDefault}, nil
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

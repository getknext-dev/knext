package writerscaler

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

// bounceAnnotation is set on a writer pod that is memory-bound at its max limit,
// requesting an operator maintenance-window bounce (shared_buffers is boot-fixed).
const bounceAnnotation = "writer-autoscaler.scale-zero-pg/needs-bounce"

// K8sClient implements Cluster against a real cluster via client-go. It resizes
// the writer container in place (pods/resize subresource) and reads live usage
// from metrics-server (metrics.k8s.io/v1beta1). In-cluster config first, else the
// default kubeconfig rules.
type K8sClient struct {
	cs        kubernetes.Interface
	rest      rest.Interface
	namespace string
	selector  string // label selector for writer compute pods (e.g. plane=compute)
	container string // the compute container name inside each writer pod
}

// NewK8sClient builds a client-go-backed Cluster. selector must match the WRITER
// computes only (the read-replica pool carries a different label and is excluded).
func NewK8sClient(namespace, selector, container string) (*K8sClient, error) {
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
	return &K8sClient{
		cs:        cs,
		rest:      cs.CoreV1().RESTClient(),
		namespace: namespace,
		selector:  selector,
		container: container,
	}, nil
}

// appOf derives the app suffix ("" for the primary "compute", else the compute-<app>
// suffix) for logging/labelling.
func appOf(podName string) string {
	// pods are named <deployment>-<replicaset>-<hash>; use the pod's app label instead
	// where available. Here we only need a short human tag, so fall back to the name.
	return podName
}

// Writers lists Running writer pods and reads each one's ACTUATED resources from
// status.containerStatuses (the live cgroup values under in-place resize), falling
// back to the spec when the status hasn't reported them yet.
func (k *K8sClient) Writers(ctx context.Context) ([]PodInfo, error) {
	list, err := k.cs.CoreV1().Pods(k.namespace).List(ctx, metav1.ListOptions{LabelSelector: k.selector})
	if err != nil {
		return nil, err
	}
	out := make([]PodInfo, 0, len(list.Items))
	for i := range list.Items {
		p := &list.Items[i]
		if p.Status.Phase != corev1.PodRunning || p.DeletionTimestamp != nil {
			continue
		}
		info := PodInfo{
			Name:          p.Name,
			App:           p.Labels["app"],
			RestartCount:  restartCountOf(p, k.container),
			BounceFlagged: p.Annotations[bounceAnnotation] != "",
		}
		if info.App == "" {
			info.App = appOf(p.Name)
		}
		// Prefer the actuated (status) resources; fall back to the spec.
		req, lim := actuatedResources(p, k.container)
		info.CPUReqMilli = req.Cpu().MilliValue()
		info.CPULimMilli = lim.Cpu().MilliValue()
		info.MemReqBytes = req.Memory().Value()
		info.MemLimBytes = lim.Memory().Value()
		out = append(out, info)
	}
	return out, nil
}

func restartCountOf(p *corev1.Pod, container string) int32 {
	for i := range p.Status.ContainerStatuses {
		if p.Status.ContainerStatuses[i].Name == container {
			return p.Status.ContainerStatuses[i].RestartCount
		}
	}
	return 0
}

// actuatedResources returns the live requests/limits for the writer container:
// status.containerStatuses[].resources (what the kubelet has actuated) when
// present, else spec.containers[].resources.
func actuatedResources(p *corev1.Pod, container string) (req, lim corev1.ResourceList) {
	for i := range p.Status.ContainerStatuses {
		cs := &p.Status.ContainerStatuses[i]
		if cs.Name == container && cs.Resources != nil {
			return cs.Resources.Requests, cs.Resources.Limits
		}
	}
	for i := range p.Spec.Containers {
		c := &p.Spec.Containers[i]
		if c.Name == container {
			return c.Resources.Requests, c.Resources.Limits
		}
	}
	return corev1.ResourceList{}, corev1.ResourceList{}
}

// podMetricsList is the minimal shape of metrics.k8s.io/v1beta1 PodMetrics we need.
// Parsed by hand (via the RESTClient raw path) so we do NOT pull in the whole
// k8s.io/metrics module for two fields.
type podMetricsList struct {
	Items []struct {
		Metadata struct {
			Name string `json:"name"`
		} `json:"metadata"`
		Containers []struct {
			Name  string `json:"name"`
			Usage struct {
				CPU    string `json:"cpu"`
				Memory string `json:"memory"`
			} `json:"usage"`
		} `json:"containers"`
	} `json:"items"`
}

// Usage reads live per-pod usage of the writer container from metrics-server. A
// missing metrics API surfaces as an error so the caller logs it and skips the tick
// (we never resize blind).
func (k *K8sClient) Usage(ctx context.Context) (map[string]Usage, error) {
	raw, err := k.rest.Get().
		AbsPath("/apis/metrics.k8s.io/v1beta1/namespaces", k.namespace, "pods").
		DoRaw(ctx)
	if err != nil {
		return nil, fmt.Errorf("metrics.k8s.io (is metrics-server installed?): %w", err)
	}
	var pml podMetricsList
	if err := json.Unmarshal(raw, &pml); err != nil {
		return nil, fmt.Errorf("decode PodMetrics: %w", err)
	}
	out := make(map[string]Usage, len(pml.Items))
	for _, item := range pml.Items {
		for _, c := range item.Containers {
			if c.Name != k.container {
				continue
			}
			cpu, cerr := resource.ParseQuantity(c.Usage.CPU)
			mem, merr := resource.ParseQuantity(c.Usage.Memory)
			if cerr != nil || merr != nil {
				continue
			}
			out[item.Metadata.Name] = Usage{CPUMilli: cpu.MilliValue(), MemBytes: mem.Value()}
		}
	}
	return out, nil
}

// resizePatch renders a strategic-merge patch for ONE resource on the writer
// container (cpu OR memory — never both in one patch; a combined patch is rejected
// with "only cpu and memory resources are mutable", see docs/operations.md).
func (k *K8sClient) resizePatch(resName, reqStr, limStr string) []byte {
	return []byte(fmt.Sprintf(
		`{"spec":{"containers":[{"name":%q,"resources":{"requests":{%q:%q},"limits":{%q:%q}}}]}}`,
		k.container, resName, reqStr, resName, limStr,
	))
}

func (k *K8sClient) ResizeCPU(ctx context.Context, pod string, reqMilli, limMilli int64) error {
	patch := k.resizePatch("cpu",
		resource.NewMilliQuantity(reqMilli, resource.DecimalSI).String(),
		resource.NewMilliQuantity(limMilli, resource.DecimalSI).String())
	_, err := k.cs.CoreV1().Pods(k.namespace).Patch(
		ctx, pod, types.StrategicMergePatchType, patch, metav1.PatchOptions{}, "resize")
	return err
}

func (k *K8sClient) ResizeMem(ctx context.Context, pod string, reqBytes, limBytes int64) error {
	patch := k.resizePatch("memory",
		resource.NewQuantity(reqBytes, resource.BinarySI).String(),
		resource.NewQuantity(limBytes, resource.BinarySI).String())
	_, err := k.cs.CoreV1().Pods(k.namespace).Patch(
		ctx, pod, types.StrategicMergePatchType, patch, metav1.PatchOptions{}, "resize")
	return err
}

// FlagBounce annotates the pod (metadata patch on the base pods resource — NOT the
// resize subresource, NOT a delete). This is the never-bounce-silently escape hatch:
// the operator sees the annotation and schedules a maintenance-window bounce.
func (k *K8sClient) FlagBounce(ctx context.Context, pod, reason string) error {
	// Escape the reason for JSON safety.
	rb, _ := json.Marshal(reason)
	patch := []byte(fmt.Sprintf(`{"metadata":{"annotations":{%q:%s}}}`, bounceAnnotation, string(rb)))
	_, err := k.cs.CoreV1().Pods(k.namespace).Patch(
		ctx, pod, types.MergePatchType, patch, metav1.PatchOptions{})
	return err
}

// SelectorSummary is a human string for startup logs.
func (k *K8sClient) SelectorSummary() string {
	return strings.TrimSpace(k.selector)
}

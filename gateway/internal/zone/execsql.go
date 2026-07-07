package zone

import (
	"bytes"
	"context"
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/remotecommand"
)

// DynSQL implements SQLOps by exec-ing psql inside the target compute pod as
// cloud_admin over pod-local loopback (the #112/#133 admin path — cloud_admin is
// rejected over TCP, so admin SQL must run in-pod). The gateway image is distroless
// and ships no psql; this runs psql inside the COMPUTE pod (neondatabase/compute-node
// has sh + psql), driven via the API-server pods/exec subresource — no local binary.
//
// Every method ensures the target compute is awake first (wake), so the operator can
// apply SQL to a zone that is at rest.
type DynSQL struct {
	cs      kubernetes.Interface
	restCfg *rest.Config
	ns      string
	gwHost  string // apps-gateway host embedded in FDW foreign-server OPTIONS
	gwPort  int
	wake    func(ctx context.Context, zone string) error
}

// NewDynSQL wires a DynSQL. wake scales+waits compute-<zone> ready (Cluster.WakeCompute).
func NewDynSQL(cs kubernetes.Interface, restCfg *rest.Config, ns, gwHost string, gwPort int, wake func(context.Context, string) error) *DynSQL {
	return &DynSQL{cs: cs, restCfg: restCfg, ns: ns, gwHost: gwHost, gwPort: gwPort, wake: wake}
}

// exec runs sql inside compute-<zone> as cloud_admin, ON_ERROR_STOP so any statement
// failure surfaces as a non-nil error (with psql's stderr for diagnosis). It WAKES the
// compute first (admin SQL may target a zone at rest).
func (s *DynSQL) exec(ctx context.Context, zone, sql string) error {
	if err := s.wake(ctx, zone); err != nil {
		return fmt.Errorf("wake compute-%s for SQL: %w", zone, err)
	}
	pod, err := s.readyPod(ctx, zone)
	if err != nil {
		return err
	}
	_, err = s.run(ctx, zone, pod, sql, true)
	return err
}

// readOnly runs a read-only query inside compute-<zone> WITHOUT waking it — used by the
// health poll (SlotInvalidatedOnPeer) so a settled healthy peer is never force-woken
// just to be inspected (the #145 invariant). If the compute is not already awake,
// readyPod returns an error the caller treats as transient (retry).
func (s *DynSQL) readOnly(ctx context.Context, zone, sql string) (string, error) {
	pod, err := s.readyPod(ctx, zone)
	if err != nil {
		return "", err
	}
	return s.run(ctx, zone, pod, sql, false)
}

// run streams sql to psql inside the compute pod and returns stdout. tupleOnly formats
// as -tA (bare values) for machine-readable reads.
func (s *DynSQL) run(ctx context.Context, zone, pod, sql string, tupleOnly bool) (string, error) {
	psql := "PGPASSWORD=cloud_admin psql -h localhost -p 55433 -U cloud_admin -d postgres -v ON_ERROR_STOP=1"
	if tupleOnly {
		psql += " -tA"
	}
	cmd := []string{"/bin/sh", "-c", psql}
	req := s.cs.CoreV1().RESTClient().Post().
		Resource("pods").Name(pod).Namespace(s.ns).SubResource("exec").
		VersionedParams(&corev1.PodExecOptions{
			Container: "compute", Command: cmd,
			Stdin: true, Stdout: true, Stderr: true, TTY: false,
		}, scheme.ParameterCodec)
	exe, err := remotecommand.NewSPDYExecutor(s.restCfg, "POST", req.URL())
	if err != nil {
		return "", fmt.Errorf("build exec for compute-%s: %w", zone, err)
	}
	var stdout, stderr bytes.Buffer
	err = exe.StreamWithContext(ctx, remotecommand.StreamOptions{
		Stdin: strings.NewReader(sql), Stdout: &stdout, Stderr: &stderr,
	})
	if err != nil {
		return "", fmt.Errorf("psql on compute-%s failed: %w; stderr: %s", zone, err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}

// readyPod returns the name of a Running+Ready compute-<zone> pod.
func (s *DynSQL) readyPod(ctx context.Context, zone string) (string, error) {
	pods, err := s.cs.CoreV1().Pods(s.ns).List(ctx, metav1.ListOptions{LabelSelector: "app=compute-" + zone})
	if err != nil {
		return "", fmt.Errorf("list compute-%s pods: %w", zone, err)
	}
	for i := range pods.Items {
		p := &pods.Items[i]
		if p.Status.Phase != corev1.PodRunning || p.DeletionTimestamp != nil {
			continue
		}
		for _, c := range p.Status.ContainerStatuses {
			if c.Name == "compute" && c.Ready {
				return p.Name, nil
			}
		}
	}
	return "", fmt.Errorf("no ready compute-%s pod (compute not awake?)", zone)
}

func (s *DynSQL) EnsureReplRole(ctx context.Context, zone, role, md5hex string) error {
	return s.exec(ctx, zone, buildEnsureReplRole(role, md5hex))
}

func (s *DynSQL) EnsurePublication(ctx context.Context, zone, pub, replRole string, tables []string) error {
	sql, err := buildEnsurePublication(pub, replRole, tables)
	if err != nil {
		return err
	}
	return s.exec(ctx, zone, sql)
}

func (s *DynSQL) DropPublication(ctx context.Context, zone, pub string) error {
	return s.exec(ctx, zone, buildDropPublication(pub))
}

func (s *DynSQL) EnsureSubscription(ctx context.Context, zone, sub, conn string, publications []string) error {
	sql, err := buildEnsureSubscription(sub, conn, publications)
	if err != nil {
		return err
	}
	return s.exec(ctx, zone, sql)
}

func (s *DynSQL) DropSubscription(ctx context.Context, zone, sub string) error {
	return s.exec(ctx, zone, buildDropSubscription(sub))
}

func (s *DynSQL) DropReplicationSlot(ctx context.Context, peerZone, slot string) error {
	return s.exec(ctx, peerZone, buildDropReplicationSlot(slot))
}

// SlotInvalidatedOnPeer reads the peer slot's wal_status WITHOUT waking the peer (the
// caller gates on ComputeAwake). An empty result (slot absent) is treated as
// not-invalid — it may have already been reclaimed; the subscription reconcile handles
// a genuinely missing slot separately.
func (s *DynSQL) SlotInvalidatedOnPeer(ctx context.Context, peerZone, slot string) (bool, error) {
	out, err := s.readOnly(ctx, peerZone, buildSlotStatusQuery(slot))
	if err != nil {
		return false, err
	}
	return slotStatusInvalid(out), nil
}

// ResyncSubscription DROPs + re-CREATEs the subscription WITH copy_data on THIS zone's
// compute (waking it), re-snapshotting the peer publication after an invalidated slot.
func (s *DynSQL) ResyncSubscription(ctx context.Context, zone, sub, conn string, publications []string) error {
	sql, err := buildResyncSubscription(sub, conn, publications)
	if err != nil {
		return err
	}
	return s.exec(ctx, zone, sql)
}

func (s *DynSQL) EnsureFederation(ctx context.Context, zone, fromZone, _ string, replRole, password string, tables []string) error {
	// The FDW foreign server embeds the operator's gateway coordinates (host/port) +
	// the peer zone as dbname, so cross-zone reads also route through the gateway
	// wake-on-connect path. The conn param (subscription-shaped) is unused here.
	sql, err := buildEnsureFederation(fromZone, s.gwHost, s.gwPort, replRole, password, tables)
	if err != nil {
		return err
	}
	return s.exec(ctx, zone, sql)
}

func (s *DynSQL) DropFederation(ctx context.Context, zone, fromZone string) error {
	return s.exec(ctx, zone, buildDropFederation(fromZone))
}

var _ SQLOps = (*DynSQL)(nil)

//go:build e2e

// Package e2e calls the function deployed on a kind cluster with Knative, the
// way its zone does: through the cluster-local gateway, over h2c, by the
// function's cluster-local host name. kind-e2e.sh deploys it and runs this
// with -tags e2e; it is never part of `go test ./...`.
package e2e

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"os"
	"testing"

	"connectrpc.com/connect/v2"
	"connectrpc.com/connect/v2/connecthttp"
	"connectrpc.com/grpchealth/v2"

	examplev1 "example.com/function/gen/example/v1"
	"example.com/function/gen/example/v1/examplev1connect"
)

func env(t *testing.T, name string) string {
	t.Helper()
	v := os.Getenv(name)
	if v == "" {
		t.Fatalf("%s is not set; run this through kind-e2e.sh", name)
	}
	return v
}

// hostRoundTripper sends every request to the gateway with the function's
// cluster-local host name, which is what Knative routes on.
type hostRoundTripper struct {
	host string
	next http.RoundTripper
}

func (h hostRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	req = req.Clone(req.Context())
	req.Host = h.host
	return h.next.RoundTrip(req)
}

func h2c(host string) *http.Client {
	p := new(http.Protocols)
	p.SetUnencryptedHTTP2(true)
	return &http.Client{Transport: hostRoundTripper{host: host, next: &http.Transport{Protocols: p}}}
}

type protocol struct {
	name string
	opts []connecthttp.Option
}

var protocols = []protocol{
	{"connect", nil},
	{"connect GET", []connecthttp.Option{connecthttp.WithHTTPGet()}},
	{"grpc", []connecthttp.Option{connecthttp.WithGRPC()}},
}

func clients(t *testing.T, p protocol) (examplev1connect.ExampleServiceClient, *grpchealth.Client) {
	t.Helper()
	client := connect.NewClient(connecthttp.NewTransport(
		h2c(env(t, "KNEXT_E2E_HOST")), env(t, "KNEXT_E2E_INTERNAL_URL"), p.opts...))
	return examplev1connect.NewExampleServiceClient(client), grpchealth.NewClient(client)
}

func TestHealthCheckIsServedWithoutAToken(t *testing.T) {
	for _, p := range protocols {
		_, health := clients(t, p)
		res, err := health.Check(t.Context(), &grpchealth.CheckRequest{})
		if err != nil || res.Status != grpchealth.StatusServing {
			t.Fatalf("%s: health Check = %v, %v; want SERVING", p.name, res, err)
		}
		t.Logf("%s: health Check SERVING", p.name)
	}
}

func TestEveryOtherRPCIsRefused(t *testing.T) {
	for _, p := range protocols {
		example, _ := clients(t, p)
		for _, authorization := range []string{"", "Bearer forged.jwt.token"} {
			ctx, info := connect.NewClientContext(t.Context())
			if authorization != "" {
				info.RequestHeader().Set("Authorization", authorization)
			}
			_, err := example.GetItem(ctx, &examplev1.GetItemRequest{Id: "a"})
			want(t, p.name+" GetItem (Authorization "+authorization+")", err)
			_, err = example.PutItem(ctx, &examplev1.PutItemRequest{Id: "a", Value: "b"})
			want(t, p.name+" PutItem (Authorization "+authorization+")", err)
		}
		t.Logf("%s: GetItem and PutItem refused with Unauthenticated", p.name)
	}
}

func want(t *testing.T, what string, err error) {
	t.Helper()
	if err == nil || connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("%s: err = %v (code %v); want unauthenticated", what, err, connect.CodeOf(err))
	}
}

// The gRPC status of a refusal survives Kourier, the activator and the
// queue-proxy: a raw gRPC request gets grpc-status 16 over HTTP/2.
func TestRawGRPCStatusSurvivesTheGateway(t *testing.T) {
	url := env(t, "KNEXT_E2E_INTERNAL_URL") + examplev1connect.ExampleServicePutItemProcedure
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, url, bytes.NewReader([]byte{0, 0, 0, 0, 0}))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/grpc+proto")
	req.Header.Set("Te", "trailers")
	resp, err := h2c(env(t, "KNEXT_E2E_HOST")).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if _, err := io.Copy(io.Discard, resp.Body); err != nil {
		t.Fatal(err)
	}
	status := resp.Trailer.Get("Grpc-Status")
	if status == "" {
		status = resp.Header.Get("Grpc-Status")
	}
	if resp.ProtoMajor != 2 || resp.StatusCode != http.StatusOK || status != "16" {
		t.Fatalf("raw gRPC PutItem: HTTP/%d %d grpc-status %q; want HTTP/2 200 grpc-status 16", resp.ProtoMajor, resp.StatusCode, status)
	}
	t.Logf("raw gRPC PutItem: HTTP/2 200 grpc-status 16")
}

// The function has no public route: the public gateway does not serve it,
// by its cluster-local name or by the name a public route would have.
func TestNoPublicRoute(t *testing.T) {
	public := env(t, "KNEXT_E2E_PUBLIC_URL")
	for _, host := range []string{env(t, "KNEXT_E2E_HOST"), env(t, "KNEXT_E2E_PUBLIC_HOST")} {
		req, err := http.NewRequestWithContext(context.Background(), http.MethodPost,
			public+"/grpc.health.v1.Health/Check", bytes.NewReader([]byte("{}")))
		if err != nil {
			t.Fatal(err)
		}
		req.Host = host
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("public gateway, Host %s: HTTP %d; want 404 (no public route)", host, resp.StatusCode)
		}
		t.Logf("public gateway, Host %s: 404", host)
	}
}

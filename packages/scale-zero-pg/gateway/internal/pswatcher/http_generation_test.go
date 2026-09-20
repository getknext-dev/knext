package pswatcher

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// #1100 review (FIX 2) — the generation vantage must NOT conflate "the pageserver
// does not hold this tenant" (404 → genuinely absent) with "the pageserver answered
// but the generation is unreadable" (200 without a `generation` field). Every caller
// treats ok=false as ABSENT: converge skips it, the ledger heal declines to seed, and
// skippable() would read an unverifiable answer as a corroborated absence. "We could
// not check" is never "it does not exist", so the unreadable case must surface as an
// ERROR (ErrGenerationUnreadable) and only a 404 may report absent.
func TestGenerationViewerDistinguishesAbsentFromUnreadable(t *testing.T) {
	cases := []struct {
		name     string
		status   int
		body     string
		wantGen  int
		wantOK   bool
		wantErr  bool
		unreadbl bool
	}{
		{name: "attached tenant reports its generation", status: 200, body: `{"id":"f0f0","generation":7}`, wantGen: 7, wantOK: true},
		{name: "404 is genuinely absent", status: 404, body: `{"msg":"NotFound"}`},
		{name: "200 without a generation field is UNREADABLE, not absent", status: 200, body: `{"id":"f0f0","state":{"slug":"Active"}}`, wantErr: true, unreadbl: true},
		{name: "5xx is an error", status: 503, body: `nope`, wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer srv.Close()

			v := NewHTTPGenerationViewer(srv.URL, 5*time.Second)
			gen, ok, err := v.Generation(context.Background(), "f0f0")
			if tc.wantErr {
				if err == nil {
					t.Fatalf("want an error (the caller must not read this as ABSENT), got gen=%d ok=%v", gen, ok)
				}
				if ok {
					t.Fatal("an errored read must never report ok=true")
				}
				if tc.unreadbl && !errors.Is(err, ErrGenerationUnreadable) {
					t.Fatalf("a 200 with no generation field must wrap ErrGenerationUnreadable, got %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if ok != tc.wantOK || gen != tc.wantGen {
				t.Fatalf("Generation = (%d, %v), want (%d, %v)", gen, ok, tc.wantGen, tc.wantOK)
			}
		})
	}
}

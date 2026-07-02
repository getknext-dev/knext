package main

import (
	"bytes"
	"log"
	"net/http/httptest"
	"strings"
	"testing"
)

// The sink must LOG the request body (the drill greps for alertnames in it)
// and answer 200 — the busybox nc predecessor returned a canned 200 while
// discarding payloads, making alert content unverifiable (devops-r3 CRITICAL).
func TestSinkLogsBodyAndAnswers200(t *testing.T) {
	var buf bytes.Buffer
	logger := log.New(&buf, "", 0)
	h := handler(logger)

	body := `{"alerts":[{"labels":{"alertname":"KsPgAlertDrill"}}]}`
	req := httptest.NewRequest("POST", "/", strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if !strings.Contains(buf.String(), "KsPgAlertDrill") {
		t.Fatalf("body not logged: %q", buf.String())
	}
}

func TestSinkHealthz(t *testing.T) {
	h := handler(log.New(&bytes.Buffer{}, "", 0))
	req := httptest.NewRequest("GET", "/healthz", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("healthz = %d, want 200", rec.Code)
	}
}

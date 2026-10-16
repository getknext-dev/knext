package main

import "testing"

func TestListenAddr(t *testing.T) {
	for port, want := range map[string]string{"": ":8080", "9000": ":9000"} {
		if got := listenAddr(func(string) string { return port }); got != want {
			t.Errorf("PORT=%q: listenAddr = %q; want %q", port, got, want)
		}
	}
}

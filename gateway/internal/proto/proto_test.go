package proto

import (
	"bytes"
	"encoding/binary"
	"reflect"
	"strings"
	"testing"
)

func TestSSLRequestClassifiedAnd8Bytes(t *testing.T) {
	b := BuildSSLRequest()
	if len(b) != 8 {
		t.Fatalf("SSLRequest length = %d, want 8", len(b))
	}
	packet, _, ok, err := ReadInitialPacket(b)
	if err != nil || !ok {
		t.Fatalf("ReadInitialPacket ok=%v err=%v", ok, err)
	}
	msg, err := ParseInitialPacket(packet)
	if err != nil {
		t.Fatalf("ParseInitialPacket err=%v", err)
	}
	if msg.Type != TypeSSL {
		t.Fatalf("type = %q, want %q", msg.Type, TypeSSL)
	}
}

func TestStartupMessageRoundtrips(t *testing.T) {
	in := map[string]string{"user": "app", "database": "orders", "application_name": "knext"}
	b := BuildStartup(in)
	packet, _, ok, err := ReadInitialPacket(b)
	if err != nil || !ok {
		t.Fatalf("ReadInitialPacket ok=%v err=%v", ok, err)
	}
	msg, err := ParseInitialPacket(packet)
	if err != nil {
		t.Fatalf("ParseInitialPacket err=%v", err)
	}
	if msg.Type != TypeStartup {
		t.Fatalf("type = %q, want %q", msg.Type, TypeStartup)
	}
	if !reflect.DeepEqual(msg.Params, in) {
		t.Fatalf("params = %v, want %v", msg.Params, in)
	}
}

func TestPartialPacketReturnsNotOK(t *testing.T) {
	b := BuildStartup(map[string]string{"user": "u", "database": "d"})
	if _, _, ok, err := ReadInitialPacket(b[:3]); ok || err != nil {
		t.Fatalf("3-byte buf: ok=%v err=%v, want not-ok/no-err", ok, err)
	}
	if _, _, ok, err := ReadInitialPacket(b[:len(b)-1]); ok || err != nil {
		t.Fatalf("short buf: ok=%v err=%v, want not-ok/no-err", ok, err)
	}
	if _, _, ok, err := ReadInitialPacket(b); !ok || err != nil {
		t.Fatalf("full buf: ok=%v err=%v, want ok/no-err", ok, err)
	}
}

func TestTrailingBytesPreservedInRest(t *testing.T) {
	b := BuildStartup(map[string]string{"user": "u", "database": "d"})
	buf := append(append([]byte{}, b...), []byte("XX")...)
	_, rest, ok, err := ReadInitialPacket(buf)
	if err != nil || !ok {
		t.Fatalf("ReadInitialPacket ok=%v err=%v", ok, err)
	}
	if string(rest) != "XX" {
		t.Fatalf("rest = %q, want %q", string(rest), "XX")
	}
}

func TestBogusLengthRejected(t *testing.T) {
	evil := make([]byte, 8)
	binary.BigEndian.PutUint32(evil[0:4], 999999)
	if _, _, _, err := ReadInitialPacket(evil); err == nil || !strings.Contains(err.Error(), "bogus") {
		t.Fatalf("err = %v, want bogus", err)
	}
}

func TestUnsupportedProtocolRejected(t *testing.T) {
	b := make([]byte, 9)
	binary.BigEndian.PutUint32(b[0:4], 9)
	binary.BigEndian.PutUint32(b[4:8], 131072) // protocol 2.0
	_, err := ParseInitialPacket(b)
	if err == nil || !strings.Contains(err.Error(), "unsupported protocol 2.0") {
		t.Fatalf("err = %v, want unsupported protocol 2.0", err)
	}
}

func TestCancelRequestClassified(t *testing.T) {
	b := make([]byte, 16)
	binary.BigEndian.PutUint32(b[0:4], 16)
	binary.BigEndian.PutUint32(b[4:8], CancelRequestCode)
	msg, err := ParseInitialPacket(b)
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if msg.Type != TypeCancel {
		t.Fatalf("type = %q, want %q", msg.Type, TypeCancel)
	}
}

func TestErrorResponseWellFormed(t *testing.T) {
	e := BuildErrorResponse("57P03", "compute unavailable")
	if e[0] != 'E' {
		t.Fatalf("first byte = %q, want E", e[0])
	}
	if int(binary.BigEndian.Uint32(e[1:5])) != len(e)-1 {
		t.Fatalf("length field = %d, want %d", binary.BigEndian.Uint32(e[1:5]), len(e)-1)
	}
	if !bytes.Contains(e, []byte("57P03")) {
		t.Fatalf("missing code")
	}
	if !bytes.Contains(e, []byte("compute unavailable")) {
		t.Fatalf("missing message")
	}
}

// TestIsReplication is the replication-startup detection matrix for
// gateway-mediated replication-wake (ADR-0007 §4c). "database" (logical) and the
// boolean-true forms are replication; false forms, empty, and absent are ordinary.
func TestIsReplication(t *testing.T) {
	cases := []struct {
		name   string
		params map[string]string
		want   bool
	}{
		{"absent -> ordinary", map[string]string{"user": "u", "database": "d"}, false},
		{"empty value -> ordinary", map[string]string{"replication": ""}, false},
		{"database (logical)", map[string]string{"replication": "database"}, true},
		{"DATABASE upper (logical)", map[string]string{"replication": "DATABASE"}, true},
		{"padded database", map[string]string{"replication": " database "}, true},
		{"true (physical)", map[string]string{"replication": "true"}, true},
		{"True mixed-case", map[string]string{"replication": "True"}, true},
		{"on", map[string]string{"replication": "on"}, true},
		{"yes", map[string]string{"replication": "yes"}, true},
		{"1", map[string]string{"replication": "1"}, true},
		{"false -> ordinary", map[string]string{"replication": "false"}, false},
		{"off -> ordinary", map[string]string{"replication": "off"}, false},
		{"no -> ordinary", map[string]string{"replication": "no"}, false},
		{"0 -> ordinary", map[string]string{"replication": "0"}, false},
		{"garbage -> ordinary", map[string]string{"replication": "banana"}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := IsReplication(c.params); got != c.want {
				t.Fatalf("IsReplication(%v) = %v, want %v", c.params, got, c.want)
			}
		})
	}
}

// A replication StartupMessage must round-trip through parse -> IsReplication:
// the replication param survives BuildStartup/ParseInitialPacket, and the
// database (wake target) is still readable so the gateway can route it.
func TestReplicationStartupRoundTrip(t *testing.T) {
	pkt := BuildStartup(map[string]string{"user": "repl_zone-eu", "database": "zone-eu", "replication": "database"})
	msg, err := ParseInitialPacket(pkt)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if msg.Type != TypeStartup {
		t.Fatalf("type = %q, want startup", msg.Type)
	}
	if !IsReplication(msg.Params) {
		t.Fatalf("replication param lost through round-trip: %v", msg.Params)
	}
	if msg.Params["database"] != "zone-eu" {
		t.Fatalf("database = %q, want zone-eu (wake target)", msg.Params["database"])
	}
}

// Package proto implements just enough of the Postgres wire protocol to route:
// initial-packet framing, SSL/GSS negotiation codes, StartupMessage params, and
// ErrorResponse building. The gateway never speaks the query protocol; after
// startup it pipes bytes.
package proto

import (
	"bytes"
	"encoding/binary"
	"fmt"
)

// Wire-protocol magic numbers.
const (
	SSLRequestCode    uint32 = 80877103
	GSSEncRequestCode uint32 = 80877104
	CancelRequestCode uint32 = 80877102
	Protocol30        uint32 = 196608 // 3 << 16
)

// Message types produced by ParseInitialPacket.
const (
	TypeSSL     = "ssl"
	TypeGSSEnc  = "gssenc"
	TypeCancel  = "cancel"
	TypeStartup = "startup"
)

// Msg is a classified initial packet.
type Msg struct {
	Type   string
	Params map[string]string
	Raw    []byte
}

// ReadInitialPacket frames a buffer as: int32 length (includes itself) + payload.
// It returns ok=false (with no error) when buf does not yet hold a complete
// packet, and an error for a bogus length. On success it returns the complete
// packet and any trailing bytes (rest) that followed it.
func ReadInitialPacket(buf []byte) (packet, rest []byte, ok bool, err error) {
	if len(buf) < 4 {
		return nil, nil, false, nil
	}
	length := int(binary.BigEndian.Uint32(buf[0:4]))
	if length < 8 || length > 10000 {
		return nil, nil, false, fmt.Errorf("bogus initial packet length %d", length)
	}
	if len(buf) < length {
		return nil, nil, false, nil
	}
	return buf[:length], buf[length:], true, nil
}

// ParseInitialPacket classifies and parses a complete initial packet.
func ParseInitialPacket(packet []byte) (Msg, error) {
	if len(packet) < 8 {
		return Msg{}, fmt.Errorf("initial packet too short: %d bytes", len(packet))
	}
	code := binary.BigEndian.Uint32(packet[4:8])
	switch code {
	case SSLRequestCode:
		return Msg{Type: TypeSSL, Raw: packet}, nil
	case GSSEncRequestCode:
		return Msg{Type: TypeGSSEnc, Raw: packet}, nil
	case CancelRequestCode:
		return Msg{Type: TypeCancel, Raw: packet}, nil
	}
	if code != Protocol30 {
		return Msg{}, fmt.Errorf("unsupported protocol %d.%d", code>>16, code&0xffff)
	}
	params := map[string]string{}
	off := 8
	for off < len(packet)-1 {
		kRel := bytes.IndexByte(packet[off:], 0)
		if kRel == -1 || kRel == 0 { // no key, or empty key = terminator
			break
		}
		kEnd := off + kRel
		vRel := bytes.IndexByte(packet[kEnd+1:], 0)
		if vRel == -1 {
			return Msg{}, fmt.Errorf("unterminated startup parameter")
		}
		vEnd := kEnd + 1 + vRel
		params[string(packet[off:kEnd])] = string(packet[kEnd+1 : vEnd])
		off = vEnd + 1
	}
	return Msg{Type: TypeStartup, Params: params, Raw: packet}, nil
}

// BuildStartup builds a StartupMessage from params (for tests and health probes).
func BuildStartup(params map[string]string) []byte {
	var body bytes.Buffer
	for k, v := range params {
		body.WriteString(k)
		body.WriteByte(0)
		body.WriteString(v)
		body.WriteByte(0)
	}
	body.WriteByte(0)
	out := make([]byte, 8+body.Len())
	binary.BigEndian.PutUint32(out[0:4], uint32(8+body.Len()))
	binary.BigEndian.PutUint32(out[4:8], Protocol30)
	copy(out[8:], body.Bytes())
	return out
}

// BuildSSLRequest builds an 8-byte SSLRequest packet.
func BuildSSLRequest() []byte {
	b := make([]byte, 8)
	binary.BigEndian.PutUint32(b[0:4], 8)
	binary.BigEndian.PutUint32(b[4:8], SSLRequestCode)
	return b
}

// BuildErrorResponse builds an ErrorResponse the client understands, so failures
// are visible in psql instead of a bare connection reset.
func BuildErrorResponse(code, message string) []byte {
	var body bytes.Buffer
	fields := [][2]string{{"S", "FATAL"}, {"V", "FATAL"}, {"C", code}, {"M", message}}
	for _, f := range fields {
		body.WriteString(f[0])
		body.WriteString(f[1])
		body.WriteByte(0)
	}
	body.WriteByte(0)
	out := make([]byte, 5+body.Len())
	out[0] = 'E'
	binary.BigEndian.PutUint32(out[1:5], uint32(4+body.Len()))
	copy(out[5:], body.Bytes())
	return out
}

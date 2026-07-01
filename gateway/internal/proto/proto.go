// Package proto implements just enough of the Postgres wire protocol to route.
// STUB — red.
package proto

const (
	SSLRequestCode    uint32 = 80877103
	GSSEncRequestCode uint32 = 80877104
	CancelRequestCode uint32 = 80877102
	Protocol30        uint32 = 196608 // 3 << 16
)

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

// ReadInitialPacket frames a buffer. STUB.
func ReadInitialPacket(buf []byte) (packet, rest []byte, ok bool, err error) {
	return nil, nil, false, nil
}

// ParseInitialPacket classifies a complete initial packet. STUB.
func ParseInitialPacket(packet []byte) (Msg, error) {
	return Msg{}, nil
}

// BuildStartup builds a StartupMessage. STUB.
func BuildStartup(params map[string]string) []byte { return nil }

// BuildSSLRequest builds an 8-byte SSLRequest packet. STUB.
func BuildSSLRequest() []byte { return nil }

// BuildErrorResponse builds an ErrorResponse. STUB.
func BuildErrorResponse(code, message string) []byte { return nil }

'use strict';
// Postgres wire protocol — just enough to route: initial-packet framing,
// SSL/GSS negotiation codes, StartupMessage params, ErrorResponse building.
// The gateway never speaks the query protocol; after startup it pipes bytes.

const SSL_REQUEST_CODE = 80877103;
const GSSENC_REQUEST_CODE = 80877104;
const CANCEL_REQUEST_CODE = 80877102;
const PROTOCOL_3_0 = 196608; // 3 << 16

// Initial packets are framed as: int32 length (includes itself) + payload.
// Returns null if buf doesn't yet hold a complete packet.
function readInitialPacket(buf) {
  if (buf.length < 4) return null;
  const len = buf.readInt32BE(0);
  if (len < 8 || len > 10000) throw new Error(`bogus initial packet length ${len}`);
  if (buf.length < len) return null;
  return { len, packet: buf.subarray(0, len), rest: buf.subarray(len) };
}

// Classify + parse a complete initial packet.
// -> { type: 'ssl'|'gssenc'|'cancel'|'startup', params?, raw }
function parseInitialPacket(packet) {
  const code = packet.readInt32BE(4);
  if (code === SSL_REQUEST_CODE) return { type: 'ssl', raw: packet };
  if (code === GSSENC_REQUEST_CODE) return { type: 'gssenc', raw: packet };
  if (code === CANCEL_REQUEST_CODE) return { type: 'cancel', raw: packet };
  if (code !== PROTOCOL_3_0) throw new Error(`unsupported protocol ${code >> 16}.${code & 0xffff}`);
  const params = {};
  let off = 8;
  while (off < packet.length - 1) {
    const kEnd = packet.indexOf(0, off);
    if (kEnd === -1 || kEnd === off) break; // empty key = terminator
    const vEnd = packet.indexOf(0, kEnd + 1);
    if (vEnd === -1) throw new Error('unterminated startup parameter');
    params[packet.toString('utf8', off, kEnd)] = packet.toString('utf8', kEnd + 1, vEnd);
    off = vEnd + 1;
  }
  return { type: 'startup', params, raw: packet };
}

// Build a StartupMessage from params (for tests and health probes).
function buildStartup(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    parts.push(Buffer.from(k, 'utf8'), Buffer.from([0]), Buffer.from(v, 'utf8'), Buffer.from([0]));
  }
  parts.push(Buffer.from([0]));
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeInt32BE(8 + body.length, 0);
  head.writeInt32BE(PROTOCOL_3_0, 4);
  return Buffer.concat([head, body]);
}

function buildSslRequest() {
  const b = Buffer.alloc(8);
  b.writeInt32BE(8, 0);
  b.writeInt32BE(SSL_REQUEST_CODE, 4);
  return b;
}

// ErrorResponse the client understands, so failures are visible in psql
// instead of a bare connection reset.
function buildErrorResponse(code, message) {
  const fields = [
    ['S', 'FATAL'], ['V', 'FATAL'], ['C', code], ['M', message],
  ];
  const parts = [];
  for (const [t, v] of fields) {
    parts.push(Buffer.from(t, 'utf8'), Buffer.from(v, 'utf8'), Buffer.from([0]));
  }
  parts.push(Buffer.from([0]));
  const body = Buffer.concat(parts);
  const msg = Buffer.alloc(5 + body.length);
  msg.write('E', 0);
  msg.writeInt32BE(4 + body.length, 1);
  body.copy(msg, 5);
  return msg;
}

module.exports = {
  SSL_REQUEST_CODE, GSSENC_REQUEST_CODE, CANCEL_REQUEST_CODE, PROTOCOL_3_0,
  readInitialPacket, parseInitialPacket, buildStartup, buildSslRequest, buildErrorResponse,
};

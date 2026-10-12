import { createServer, type Server, type Socket } from 'node:net';

/**
 * A just-enough Postgres wire-protocol server for the `pg` driver: trust auth,
 * then every simple query is answered either with a one-row result or with a
 * server-side ErrorResponse carrying a chosen SQLSTATE. Real bytes on a real
 * socket, so what the pool sees is exactly what a database would send.
 */

export type FakeAnswer = { kind: 'row' } | { kind: 'error'; sqlstate: string; message: string };

const be = (type: string, body: Buffer): Buffer => {
  const head = Buffer.alloc(5);
  head.write(type, 0, 'latin1');
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
};

const cstr = (s: string): Buffer => Buffer.from(`${s}\0`, 'utf8');
const int16 = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n);
  return b;
};
const int32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};

const readyForQuery = (): Buffer => be('Z', Buffer.from('I'));

function answer(a: FakeAnswer): Buffer {
  if (a.kind === 'error') {
    const fields = Buffer.concat([
      Buffer.from('S'),
      cstr('ERROR'),
      Buffer.from('V'),
      cstr('ERROR'),
      Buffer.from('C'),
      cstr(a.sqlstate),
      Buffer.from('M'),
      cstr(a.message),
      Buffer.from('\0'),
    ]);
    return Buffer.concat([be('E', fields), readyForQuery()]);
  }
  const rowDescription = be(
    'T',
    Buffer.concat([
      int16(1),
      cstr('healthy'),
      int32(0),
      int16(0),
      int32(23),
      int16(4),
      int32(-1),
      int16(0),
    ]),
  );
  const dataRow = be('D', Buffer.concat([int16(1), int32(1), Buffer.from('1')]));
  return Buffer.concat([rowDescription, dataRow, be('C', cstr('SELECT 1')), readyForQuery()]);
}

function serve(socket: Socket, a: FakeAnswer): void {
  let buffer = Buffer.alloc(0);
  let started = false;
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (!started) {
        if (buffer.length < 8) return;
        const length = buffer.readInt32BE(0);
        if (buffer.length < length) return;
        const code = buffer.readInt32BE(4);
        buffer = buffer.subarray(length);
        if (code === 80877103) {
          socket.write('N'); // no TLS
          continue;
        }
        started = true;
        socket.write(
          Buffer.concat([
            be('R', int32(0)),
            be('S', Buffer.concat([cstr('server_version'), cstr('16.0')])),
            be('K', Buffer.concat([int32(1), int32(2)])),
            readyForQuery(),
          ]),
        );
        continue;
      }
      if (buffer.length < 5) return;
      const type = String.fromCharCode(buffer[0] as number);
      const length = buffer.readInt32BE(1);
      if (buffer.length < length + 1) return;
      buffer = buffer.subarray(length + 1);
      if (type === 'X') {
        socket.end();
        return;
      }
      if (type === 'Q') socket.write(answer(a));
    }
  });
}

/** Listen on `port` (0 = ephemeral). Resolves with the server and its port. */
export async function startFakePostgres(
  port: number,
  a: FakeAnswer = { kind: 'row' },
): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    serve(socket, a);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const bound = (server.address() as { port: number }).port;
  return {
    server,
    port: bound,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A TCP port nothing is listening on: bind an ephemeral one, then release it. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

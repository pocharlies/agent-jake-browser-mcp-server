import { WebSocket } from 'ws';
import { CATALOG_VERSION } from '@agent-jake-browser/protocol';

export const TOKEN = 'harness-test-token';

export const helloFrame = (over: Record<string, unknown> = {}) => ({
  type: 'hello',
  supportedProtocolVersions: [1],
  protocolPackageVersion: '0.1.0',
  catalogVersion: CATALOG_VERSION,
  clientVersion: '2.4.0',
  installationId: 'inst-A',
  profileEpoch: 'epoch-1',
  platform: 'linux',
  capabilities: [],
  ...over,
});

export interface TestClient {
  ws: WebSocket;
  frames: any[];
  closed: Promise<{ code: number; reason: string }>;
  next(timeoutMs?: number): Promise<any>;
  send(frame: unknown): void;
  close(): void;
}

export function connect(port: number, opts: { token?: string | null; path?: string; deflate?: boolean } = {}): Promise<TestClient> {
  const token = opts.token === undefined ? TOKEN : opts.token;
  const url = `ws://127.0.0.1:${port}${opts.path ?? '/ws/harness'}${token ? `?token=${token}` : ''}`;
  const ws = new WebSocket(url, { perMessageDeflate: opts.deflate ?? false });
  const frames: any[] = [];
  const waiters: Array<(f: any) => void> = [];
  ws.on('message', (data) => {
    const f = JSON.parse(data.toString());
    const w = waiters.shift();
    if (w) w(f);
    else frames.push(f);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })),
  );
  const client: TestClient = {
    ws,
    frames,
    closed,
    next: (timeoutMs = 3000) =>
      new Promise((resolve, reject) => {
        if (frames.length) return resolve(frames.shift());
        const t = setTimeout(() => reject(new Error('timeout waiting for frame')), timeoutMs);
        waiters.push((f) => {
          clearTimeout(t);
          resolve(f);
        });
      }),
    send: (frame) => ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame)),
    close: () => ws.close(),
  };
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(client));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
  });
}

/** Connect, say hello, wait for the ack. */
export async function ready(port: number, hello: Record<string, unknown> = {}, opts: Parameters<typeof connect>[1] = {}) {
  const c = await connect(port, opts);
  c.send(helloFrame(hello));
  const ack = await c.next();
  if (ack.type !== 'hello_ack') throw new Error(`expected hello_ack, got ${JSON.stringify(ack)}`);
  return { client: c, ack };
}

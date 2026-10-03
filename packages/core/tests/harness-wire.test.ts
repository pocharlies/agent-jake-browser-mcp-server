import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CATALOG_VERSION, MAX_MESSAGE_BYTES } from '@agent-jake-browser/protocol';
import { createHarnessServer, type HarnessServer } from '../src/harness-server.js';
import { TOKEN, connect, helloFrame, ready, type TestClient } from './harness-helpers.js';

const matrix = JSON.parse(readFileSync(new URL('./fixtures/harness/version-matrix.json', import.meta.url), 'utf8'));
let harness: HarnessServer;
let port: number;
const open: TestClient[] = [];
const track = <T extends TestClient>(c: T) => (open.push(c), c);
const prevToken = process.env.BROWSER_WS_TOKEN;

beforeAll(async () => {
  process.env.BROWSER_WS_TOKEN = TOKEN;
  harness = createHarnessServer({ port: 0, helloTimeoutMs: 200 });
  await harness.listening;
  port = harness.port();
});
afterAll(async () => {
  await harness.close();
  if (prevToken === undefined) delete process.env.BROWSER_WS_TOKEN;
  else process.env.BROWSER_WS_TOKEN = prevToken;
});
afterEach(() => {
  for (const c of open.splice(0)) c.close();
});

describe('version matrix (fixed fixture) — incompatible pairs are rejected explicitly', () => {
  for (const row of matrix.cases) {
    it(row.name, async () => {
      const c = track(await connect(port));
      c.send(helloFrame({
        supportedProtocolVersions: row.client,
        catalogVersion: row.catalog === 'stale' ? `sha256:${'0'.repeat(64)}` : CATALOG_VERSION,
      }));
      const reply = await c.next();
      if (row.expect === 'ack') {
        expect(reply.type).toBe('hello_ack');
        expect(reply.protocolVersion).toBe(row.protocolVersion);
        expect(harness.broker.list().length).toBeGreaterThan(0);
      } else {
        expect(reply.type).toBe('hello_reject');
        expect(reply.error.code).toBe(row.code);
        expect(reply.supportedProtocolVersions).toEqual(matrix.serverWireVersions);
        expect((await c.closed).code).toBe(row.close);
      }
    });
  }
  it('a rejected client is never registered and can receive no tool', async () => {
    const before = harness.broker.list().length;
    const c = track(await connect(port));
    c.send(helloFrame({ supportedProtocolVersions: [9] }));
    await c.closed;
    expect(harness.broker.list().length).toBe(before);
  });
});

describe('handshake state machine', () => {
  it('no hello => 4408 hello_timeout', async () => {
    const c = track(await connect(port));
    const reject = await c.next();
    expect(reject.error.code).toBe('hello_timeout');
    expect((await c.closed).code).toBe(4408);
  });
  it('legacy frame first => 4400 hello_required, nothing registered', async () => {
    const before = harness.broker.list().length;
    const c = track(await connect(port));
    c.send({ id: 'x', success: true, result: {} });
    expect((await c.next()).error.code).toBe('hello_required');
    expect((await c.closed).code).toBe(4400);
    expect(harness.broker.list().length).toBe(before);
  });
  it('heartbeat or tool_result before hello => 4400', async () => {
    const c = track(await connect(port));
    c.send({ type: 'heartbeat' });
    expect((await c.next()).error.code).toBe('hello_required');
    expect((await c.closed).code).toBe(4400);
  });
  it('duplicate hello => 4400 invalid_message and the browser disappears', async () => {
    const { client } = await ready(port);
    track(client);
    client.send(helloFrame());
    expect((await client.closed).code).toBe(4400);
  });
  it('malformed hello (extra key / requested house) => invalid_message', async () => {
    const c = track(await connect(port));
    c.send(helloFrame({ house: 'pocharlies' }));
    expect((await c.next()).type).toBe('hello_reject');
    expect((await c.closed).code).toBe(4400);
  });
  it('ack carries server-issued ids and the trusted house; heartbeat is acked', async () => {
    const { client, ack } = await ready(port);
    track(client);
    expect(ack.house).toBe('default');
    expect(ack.connectionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ack.browserId).not.toBe(ack.connectionId);
    client.send({ type: 'heartbeat' });
    expect((await client.next()).type).toBe('heartbeat_ack');
  });
  it('missing/invalid token => 401 at the upgrade; wrong path => no upgrade', async () => {
    await expect(connect(port, { token: null })).rejects.toMatchObject({ status: 401 });
    await expect(connect(port, { token: 'nope' })).rejects.toMatchObject({ status: 401 });
    await expect(connect(port, { path: '/' })).rejects.toBeTruthy();
  });
});

/** Reach READY, issue a request through the broker, and hand back what the client must answer. */
async function pendingCall(sessionId: string, sizeHook?: (frame: any) => unknown) {
  const { client, ack } = await ready(port);
  track(client);
  harness.broker.select(sessionId, ack.connectionId);
  const call = harness.broker.call(sessionId, 'browser_state', {}, { timeoutMs: 10_000 });
  call.catch(() => {}); // handled here; each test still asserts the outcome
  const req = await client.next();
  const result = (data: unknown) => ({
    type: 'tool_result', id: req.id, sessionId, connectionId: ack.connectionId, house: ack.house, ok: true, data,
  });
  void sizeHook;
  return { client, ack, call, req, result };
}

/** `data` string so the WHOLE serialized frame is exactly `total` bytes, with `fill` as the repeated char. */
function frameOfBytes(base: (data: string) => unknown, total: number, fill = 'a', fillBytes = 1) {
  const overhead = Buffer.byteLength(JSON.stringify(base('')));
  const need = total - overhead;
  const chars = Math.floor(need / fillBytes);
  let text = JSON.stringify(base(fill.repeat(chars)));
  let pad = total - Buffer.byteLength(text);
  // top up with single-byte chars to land exactly on `total`
  if (pad > 0) text = JSON.stringify(base(fill.repeat(chars) + 'a'.repeat(pad)));
  return text;
}

describe('32 MiB message limit on the negotiated endpoint (real WS boundary)', () => {
  it('constant is 33,554,432', () => expect(MAX_MESSAGE_BYTES).toBe(33_554_432));

  it('accepts a result of exactly the limit', async () => {
    const { client, call, result } = await pendingCall('s-exact');
    const text = frameOfBytes((d) => result(d), MAX_MESSAGE_BYTES);
    expect(Buffer.byteLength(text)).toBe(MAX_MESSAGE_BYTES);
    client.send(text);
    await expect(call).resolves.toMatchObject({ ok: true });
  }, 60_000);

  it('rejects limit + 1 with close 1009 and fails the pending call', async () => {
    const { client, call, result } = await pendingCall('s-plus1');
    const text = frameOfBytes((d) => result(d), MAX_MESSAGE_BYTES + 1);
    expect(Buffer.byteLength(text)).toBe(MAX_MESSAGE_BYTES + 1);
    client.send(text);
    expect((await client.closed).code).toBe(1009);
    await expect(call).rejects.toMatchObject({ code: 'browser_disconnected' });
    expect(harness.broker.pendingCount()).toBe(0);
  }, 60_000);

  it('counts UTF-8 bytes: multibyte exact passes, +1 byte fails', async () => {
    const ok = await pendingCall('s-mb-ok');
    ok.client.send(frameOfBytes((d) => ok.result(d), MAX_MESSAGE_BYTES, '€', 3));
    await expect(ok.call).resolves.toMatchObject({ ok: true });
    const bad = await pendingCall('s-mb-bad');
    const text = frameOfBytes((d) => bad.result(d), MAX_MESSAGE_BYTES + 1, '€', 3);
    expect(Buffer.byteLength(text)).toBe(MAX_MESSAGE_BYTES + 1);
    expect(text.length).toBeLessThan(MAX_MESSAGE_BYTES);
    bad.client.send(text);
    expect((await bad.client.closed).code).toBe(1009);
  }, 90_000);

  it('fragmentation does not raise the logical limit', async () => {
    const { client, call, result } = await pendingCall('s-frag');
    const text = frameOfBytes((d) => result(d), MAX_MESSAGE_BYTES + 1);
    const part = Math.ceil(text.length / 4);
    for (let i = 0; i < 4; i += 1) {
      client.ws.send(text.slice(i * part, (i + 1) * part), { fin: i === 3 });
    }
    expect((await client.closed).code).toBe(1009);
    await expect(call).rejects.toMatchObject({ code: 'browser_disconnected' });
  }, 60_000);

  it('compression does not raise the limit (inflated size is bounded)', async () => {
    const { client, ack } = await ready(port, {}, { deflate: true });
    track(client);
    harness.broker.select('s-zip', ack.connectionId);
    const call = harness.broker.call('s-zip', 'browser_state', {}, { timeoutMs: 10_000 });
    call.catch(() => {});
    const req = await client.next();
    const mk = (d: string) => ({ type: 'tool_result', id: req.id, sessionId: 's-zip', connectionId: ack.connectionId, house: ack.house, ok: true, data: d });
    const text = frameOfBytes(mk, MAX_MESSAGE_BYTES + 1);
    client.ws.send(text, { compress: true });
    expect((await client.closed).code).toBe(1009);
    await expect(call).rejects.toMatchObject({ code: 'browser_disconnected' });
  }, 60_000);

  it('outbound: an oversize request fails with payload_too_large BEFORE send and leaves no pending state', async () => {
    const { client, ack } = await ready(port);
    track(client);
    harness.broker.select('s-out', ack.connectionId);
    await expect(
      harness.broker.call('s-out', 'browser_evaluate', { code: 'x'.repeat(MAX_MESSAGE_BYTES) }),
    ).rejects.toMatchObject({ code: 'payload_too_large' });
    expect(harness.broker.pendingCount()).toBe(0);
    expect(client.frames.length).toBe(0);
  }, 60_000);
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHarnessServer, type HarnessServer } from '../src/harness-server.js';
import { SessionBroker } from '../src/session-broker.js';
import { TOKEN, ready, type TestClient } from './harness-helpers.js';

let harness: HarnessServer;
let port: number;
const open: TestClient[] = [];
const prevToken = process.env.BROWSER_WS_TOKEN;

beforeAll(async () => {
  process.env.BROWSER_WS_TOKEN = TOKEN;
  harness = createHarnessServer({ port: 0, house: 'house-a' });
  await harness.listening;
  port = harness.port();
});
afterAll(async () => {
  await harness.close();
  if (prevToken === undefined) delete process.env.BROWSER_WS_TOKEN;
  else process.env.BROWSER_WS_TOKEN = prevToken;
});
afterEach(async () => {
  for (const c of open.splice(0)) c.close();
  // let the server observe the closes so every test starts with an empty broker
  for (let i = 0; i < 50 && harness.broker.list().length > 0; i += 1) await new Promise((r) => setTimeout(r, 10));
  for (const s of ['s1', 's2', 'sA', 'sB']) harness.broker.closeSession(s);
});

async function browser(installationId = 'inst-A', opts: Parameters<typeof ready>[2] = {}) {
  const r = await ready(port, { installationId }, opts);
  open.push(r.client);
  return r;
}
const answer = (req: any, ack: any, over: Record<string, unknown> = {}) => ({
  type: 'tool_result', id: req.id, sessionId: req.sessionId, connectionId: ack.connectionId, house: ack.house, ok: true, data: 'ok', ...over,
});
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

describe('binding per MCP session', () => {
  it('0 candidates => browser_unavailable and no action', async () => {
    await expect(harness.broker.call('s1', 'browser_state', {})).rejects.toMatchObject({ code: 'browser_unavailable' });
  });

  it('1 candidate => atomic auto-bind; the request carries session, connection and tab handle', async () => {
    const { client, ack } = await browser();
    const call = harness.broker.call('s1', 'browser_click', { selector: '#a' }, { tabHandle: 'th-1' });
    const req = await client.next();
    expect(req).toMatchObject({ type: 'tool_request', sessionId: 's1', connectionId: ack.connectionId, tabHandle: 'th-1', tool: 'browser_click', args: { selector: '#a' } });
    client.send(answer(req, ack));
    await expect(call).resolves.toEqual({ ok: true, data: 'ok' });
    expect(harness.broker.binding('s1')).toMatchObject({ sessionId: 's1', connectionId: ack.connectionId, browserId: ack.browserId, house: 'house-a' });
  });

  it('N candidates => browser_selection_required, zero action; never by last activity', async () => {
    const a = await browser('inst-A');
    const b = await browser('inst-B');
    await expect(harness.broker.call('s1', 'browser_state', {})).rejects.toMatchObject({ code: 'browser_selection_required' });
    expect(a.client.frames.length + b.client.frames.length).toBe(0);
  });

  it('explicit selection is persistent for that session only; the other session still needs to choose', async () => {
    const a = await browser('inst-A');
    const b = await browser('inst-B');
    harness.broker.select('s1', b.ack.connectionId);
    const call = harness.broker.call('s1', 'browser_state', {});
    const req = await b.client.next();
    b.client.send(answer(req, b.ack));
    await call;
    expect(harness.broker.list('s1').find((x) => x.selected)?.connectionId).toBe(b.ack.connectionId);
    expect(harness.broker.list('s2').some((x) => x.selected)).toBe(false);
    await expect(harness.broker.call('s2', 'browser_state', {})).rejects.toMatchObject({ code: 'browser_selection_required' });
    expect(a.client.frames.length).toBe(0);
  });

  it('unknown id => browser_not_found', async () => {
    await browser();
    expect(() => harness.broker.select('s1', 'nope')).toThrowError(expect.objectContaining({ code: 'browser_not_found' }));
  });

  it('reselecting while a call is in flight => session_busy', async () => {
    const a = await browser('inst-A');
    const b = await browser('inst-B');
    harness.broker.select('s1', a.ack.connectionId);
    const call = harness.broker.call('s1', 'browser_state', {});
    const req = await a.client.next();
    expect(() => harness.broker.select('s1', b.ack.connectionId)).toThrowError(expect.objectContaining({ code: 'session_busy' }));
    a.client.send(answer(req, a.ack));
    await call;
    // after it settles, reselection works and the OLD browser is told to drop the session context first
    harness.broker.select('s1', b.ack.connectionId);
    expect((await a.client.next()).type).toBe('session_close');
  });

  it('loss of the bound browser fails pending calls and never falls back to another browser', async () => {
    const a = await browser('inst-A');
    const b = await browser('inst-B');
    harness.broker.select('s1', a.ack.connectionId);
    const call = harness.broker.call('s1', 'browser_state', {});
    call.catch(() => {});
    await a.client.next();
    a.client.close();
    await expect(call).rejects.toMatchObject({ code: 'browser_disconnected' });
    await expect(harness.broker.call('s1', 'browser_state', {})).rejects.toMatchObject({ code: 'browser_disconnected' });
    expect(b.client.frames.length).toBe(0);
  });

  it('routing keys cannot ride inside args, unknown tools are refused', async () => {
    await browser();
    await expect(harness.broker.call('s1', 'browser_state', { sessionId: 'other' })).rejects.toMatchObject({ code: 'invalid_message' });
    await expect(harness.broker.call('s1', 'browser_state', { connectionId: 'x' })).rejects.toMatchObject({ code: 'invalid_message' });
    await expect(harness.broker.call('s1', 'not_a_tool', {})).rejects.toMatchObject({ code: 'invalid_message' });
  });

  it('a tool needing a capability the browser did not negotiate => capability_unavailable before dispatch', async () => {
    const { client } = await browser();
    await expect(harness.broker.call('s1', 'browser_cdp', {})).rejects.toMatchObject({ code: 'capability_unavailable' });
    expect(client.frames.length).toBe(0);
  });
});

describe('request correlation by socket and generation', () => {
  it('a result from a foreign socket does not consume the legitimate pending entry', async () => {
    const a = await browser('inst-A');
    const b = await browser('inst-B');
    harness.broker.select('s1', a.ack.connectionId);
    const call = harness.broker.call('s1', 'browser_state', {});
    const req = await a.client.next();
    // B forges A's exact ids
    b.client.send(answer(req, a.ack, { data: 'FORGED' }));
    await tick();
    expect(harness.broker.pendingCount()).toBe(1);
    a.client.send(answer(req, a.ack, { data: 'real' }));
    await expect(call).resolves.toEqual({ ok: true, data: 'real' });
  });

  it('duplicate, late and unknown results are discarded; mismatched ids from the owner are discarded too', async () => {
    const a = await browser();
    const call = harness.broker.call('s1', 'browser_state', {});
    const req = await a.client.next();
    a.client.send(answer(req, a.ack, { sessionId: 'someone-else' }));
    a.client.send(answer(req, a.ack, { connectionId: 'other-conn' }));
    a.client.send(answer(req, a.ack, { house: 'house-b' }));
    a.client.send(answer({ id: 'unknown', sessionId: 's1' }, a.ack));
    await tick();
    expect(harness.broker.pendingCount()).toBe(1);
    a.client.send(answer(req, a.ack));
    await expect(call).resolves.toMatchObject({ ok: true });
    a.client.send(answer(req, a.ack, { data: 'duplicate' }));
    await tick();
    expect(harness.broker.pendingCount()).toBe(0);
  });

  it('timeout settles once, cleans state, tells the browser to cancel, and a late result is dropped', async () => {
    const a = await browser();
    const call = harness.broker.call('s1', 'browser_state', {}, { timeoutMs: 50 });
    const req = await a.client.next();
    await expect(call).rejects.toMatchObject({ code: 'request_timeout' });
    expect((await a.client.next()).type).toBe('request_cancel');
    a.client.send(answer(req, a.ack));
    await tick();
    expect(harness.broker.pendingCount()).toBe(0);
  });

  it('abort => request_cancelled, request_cancel sent, no replay', async () => {
    const a = await browser();
    const ac = new AbortController();
    const call = harness.broker.call('s1', 'browser_state', {}, { signal: ac.signal });
    await a.client.next();
    ac.abort();
    await expect(call).rejects.toMatchObject({ code: 'request_cancelled' });
    expect((await a.client.next()).type).toBe('request_cancel');
    expect(harness.broker.pendingCount()).toBe(0);
  });

  it('closing a session fails its pending calls, tells the extension, forgets the binding; other sessions are untouched', async () => {
    const a = await browser();
    harness.broker.select('s1', a.ack.connectionId);
    harness.broker.select('s2', a.ack.connectionId);
    const c1 = harness.broker.call('s1', 'browser_state', {});
    c1.catch(() => {});
    const c2 = harness.broker.call('s2', 'browser_state', {});
    await a.client.next();
    const req2 = await a.client.next();
    harness.broker.closeSession('s1');
    harness.broker.closeSession('s1'); // idempotent
    await expect(c1).rejects.toMatchObject({ code: 'session_closed' });
    expect((await a.client.next()).type).toBe('session_close');
    expect(harness.broker.binding('s1')).toBeNull();
    a.client.send(answer(req2, a.ack));
    await expect(c2).resolves.toMatchObject({ ok: true });
  });

  it('a stale socket closing does not remove a newer registration', () => {
    const broker = new SessionBroker();
    const s1 = {};
    const s2 = {};
    const base = { browserId: 'b', house: 'h', label: '', installationId: 'i', capabilities: [], send() {}, isOpen: () => true };
    broker.register({ ...base, connectionId: 'c1', socket: s1 });
    broker.unregister('c1', s2); // wrong socket
    expect(broker.get('c1')).not.toBeNull();
    broker.unregister('c1', s1);
    expect(broker.get('c1')).toBeNull();
  });
});

describe('MANDATORY adversarial: shared token + copied installation UUID', () => {
  it('cannot replace a live socket, obtain its binding, settle its pending call or resume its identity', async () => {
    const a = await browser('victim-installation');
    harness.broker.select('sA', a.ack.connectionId);
    const call = harness.broker.call('sA', 'browser_state', {});
    const req = await a.client.next();

    // attacker: same shared token, copies the victim's installationId
    const x = await browser('victim-installation');
    expect(x.ack.connectionId).not.toBe(a.ack.connectionId);
    expect(x.ack.browserId).not.toBe(a.ack.browserId);

    // 1. the live socket was NOT replaced
    expect(a.client.ws.readyState).toBe(a.client.ws.OPEN);
    expect(harness.broker.list().map((b) => b.connectionId).sort()).toEqual([a.ack.connectionId, x.ack.connectionId].sort());
    // 2. the attacker session gets no binding of the victim
    await expect(harness.broker.call('sB', 'browser_state', {})).rejects.toMatchObject({ code: 'browser_selection_required' });
    expect(harness.broker.binding('sA')?.connectionId).toBe(a.ack.connectionId);
    // 3. cannot settle the victim's pending call
    x.client.send(answer(req, a.ack, { data: 'STOLEN' }));
    x.client.send(answer(req, x.ack, { data: 'STOLEN2' }));
    await tick();
    expect(harness.broker.pendingCount()).toBe(1);
    a.client.send(answer(req, a.ack, { data: 'victim-data' }));
    await expect(call).resolves.toEqual({ ok: true, data: 'victim-data' });
  });

  it('reconnection with the same installationId does not resume the previous binding (no trusted enrollment)', async () => {
    const a = await browser('inst-R');
    harness.broker.select('sA', a.ack.connectionId);
    a.client.close();
    await a.client.closed;
    await tick();
    const a2 = await browser('inst-R');
    expect(a2.ack.browserId).not.toBe(a.ack.browserId);
    await expect(harness.broker.call('sA', 'browser_state', {})).rejects.toMatchObject({ code: 'browser_disconnected' });
    // an explicit, fresh selection is the only way forward
    harness.broker.select('sA', a2.ack.connectionId);
    const call = harness.broker.call('sA', 'browser_state', {});
    const req = await a2.client.next();
    a2.client.send(answer(req, a2.ack));
    await expect(call).resolves.toMatchObject({ ok: true });
  });

  it('cross-house: a browser of another house never inherits or settles a foreign binding (shared broker)', async () => {
    const shared = new SessionBroker();
    const hA = createHarnessServer({ port: 0, house: 'house-a', broker: shared });
    const hB = createHarnessServer({ port: 0, house: 'house-b', broker: shared });
    await Promise.all([hA.listening, hB.listening]);
    try {
      const a = await ready(hA.port(), { installationId: 'same-uuid' });
      const b = await ready(hB.port(), { installationId: 'same-uuid' });
      open.push(a.client, b.client);
      expect(a.ack.house).toBe('house-a');
      expect(b.ack.house).toBe('house-b');
      shared.select('sA', a.ack.connectionId);
      const call = shared.call('sA', 'browser_state', {});
      const req = await a.client.next();
      b.client.send(answer(req, a.ack, { house: 'house-b' }));
      b.client.send(answer(req, b.ack));
      await tick();
      expect(shared.pendingCount()).toBe(1);
      a.client.send(answer(req, a.ack));
      await expect(call).resolves.toMatchObject({ ok: true });
    } finally {
      await Promise.all([hA.close(), hB.close()]);
    }
  });

  it('an access policy hides browsers from unauthorized principals and unknown/unauthorized ids look the same', async () => {
    const policy = new SessionBroker({ authorize: (principal, c) => principal === c.house });
    const base = { browserId: 'b1', label: '', installationId: 'i', capabilities: [], send() {}, isOpen: () => true };
    policy.register({ ...base, connectionId: 'c1', house: 'house-a', socket: {} });
    expect(policy.list(undefined, 'house-b')).toHaveLength(0);
    expect(() => policy.select('s', 'c1', 'house-b')).toThrowError(expect.objectContaining({ code: 'browser_not_found' }));
    expect(() => policy.select('s', 'zzz', 'house-b')).toThrowError(expect.objectContaining({ code: 'browser_not_found' }));
    expect(policy.select('s', 'c1', 'house-a').connectionId).toBe('c1');
  });
});

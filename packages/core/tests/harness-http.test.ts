import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '@agent-jake-browser/protocol';
import { createHttpServer, type HttpServer } from '../src/http/server.js';
import { getAllTools } from '../src/tools/index.js';
import { TOKEN, ready, type TestClient } from './harness-helpers.js';

let http: HttpServer;
let base: string;
const open: TestClient[] = [];
const prevToken = process.env.BROWSER_WS_TOKEN;

beforeAll(async () => {
  process.env.BROWSER_WS_TOKEN = TOKEN;
  http = createHttpServer({
    port: 0,
    wsPort: 0,
    harness: {
      port: 0,
      house: 'house-a',
      verifier: (req) => {
        const h = req.get('authorization');
        return h === 'Bearer alice' ? 'alice' : h === 'Bearer bob' ? 'bob' : null;
      },
    },
  });
  const listener = await http.listen();
  base = `http://127.0.0.1:${(listener.address() as { port: number }).port}/mcp`;
  await http.harness!.listening;
});
afterAll(async () => {
  await http.close();
  if (prevToken === undefined) delete process.env.BROWSER_WS_TOKEN;
  else process.env.BROWSER_WS_TOKEN = prevToken;
});
afterEach(() => {
  for (const c of open.splice(0)) c.close();
});

const headers = (who: string | null, sid?: string) => ({
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  ...(who ? { authorization: `Bearer ${who}` } : {}),
  ...(sid ? { 'mcp-session-id': sid } : {}),
});
const rpc = async (who: string | null, body: unknown, sid?: string) => {
  const res = await fetch(base, { method: 'POST', headers: headers(who, sid), body: JSON.stringify(body) });
  const text = await res.text();
  const json = text.startsWith('event:') || text.includes('\ndata:') ? JSON.parse(text.split('data: ').pop()!.trim()) : text ? JSON.parse(text) : null;
  return { res, json };
};
async function initialize(who: string) {
  const { res } = await rpc(who, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  const sid = res.headers.get('mcp-session-id')!;
  await fetch(base, { method: 'POST', headers: headers(who, sid), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  return sid;
}
async function browser(installationId: string) {
  const r = await ready(http.harness!.port(), { installationId });
  open.push(r.client);
  return r;
}
const callTool = (who: string, sid: string, name: string, args: Record<string, unknown> = {}) =>
  rpc(who, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }, sid);
const reply = (req: any, ack: any, data: unknown) => ({
  type: 'tool_result', id: req.id, sessionId: req.sessionId, connectionId: ack.connectionId, house: ack.house, ok: true, data,
});

describe('HTTP boundary in negotiated mode', () => {
  it('rejects unauthenticated callers on POST/GET/DELETE with 401', async () => {
    expect((await rpc(null, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).res.status).toBe(401);
    expect((await fetch(base, { method: 'GET', headers: headers(null, 'x') })).status).toBe(401);
    expect((await fetch(base, { method: 'DELETE', headers: headers(null, 'x') })).status).toBe(401);
  });
  it('initialize without a session header creates one; later missing id => 400; unknown/foreign => 404; fresh initialize works', async () => {
    const sid = await initialize('alice');
    expect(sid).toBeTruthy();
    expect((await rpc('alice', { jsonrpc: '2.0', id: 2, method: 'tools/list' })).res.status).toBe(400);
    expect((await rpc('alice', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'does-not-exist')).res.status).toBe(404);
    // another principal presenting alice's session id: indistinguishable from unknown
    expect((await rpc('bob', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, sid)).res.status).toBe(404);
    expect((await fetch(base, { method: 'DELETE', headers: headers('bob', sid) })).status).toBe(404);
    expect((await initialize('alice'))).toBeTruthy();
  });
  it('multi-house without a verifier fails closed at construction', () => {
    expect(() => createHttpServer({ port: 0, wsPort: 0, harness: { port: 0, multiHouse: true } })).toThrow(/verifier/);
  });
});

describe('two MCP clients, identical JSON-RPC ids, real sockets, reversed replies', () => {
  it('each session talks to its own selected browser; replies cannot cross', async () => {
    const a = await browser('inst-A');
    const b = await browser('inst-B');
    const s1 = await initialize('alice');
    const s2 = await initialize('bob');

    // no auto-bind with two browsers
    const unbound = await callTool('alice', s1, 'browser_state');
    expect(unbound.json.result.isError).toBe(true);
    expect(unbound.json.result.content[0].text).toMatch(/^browser_selection_required/);

    const p1 = callTool('alice', s1, 'browser_state', { connection: a.ack.connectionId });
    const p2 = callTool('bob', s2, 'browser_state', { connection: b.ack.connectionId });
    const reqA = await a.client.next();
    const reqB = await b.client.next();
    expect(reqA.sessionId).toBe(s1);
    expect(reqB.sessionId).toBe(s2);
    expect(reqA.args).toEqual({}); // `connection` never reaches the extension
    // reversed order of replies; B tries to answer A's request as well
    b.client.send(reply(reqA, a.ack, 'STOLEN'));
    b.client.send(reply(reqB, b.ack, 'for-bob'));
    a.client.send(reply(reqA, a.ack, 'for-alice'));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(JSON.stringify(r1.json.result)).toContain('for-alice');
    expect(JSON.stringify(r2.json.result)).toContain('for-bob');
    expect(JSON.stringify(r1.json.result)).not.toContain('STOLEN');
  });

  it('browser_list_connections shows `active` only for the session that selected it; DELETE closes one session only', async () => {
    const a = await browser('inst-A');
    const s1 = await initialize('alice');
    const s2 = await initialize('bob');
    const p = callTool('alice', s1, 'browser_state');
    const req = await a.client.next();
    a.client.send(reply(req, a.ack, 'x'));
    await p;
    const l1 = JSON.parse((await callTool('alice', s1, 'browser_list_connections')).json.result.content[0].text);
    const l2 = JSON.parse((await callTool('bob', s2, 'browser_list_connections')).json.result.content[0].text);
    expect(l1[0].active).toBe(true);
    expect(l2[0].active).toBe(false);
    expect((await fetch(base, { method: 'DELETE', headers: headers('alice', s1) })).status).toBeLessThan(300);
    expect((await a.client.next()).type).toBe('session_close');
    expect(http.harness!.broker.binding(s1)).toBeNull();
    expect((await rpc('bob', { jsonrpc: '2.0', id: 3, method: 'tools/list' }, s2)).res.status).toBe(200);
  });
});

describe('catalog parity and layering', () => {
  it('every core tool is in the protocol catalog (single source of tool names)', () => {
    const missing = getAllTools().map((t) => t.schema.name).filter((n) => !TOOL_NAMES.includes(n));
    expect(missing).toEqual([]);
  });
  it('every wire tool the server can send is in the catalog', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8');
    const wire = [...src.matchAll(/\| '(browser_[a-z_]+)'/g)].map((m) => m[1]);
    expect(wire.length).toBeGreaterThan(30);
    expect(wire.filter((n) => !TOOL_NAMES.includes(n))).toEqual([]);
  });
});

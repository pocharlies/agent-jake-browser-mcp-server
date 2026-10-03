import express, { type Request, type Response, type NextFunction, type Express } from 'express';
import type { Server as HttpListener } from 'node:http';
import type { Stats } from 'node:fs';
import type { ToolSchema, ToolResult } from '../types.js';
import type { ContextManager } from '../context.js';
import { INDEX_HTML, PAIR_HTML } from './pages.js';
import { randomUUID } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createContext } from '../context.js';
import { getAllTools } from '../tools/index.js';
import { getSharedTokenStore } from '../token-store.js';
import { createPairingStore } from '../pairing-store.js';
import { patchZipConfig } from '../extension-zip.js';
import { createHarnessServer, type HarnessServer, type HarnessServerOptions } from '../harness-server.js';
import { callToolViaHarness } from '../harness-routing.js';


export interface HttpServerOptions {
  port?: number;
  wsPort?: number;
  host?: string;
  extensionZip?: string;
  wsPath?: string;
  /**
   * Negotiated endpoint (/ws/harness). Opt-in: when set, MCP tool calls are routed ONLY to browsers that completed
   * the authenticated hello, bound per MCP session. Legacy WS stays as configured; nothing falls back between them.
   */
  harness?: HarnessHttpOptions;
}

export type HarnessHttpOptions = HarnessServerOptions & {
  /** Verifies the MCP caller on POST/GET/DELETE /mcp and returns its principal; null = reject (401). */
  verifier?: (req: Request) => string | null | Promise<string | null>;
  /** More than one house served by this listener: fails closed unless a verifier is provided. */
  multiHouse?: boolean;
};

export interface HttpServer {
  app: Express;
  context: ContextManager;
  /** Negotiated endpoint, when enabled. */
  harness?: HarnessServer;
  listen(): Promise<HttpListener>;
  close(): Promise<void>;
}

/** Construct the existing HTTP product explicitly; importing core has no listeners. */
export function createHttpServer(options: HttpServerOptions = {}): HttpServer {
  const PORT = options.port ?? Number(process.env.MCP_HTTP_PORT || 8000);
  const WS_PORT = options.wsPort ?? Number(process.env.BROWSER_WS_PORT || 8765);
  const HTTP_HOST = options.host ?? (process.env.MCP_HTTP_HOST || '127.0.0.1');
  const EXTENSION_ZIP =
    options.extensionZip ?? (process.env.BROWSER_EXTENSION_ZIP || '/app/extension/agent-jake-browser-extension.zip');
  const WS_PATH = options.wsPath ?? (process.env.BROWSER_WS_PATH || '/');

  const CONNECTION_FIELD = {
    type: 'string',
    description:
      'Browser connection id to target; defaults to the most recently used. See browser_list_connections.',
  };

  const app = express();
  app.use(express.json());

  const transports = new Map<string, StreamableHTTPServerTransport>();
  const servers = new Map<string, Server>();
  const harnessOptions: HarnessHttpOptions | undefined = options.harness ?? (process.env.BROWSER_HARNESS_PORT
    ? { port: Number(process.env.BROWSER_HARNESS_PORT), house: process.env.BROWSER_HARNESS_HOUSE }
    : undefined);
  if (harnessOptions?.multiHouse && !harnessOptions.verifier) {
    throw new Error('negotiated multi-house mode requires an HTTP verifier on /mcp (fails closed)');
  }
  const context = createContext({ port: WS_PORT });
  const harness: HarnessServer | undefined = harnessOptions ? createHarnessServer(harnessOptions) : undefined;
  const verifier = harnessOptions?.verifier;
  /** MCP session -> principal that created it. Session ids are routing state, never credentials. */
  const owners = new Map<string, string>();
  const tokenStore = getSharedTokenStore();
  const allTools = getAllTools();
  const toolMap = new Map(allTools.map((tool) => [tool.schema.name, tool]));

  const pairing = createPairingStore({
    issueToken: (record) =>
      tokenStore.issueToken({
        label: record.label || 'pairing',
        ...(record.connectionId ? { connectionId: record.connectionId } : {}),
      }),
  });

  /**
   * Advertise the optional `connection` argument on every tool without touching the
   * ~30 zod schemas: the annotation happens here, and the field is stripped before
   * the tool runs so zod never sees it.
   */
  function annotateToolSchema(tool: ToolSchema): ToolSchema {
    const annotated = structuredClone(tool);
    if (!annotated.inputSchema || typeof annotated.inputSchema !== 'object') {
      annotated.inputSchema = { type: 'object', properties: {} };
    }
    if (!annotated.inputSchema.properties || typeof annotated.inputSchema.properties !== 'object') {
      annotated.inputSchema.properties = {};
    }
    (annotated.inputSchema.properties as Record<string, unknown>).connection ??= { ...CONNECTION_FIELD };
    return annotated;
  }

  function toolsListPayload() {
    return allTools.map((tool) => annotateToolSchema(tool.schema));
  }

  function textContent(text: string, isError = false): ToolResult {
    const result: ToolResult = { content: [{ type: 'text', text }] };
    if (isError) result.isError = true;
    return result;
  }

  /**
   * Resolve the target browser, run the tool against that connection and keep
   * `connection` out of the arguments sent to the extension.
   */
  async function callTool(
    name: string,
    rawArgs?: Record<string, unknown>,
    extra?: { sessionId?: string; signal?: AbortSignal },
  ): Promise<ToolResult> {
    const tool = toolMap.get(name);
    if (!tool) return textContent(`Unknown tool: ${name}`, true);

    if (harness) {
      // Server-side tools (browser_list_connections) answer from the broker; the rest go to the BOUND browser.
      const sessionId = extra?.sessionId;
      if (!sessionId) return textContent('session_closed: the MCP session has no identity', true);
      return callToolViaHarness(harness, tool, name, rawArgs, {
        sessionId,
        principal: owners.get(sessionId),
        signal: extra?.signal,
      });
    }

    const args = { ...(rawArgs ?? {}) };
    const connection =
      typeof args.connection === 'string' && args.connection.trim() ? args.connection.trim() : undefined;
    delete args.connection;

    if (tool.serverSide) {
      return tool.handle(context, args);
    }

    if (connection && !context.isConnected(connection)) {
      const open = context.listConnections().map((c) => c.connectionId).join(', ') || 'none';
      return textContent(
        `No browser connection with id "${connection}" (open: ${open}). Call browser_list_connections to see the current ones.`,
        true,
      );
    }

    if (!context.isConnected(connection)) {
      try {
        await context.waitForConnection(10000);
      } catch {
        return textContent(
          'Extension not connected. Please ensure the Chrome extension is running and connected.',
          true,
        );
      }
    }

    return tool.handle(context.forConnection(connection), args);
  }

  function createMcpServer() {
    const server = new Server(
      { name: 'agent-jake-browser-mcp', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: toolsListPayload(),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
      callTool(request.params.name, request.params.arguments, {
        sessionId: extra.sessionId,
        signal: extra.signal,
      }) as Promise<import('@modelcontextprotocol/sdk/types.js').CallToolResult>,
    );

    return server;
  }

  function listToolsResult() {
    return { jsonrpc: '2.0', id: null, result: { tools: toolsListPayload() } };
  }

  /**
   * The extension polls pairing from a chrome-extension origin. The approval page
   * is same-origin and must not expose its token response to arbitrary websites.
   */
  function cors(req: Request, res: Response, next: NextFunction) {
    const origin = req.headers.origin || '';
    if (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
      if (req.method === 'OPTIONS') return res.sendStatus(403);
      return next();
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    next();
  }

  app.use((req, res, next) => {
    if (req.path === '/pair/start' || req.path === '/pair/status') {
      return cors(req, res, next);
    }
    return next();
  });

  /**
   * ws(s) URL handed to the extension: behind a reverse proxy the forwarded
   * headers are authoritative, and BROWSER_PUBLIC_WS_URL wins over both.
   */
  function publicWsUrl(req: Request): string {
    if (process.env.BROWSER_PUBLIC_WS_URL) return process.env.BROWSER_PUBLIC_WS_URL;

    const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
      .split(',')
      .map((part) => part.trim())
      .find(Boolean);
    const forwardedHost = String(req.headers['x-forwarded-host'] || '').trim();
    const proto = forwardedProto || req.protocol || 'http';
    const isSecured = proto === 'https' || proto === 'wss';

    // Behind a reverse proxy the public host and the WS path are the proxy's
    // business: the extension must use the address the proxy advertises.
    if (forwardedProto || forwardedHost) {
      const host = forwardedHost || String(req.headers.host || 'localhost');
      return `${isSecured ? 'wss' : 'ws'}://${host}${WS_PATH}`;
    }

    // Direct access: the extension reaches the WebSocket on its own port, which is
    // not the HTTP port that served this response.
    const hostname = String(req.headers.host || '127.0.0.1').split(':')[0] || '127.0.0.1';
    return `${isSecured ? 'wss' : 'ws'}://${hostname}:${WS_PORT}${WS_PATH}`;
  }

  app.get('/healthz', (_req, res) => {
    res.status(200).send('ok');
  });

  app.get('/connections', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      authEnabled:
        (process.env.BROWSER_WS_TOKEN || '') !== '' || process.env.BROWSER_ALLOW_PAIRING === 'true',
      wsUrl: publicWsUrl(req),
      connections: context.listConnections(),
    });
  });

  /**
   * The patched archive is derived from the template plus BROWSER_PUBLIC_WS_URL, so
   * one cache slot is enough; the key changes when the mounted template is replaced.
   */
  let patchedZipCache: { key: string; buffer: Buffer } | null = null;

  function patchedExtensionZip(zipPath: string, info: Stats, wsUrl: string): Buffer {
    const key = JSON.stringify([zipPath, info.mtimeMs, info.size, wsUrl]);
    if (patchedZipCache && patchedZipCache.key === key) return patchedZipCache.buffer;

    const patched = patchZipConfig(readFileSync(zipPath), wsUrl);
    patchedZipCache = { key, buffer: patched.buffer };
    console.error(
      `Agent Jake Browser: ${patched.replaced ? 'updated' : 'added'} ${patched.entryName} -> ${wsUrl} (${patched.buffer.length} bytes)`,
    );
    return patched.buffer;
  }

  app.get('/download', async (_req, res) => {
    try {
      const info = await stat(EXTENSION_ZIP);
      const wsUrl = (process.env.BROWSER_PUBLIC_WS_URL || '').trim();

      res.setHeader('Cache-Control', 'public, max-age=60');
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${path.basename(EXTENSION_ZIP)}"`,
      );

      let patched: Buffer | null = null;
      if (wsUrl) {
        try {
          patched = patchedExtensionZip(EXTENSION_ZIP, info, wsUrl);
        } catch (err) {
          // A broken template must not take the download down: serve the original.
          console.error('Agent Jake Browser: config.json injection failed, serving template as-is', err);
          patched = null;
        }
      }

      if (patched) {
        res.setHeader('Content-Length', String(patched.length));
        res.end(patched);
        return;
      }

      res.setHeader('Content-Length', String(info.size));
      createReadStream(EXTENSION_ZIP).pipe(res);
    } catch {
      res.status(404).type('text/plain; charset=utf-8').send(
        `Extension zip not found on the server at ${EXTENSION_ZIP}.\n` +
          'Set BROWSER_EXTENSION_ZIP to the built extension archive, or load the extension unpacked from a local checkout.\n' +
          'Build it in agent-jake-browser-mcp-extension with: npm run build && zip -r dist/extension.zip dist',
      );
    }
  });

  app.get('/', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.type('html').send(INDEX_HTML);
  });

  app.get('/pair', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(PAIR_HTML);
  });

  app.post('/pair/start', (req, res) => {
    const otp = typeof req.body?.otp === 'string' ? req.body.otp.trim() : '';
    if (!/^[\w:-]{4,128}$/.test(otp)) {
      res.status(400).json({ error: 'otp must be a 4-128 character code (letters, digits, - or _)' });
      return;
    }
    const connectionId =
      typeof req.body?.connectionId === 'string' && req.body.connectionId.trim()
        ? req.body.connectionId.trim().slice(0, 128)
        : undefined;
    const label =
      typeof req.body?.label === 'string' && req.body.label.trim()
        ? req.body.label.trim().slice(0, 128)
        : undefined;

    const record = pairing.start(otp, { connectionId, label });
    res.status(201).json({
      state: 'pending',
      otp,
      expiresAt: new Date(record.expiresAt).toISOString(),
      approveUrl: `${publicOrigin(req)}/pair?otp=${encodeURIComponent(otp)}`,
    });
  });

  app.post('/pair/approve', (req, res) => {
    const otp = typeof req.body?.otp === 'string' ? req.body.otp.trim() : '';
    const result = pairing.approve(otp);
    if (!result.ok) {
      res.status(410).json({
        error:
          result.reason === 'used'
            ? 'This pairing code was already used. Ask the extension to start a new pairing.'
            : 'This pairing code is expired or unknown. Ask the extension to start a new pairing.',
      });
      return;
    }
    res.json({ token: result.token, wsUrl: publicWsUrl(req) });
  });

  app.get('/pair/status', (req, res) => {
    const otp = typeof req.query.otp === 'string' ? req.query.otp.trim() : '';
    const status = pairing.status(otp);
    res.setHeader('Cache-Control', 'no-store');
    res.json(status);
  });

  function publicOrigin(req: Request): string {
    if (process.env.BROWSER_PUBLIC_ORIGIN) return process.env.BROWSER_PUBLIC_ORIGIN.replace(/\/$/, '');
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT}`);
    return `${forwardedProto || req.protocol || 'http'}://${host}`;
  }

  /**
   * Negotiated mode: verify the caller on POST/GET/DELETE BEFORE any session lookup, and check that the session
   * belongs to that principal. Unknown, expired and foreign ids are all 404 (no enumeration); a missing id on a
   * non-initialize request is 400; an initialize without a session header creates a new session.
   */
  async function harnessGuard(req: Request, res: Response, next: NextFunction) {
    if (!harness) return next();
    let principal: string | null = 'operator';
    if (verifier) {
      try {
        principal = await verifier(req);
      } catch {
        principal = null;
      }
    }
    if (principal === null) {
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
      return;
    }
    res.locals.principal = principal;
    const sessionId = req.get('mcp-session-id');
    const isInit = req.method === 'POST' && !sessionId && isInitializeRequest(req.body);
    if (isInit) return next();
    if (!sessionId) {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header is required' }, id: req.body?.id ?? null });
      return;
    }
    if (owners.get(sessionId) !== principal || !transports.has(sessionId)) {
      res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: req.body?.id ?? null });
      return;
    }
    next();
  }
  app.use('/mcp', harnessGuard);

  app.post('/mcp', async (req, res) => {
    try {
      if (!req.headers['mcp-session-id'] && req.body?.method === 'tools/list') {
        res.json({ ...listToolsResult(), id: req.body?.id ?? null });
        return;
      }

      const sessionId = req.get('mcp-session-id');
      let transport: StreamableHTTPServerTransport;
      let server: Server;

      if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId)!;
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            transports.set(newSessionId, transport);
            servers.set(newSessionId, server);
            if (harness) owners.set(newSessionId, String(res.locals.principal ?? 'operator'));
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            transports.delete(transport.sessionId);
            servers.delete(transport.sessionId);
            owners.delete(transport.sessionId);
            harness?.broker.closeSession(transport.sessionId);
          }
        };
        server = createMcpServer();
        await server.connect(transport);

      } else {
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: no valid session ID' }, id: req.body?.id ?? null });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('MCP POST failed', error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: req.body?.id ?? null });
      }
    }
  });

  app.get('/mcp', async (req, res) => {
    const sessionId = req.get('mcp-session-id');
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: no valid session ID' }, id: null });
      return;
    }
    await transport.handleRequest(req, res);
  });

  app.delete('/mcp', async (req, res) => {
    const sessionId = req.get('mcp-session-id');
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: no valid session ID' }, id: req.body?.id ?? null });
      return;
    }
    await transport.handleRequest(req, res, req.body);
    // DELETE is the logical end of the session. An SSE stream ending is not.
    if (harness && sessionId) {
      owners.delete(sessionId);
      harness.broker.closeSession(sessionId);
    }
  });


  let listener: HttpListener | undefined;
  return {
    app,
    context,
    harness,
    async listen() {
      if (listener) return listener;
      // HTTP remains loopback by default; authentication is provided by the operator's proxy.
      listener = await new Promise<HttpListener>((resolve, reject) => {
        const pending = app.listen(PORT, HTTP_HOST, (error?: Error) => {
          if (error) reject(error);
          else resolve(pending);
        });
      });
      console.error(`Agent Jake Browser MCP HTTP endpoint on ${HTTP_HOST}:${PORT}/mcp`);
      console.error(`Agent Jake Browser extension WebSocket on ${process.env.BROWSER_WS_HOST || '127.0.0.1'}:${WS_PORT}`);
      console.error(`Extension download: ${EXTENSION_ZIP} (served at /download)`);
      return listener;
    },
    async close() {
      await Promise.all([...servers.values()].map((server) => server.close()));
      await Promise.all([...transports.values()].map((transport) => transport.close()));
      if (listener) {
        const active = listener;
        listener = undefined;
        await new Promise<void>((resolve, reject) => active.close((error) => error ? reject(error) : resolve()));
      }
      await harness?.close();
      await context.close();
    },
  };
}

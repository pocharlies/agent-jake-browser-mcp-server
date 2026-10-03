/**
 * Negotiated Browser Harness WebSocket endpoint (/ws/harness), separate from the legacy listener.
 *
 * authenticated upgrade -> AWAITING_HELLO -> READY -> CLOSED. No browser is registered and no tool is
 * dispatched before READY. There is NO fallback to the legacy wire on a missing/late/invalid hello.
 */
import { randomUUID } from 'crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import {
  CATALOG_VERSION,
  CLOSE_CODES,
  HARNESS_WS_PATH,
  HEARTBEAT_INTERVAL_MS,
  HELLO_TIMEOUT_MS,
  MAX_MESSAGE_BYTES,
  PROTOCOL_PACKAGE_VERSION,
  ProtocolError,
  SUPPORTED_PROTOCOL_VERSIONS,
  negotiateVersion,
  parseClientFrame,
  serializeFrame,
  type ClientHello,
  type ErrorCode,
  type ServerFrame,
} from '@agent-jake-browser/protocol';
import { logger } from './utils/logger.js';
import { getSharedTokenStore, type TokenStore } from './token-store.js';
import { isAuthEnabled, isAuthorizedToken, parseHandshakeParams } from './ws-server.js';
import { SessionBroker, type SessionBrokerOptions } from './session-broker.js';

export interface HarnessServerOptions {
  port: number;
  host?: string;
  tokenStore?: TokenStore;
  /** Trusted deployment configuration. Never taken from the client. */
  house?: string;
  serverVersion?: string;
  helloTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxPayload?: number;
  /** Options for a private broker, or a shared broker instance (several listeners / houses). */
  broker?: SessionBroker | SessionBrokerOptions;
}

export interface HarnessServer {
  server: WebSocketServer;
  broker: SessionBroker;
  /** Resolves once the listener is bound (port 0 => ephemeral). */
  listening: Promise<void>;
  port(): number;
  close(): Promise<void>;
}

type State = 'AWAITING_HELLO' | 'READY' | 'CLOSED';

function rawByteLength(data: RawData): { text: string; bytes: number } {
  const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
  return { text: buf.toString('utf8'), bytes: buf.length };
}

export function createHarnessServer(options: HarnessServerOptions): HarnessServer {
  const tokenStore = options.tokenStore ?? getSharedTokenStore();
  const broker = options.broker instanceof SessionBroker ? options.broker : new SessionBroker(options.broker);
  const host = options.host || process.env.BROWSER_WS_HOST || '127.0.0.1';
  const house = options.house ?? 'default';
  const helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? HEARTBEAT_INTERVAL_MS * 3;
  const sockets = new Set<WebSocket>();

  const authorize = (token: string | null): boolean => !isAuthEnabled() || isAuthorizedToken(token, tokenStore);

  const server = new WebSocketServer({
    port: options.port,
    host,
    path: HARNESS_WS_PATH,
    // Only this endpoint carries the 32 MiB bound; ws enforces it on the reassembled AND inflated message.
    maxPayload: options.maxPayload ?? MAX_MESSAGE_BYTES,
    perMessageDeflate: { threshold: 1024 },
    verifyClient: (info, done) => {
      const params = parseHandshakeParams(info.req.url || '/', info.req.headers.host || 'localhost');
      if (authorize(params.token)) return done(true);
      logger.warn('[harness] handshake rejected: missing or invalid token');
      return done(false, 401, 'unauthorized');
    },
  });

  const idleTimer = setInterval(() => {
    const cutoff = Date.now() - idleTimeoutMs;
    for (const conn of broker.list()) {
      if (conn.lastActiveAt < cutoff) {
        const live = broker.get(conn.connectionId);
        (live?.socket as WebSocket | undefined)?.close(1001, 'idle');
      }
    }
  }, Math.max(1000, Math.floor(idleTimeoutMs / 3)));
  idleTimer.unref?.();

  server.on('connection', (ws) => {
    sockets.add(ws);
    let state: State = 'AWAITING_HELLO';
    let connectionId: string | null = null;

    const sendFrame = (frame: ServerFrame) => ws.send(serializeFrame(frame));

    const reject = (code: ErrorCode, message: string, closeCode: number, extra: { supported?: boolean } = {}) => {
      if (state === 'CLOSED') return;
      const wasReady = state === 'READY';
      state = 'CLOSED';
      if (!wasReady) {
        try {
          sendFrame({
            type: 'hello_reject',
            error: { code, message },
            ...(extra.supported ? { supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS] } : {}),
          });
        } catch {
          // socket already unusable
        }
      }
      ws.close(closeCode, code);
    };

    const helloTimer = setTimeout(() => {
      reject('hello_timeout', 'no hello within the allowed time', CLOSE_CODES.HELLO_TIMEOUT);
    }, helloTimeoutMs);

    const onHello = (hello: ClientHello) => {
      const version = negotiateVersion(SUPPORTED_PROTOCOL_VERSIONS, hello.supportedProtocolVersions);
      if (version === null) {
        return reject('protocol_version_mismatch', 'no common protocol version', CLOSE_CODES.VERSION_MISMATCH, { supported: true });
      }
      if (hello.catalogVersion !== CATALOG_VERSION) {
        return reject('catalog_version_mismatch', 'tool catalog differs from the server catalog', CLOSE_CODES.VERSION_MISMATCH, { supported: true });
      }
      clearTimeout(helloTimer);
      // Identity is issued here. installationId is a client hint: it never replaces a live socket or resumes a binding.
      const id = randomUUID();
      const browserId = randomUUID();
      const effective = hello.capabilities; // approved subset = what the client offered; permissions never come from it
      broker.register({
        connectionId: id,
        browserId,
        house,
        label: hello.platform,
        installationId: hello.installationId,
        capabilities: effective,
        socket: ws,
        send: (text) => ws.send(text),
        isOpen: () => ws.readyState === WebSocket.OPEN,
      });
      connectionId = id;
      state = 'READY';
      sendFrame({
        type: 'hello_ack',
        protocolVersion: version,
        protocolPackageVersion: PROTOCOL_PACKAGE_VERSION,
        catalogVersion: CATALOG_VERSION,
        serverVersion: options.serverVersion ?? '1.0.0',
        browserId,
        connectionId: id,
        house,
        capabilities: effective,
      });
      logger.info(`[harness] browser ready (${id}) — ${broker.list().length} connection(s)`);
    };

    ws.on('message', (data, isBinary) => {
      if (state === 'CLOSED') return;
      if (isBinary) return reject('invalid_message', 'binary frames are not part of the protocol', CLOSE_CODES.INVALID_PROTOCOL);
      const { text, bytes } = rawByteLength(data);
      let frame;
      try {
        frame = parseClientFrame(text, bytes);
      } catch (err) {
        const code = err instanceof ProtocolError ? err.code : 'invalid_message';
        if (code === 'payload_too_large') return reject(code, 'message exceeds the size limit', CLOSE_CODES.MESSAGE_TOO_BIG);
        if (state === 'AWAITING_HELLO') {
          // A legacy frame (no negotiated "type") is not a hello: visible rejection, zero actions, no fallback.
          return reject('hello_required', 'the first frame must be a valid hello', CLOSE_CODES.INVALID_PROTOCOL);
        }
        return reject('invalid_message', 'frame does not match the protocol', CLOSE_CODES.INVALID_PROTOCOL);
      }

      if (state === 'AWAITING_HELLO') {
        if (frame.type !== 'hello') return reject('hello_required', 'the first frame must be hello', CLOSE_CODES.INVALID_PROTOCOL);
        return onHello(frame);
      }
      // READY
      if (connectionId) broker.touch(connectionId);
      switch (frame.type) {
        case 'hello':
          return reject('invalid_message', 'duplicate hello', CLOSE_CODES.INVALID_PROTOCOL);
        case 'heartbeat':
          return sendFrame({ type: 'heartbeat_ack' });
        case 'tool_result':
          broker.handleResult(ws, frame);
          return;
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      sockets.delete(ws);
      const wasReady = connectionId !== null;
      state = 'CLOSED';
      if (connectionId) broker.unregister(connectionId, ws);
      if (wasReady) logger.info(`[harness] browser disconnected (${connectionId})`);
    });
    ws.on('error', () => {
      // 'close' follows; never log payloads or URLs here
    });
  });

  server.on('error', (err) => logger.error('[harness] server error', err));
  logger.info(`[harness] negotiated endpoint on ws://${host}:${options.port}${HARNESS_WS_PATH}${isAuthEnabled() ? '' : ' (NO TOKEN)'}`);

  const listening = new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  return {
    server,
    broker,
    listening,
    port() {
      const addr = server.address();
      return typeof addr === 'object' && addr ? addr.port : options.port;
    },
    async close() {
      clearInterval(idleTimer);
      broker.closeAll();
      for (const ws of sockets) ws.close(1001, 'server closing');
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

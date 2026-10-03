/**
 * Per-session browser broker for the NEGOTIATED endpoint (/ws/harness).
 *
 * The legacy ConnectionRegistry resolves a global "last used" browser and correlates replies by request id only.
 * Here the binding is per MCP session, selection is never inferred from activity, and a reply is accepted only
 * from the very socket (and generation) that owns the pending request.
 *
 * Pure bookkeeping: sockets are reached through `send`/`isOpen`, so it is testable without a network.
 */
import { randomUUID } from 'crypto';
import {
  ProtocolError,
  TOOL_CATALOG,
  serializeFrame,
  type ErrorCode,
  type SessionBinding,
  type ToolResult as WireToolResult,
} from '@agent-jake-browser/protocol';
import { logger } from './utils/logger.js';

export interface HarnessConnection {
  connectionId: string;
  browserId: string;
  house: string;
  label: string;
  /** Client hint. NEVER used for identity, replacement or continuity. */
  installationId: string;
  capabilities: string[];
  connectedAt: number;
  lastActiveAt: number;
  /** Monotonic per accepted socket. */
  generation: number;
  /** Actual transport handle, compared by reference. */
  socket: object;
  send(text: string): void;
  isOpen(): boolean;
}

export interface BrowserInfo {
  connectionId: string;
  browserId: string;
  house: string;
  label: string;
  connectedAt: number;
  lastActiveAt: number;
  selected: boolean;
}

export interface CallOptions {
  tabHandle?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type CallResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string } };

interface Binding extends SessionBinding {
  generation: number;
}

interface Pending {
  id: string;
  sessionId: string;
  connectionId: string;
  generation: number;
  house: string;
  socket: object;
  timer: NodeJS.Timeout;
  cleanupAbort?: () => void;
  resolve: (r: CallResult) => void;
  reject: (e: ProtocolError) => void;
}

/** Keys that carry routing identity and must never arrive inside tool args. */
const ROUTING_KEYS = ['sessionId', 'connectionId', 'browserId', 'house', 'tabHandle'] as const;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface SessionBrokerOptions {
  /** Which browsers a principal may see/use. Default: all (single trusted operator boundary). */
  authorize?: (principal: string | undefined, connection: HarnessConnection) => boolean;
  now?: () => number;
}

export class SessionBroker {
  private readonly connections = new Map<string, HarnessConnection>();
  private readonly bindings = new Map<string, Binding>();
  private readonly pending = new Map<string, Pending>();
  private generationCounter = 0;
  private readonly authorize: NonNullable<SessionBrokerOptions['authorize']>;
  private readonly now: () => number;
  private readonly toolIndex = new Map(TOOL_CATALOG.map((t) => [t.name, t]));

  constructor(options: SessionBrokerOptions = {}) {
    this.authorize = options.authorize ?? (() => true);
    this.now = options.now ?? Date.now;
  }

  /** Register a READY socket. A new socket with the same installationId never displaces a live one. */
  register(
    input: Omit<HarnessConnection, 'generation' | 'connectedAt' | 'lastActiveAt'>,
  ): HarnessConnection {
    this.generationCounter += 1;
    const at = this.now();
    const conn: HarnessConnection = { ...input, generation: this.generationCounter, connectedAt: at, lastActiveAt: at };
    this.connections.set(conn.connectionId, conn);
    return conn;
  }

  touch(connectionId: string): void {
    const conn = this.connections.get(connectionId);
    if (conn) conn.lastActiveAt = this.now();
  }

  get(connectionId: string): HarnessConnection | null {
    return this.connections.get(connectionId) ?? null;
  }

  /** Drop a socket (only if it is still the registered one) and fail what it owed. Bindings are kept: no fallback. */
  unregister(connectionId: string, socket: object): void {
    const conn = this.connections.get(connectionId);
    if (!conn || conn.socket !== socket) return;
    this.connections.delete(connectionId);
    for (const p of [...this.pending.values()]) {
      if (p.connectionId === connectionId) {
        this.settle(p, () => p.reject(new ProtocolError('browser_disconnected', 'the bound browser disconnected')));
      }
    }
  }

  private readyFor(principal: string | undefined): HarnessConnection[] {
    return [...this.connections.values()]
      .filter((c) => c.isOpen() && this.authorize(principal, c))
      .sort((a, b) => a.connectedAt - b.connectedAt || a.generation - b.generation);
  }

  /** Authorized READY browsers; `selected` is per session. */
  list(sessionId?: string, principal?: string): BrowserInfo[] {
    const bound = sessionId ? this.bindings.get(sessionId)?.connectionId : undefined;
    return this.readyFor(principal).map((c) => ({
      connectionId: c.connectionId,
      browserId: c.browserId,
      house: c.house,
      label: c.label,
      connectedAt: c.connectedAt,
      lastActiveAt: c.lastActiveAt,
      selected: c.connectionId === bound,
    }));
  }

  binding(sessionId: string): SessionBinding | null {
    const b = this.bindings.get(sessionId);
    return b ? { sessionId: b.sessionId, browserId: b.browserId, connectionId: b.connectionId, house: b.house } : null;
  }

  private inFlight(sessionId: string): number {
    let n = 0;
    for (const p of this.pending.values()) if (p.sessionId === sessionId) n += 1;
    return n;
  }

  private bindTo(sessionId: string, conn: HarnessConnection): Binding {
    const b: Binding = {
      sessionId,
      browserId: conn.browserId,
      connectionId: conn.connectionId,
      house: conn.house,
      generation: conn.generation,
    };
    this.bindings.set(sessionId, b);
    return b;
  }

  /** Explicit, persistent selection for THIS session. Unknown and unauthorized ids are indistinguishable. */
  select(sessionId: string, connectionId: string, principal?: string): SessionBinding {
    const conn = this.connections.get(connectionId);
    if (!conn || !conn.isOpen() || !this.authorize(principal, conn)) {
      throw new ProtocolError('browser_not_found', `no available browser connection "${connectionId.slice(0, 64)}"`);
    }
    const current = this.bindings.get(sessionId);
    if (current && current.connectionId === connectionId && current.generation === conn.generation) {
      return this.binding(sessionId)!;
    }
    if (this.inFlight(sessionId) > 0) {
      throw new ProtocolError('session_busy', 'calls are in flight on the current browser; wait before changing it');
    }
    if (current) this.sendSessionClose(sessionId, current);
    this.bindTo(sessionId, conn);
    return this.binding(sessionId)!;
  }

  /** Existing binding (must still be live) or atomic auto-bind: 0 unavailable / 1 bind / N selection required. */
  private resolve(sessionId: string, principal?: string): { binding: Binding; conn: HarnessConnection } {
    const existing = this.bindings.get(sessionId);
    if (existing) {
      const conn = this.connections.get(existing.connectionId);
      if (!conn || !conn.isOpen() || conn.generation !== existing.generation) {
        throw new ProtocolError('browser_disconnected', 'the browser bound to this session is disconnected');
      }
      return { binding: existing, conn };
    }
    const candidates = this.readyFor(principal);
    if (candidates.length === 0) throw new ProtocolError('browser_unavailable', 'no browser is connected');
    if (candidates.length > 1) {
      throw new ProtocolError(
        'browser_selection_required',
        `several browsers are connected (${candidates.map((c) => c.connectionId).join(', ')}); pass the "connection" argument`,
      );
    }
    return { binding: this.bindTo(sessionId, candidates[0]), conn: candidates[0] };
  }

  call(
    sessionId: string,
    tool: string,
    args: Record<string, unknown>,
    options: CallOptions & { principal?: string } = {},
  ): Promise<CallResult> {
    const descriptor = this.toolIndex.get(tool);
    if (!descriptor) return Promise.reject(new ProtocolError('invalid_message', `unknown tool "${tool.slice(0, 64)}"`));
    for (const key of ROUTING_KEYS) {
      if (key in args) {
        return Promise.reject(new ProtocolError('invalid_message', `argument "${key}" is a routing key and cannot be passed in args`));
      }
    }
    if (options.signal?.aborted) return Promise.reject(new ProtocolError('request_cancelled', 'request cancelled'));

    let resolved: { binding: Binding; conn: HarnessConnection };
    try {
      resolved = this.resolve(sessionId, options.principal);
    } catch (err) {
      return Promise.reject(err);
    }
    const { binding, conn } = resolved;
    if (descriptor.capability && !conn.capabilities.includes(descriptor.capability)) {
      return Promise.reject(new ProtocolError('capability_unavailable', `${tool} needs capability "${descriptor.capability}"`));
    }

    const id = randomUUID();
    let text: string;
    try {
      // Size is enforced before enqueue/send; nothing is registered yet, so nothing to clean.
      text = serializeFrame({
        type: 'tool_request',
        id,
        sessionId,
        connectionId: conn.connectionId,
        ...(options.tabHandle ? { tabHandle: options.tabHandle } : {}),
        tool,
        args,
      });
    } catch (err) {
      return Promise.reject(err);
    }

    return new Promise<CallResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        if (!p) return;
        this.settle(p, () => {
          this.sendCancel(conn, id, sessionId);
          reject(new ProtocolError('request_timeout', `${tool} timed out`));
        });
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      const entry: Pending = {
        id,
        sessionId,
        connectionId: conn.connectionId,
        generation: conn.generation,
        house: conn.house,
        socket: conn.socket,
        timer,
        resolve,
        reject,
      };
      if (options.signal) {
        const onAbort = () => {
          const p = this.pending.get(id);
          if (!p) return;
          this.settle(p, () => {
            this.sendCancel(conn, id, sessionId);
            reject(new ProtocolError('request_cancelled', `${tool} cancelled`));
          });
        };
        options.signal.addEventListener('abort', onAbort, { once: true });
        entry.cleanupAbort = () => options.signal!.removeEventListener('abort', onAbort);
      }
      // Insert BEFORE send so a synchronous reply cannot miss its entry.
      this.pending.set(id, entry);
      try {
        conn.send(text);
      } catch {
        this.settle(entry, () => reject(new ProtocolError('browser_disconnected', 'could not send to the bound browser')));
      }
      void binding;
    });
  }

  /**
   * A tool_result arrived on `socket`. Accepted only from the owning socket/generation with all expected ids;
   * anything else (wrong sender, duplicate, late, unknown) is discarded WITHOUT consuming a legitimate entry.
   */
  handleResult(socket: object, frame: WireToolResult): 'settled' | 'discarded' {
    const p = this.pending.get(frame.id);
    if (!p) return 'discarded';
    if (p.socket !== socket) {
      logger.warn('[harness] result from a socket that does not own the request: discarded');
      return 'discarded';
    }
    const conn = this.connections.get(p.connectionId);
    if (!conn || conn.generation !== p.generation) return 'discarded';
    if (frame.sessionId !== p.sessionId || frame.connectionId !== p.connectionId || frame.house !== p.house) {
      logger.warn('[harness] result with mismatched ids: discarded');
      return 'discarded';
    }
    this.settle(p, () => p.resolve(frame.ok ? { ok: true, data: frame.data } : { ok: false, error: frame.error! }));
    return 'settled';
  }

  /** Idempotent logical session end: fail its pending calls, tell the extension, forget the binding. */
  closeSession(sessionId: string): void {
    for (const p of [...this.pending.values()]) {
      if (p.sessionId === sessionId) this.settle(p, () => p.reject(new ProtocolError('session_closed', 'the MCP session was closed')));
    }
    const b = this.bindings.get(sessionId);
    if (b) {
      this.sendSessionClose(sessionId, b);
      this.bindings.delete(sessionId);
    }
  }

  closeAll(reason: ErrorCode = 'session_closed'): void {
    for (const p of [...this.pending.values()]) this.settle(p, () => p.reject(new ProtocolError(reason, 'broker closing')));
    this.bindings.clear();
    this.connections.clear();
  }

  pendingCount(): number {
    return this.pending.size;
  }

  private settle(p: Pending, action: () => void): void {
    if (this.pending.get(p.id) !== p) return;
    this.pending.delete(p.id);
    clearTimeout(p.timer);
    p.cleanupAbort?.();
    action();
  }

  private sendSessionClose(sessionId: string, b: Binding): void {
    const conn = this.connections.get(b.connectionId);
    if (!conn || !conn.isOpen() || conn.generation !== b.generation) return;
    try {
      conn.send(serializeFrame({ type: 'session_close', sessionId, connectionId: conn.connectionId }));
    } catch {
      // best effort: the extension caps stale contexts locally
    }
  }

  private sendCancel(conn: HarnessConnection, id: string, sessionId: string): void {
    if (!conn.isOpen()) return;
    try {
      conn.send(serializeFrame({ type: 'request_cancel', id, sessionId, connectionId: conn.connectionId }));
    } catch {
      // best effort; cancellation never proves the action did not run
    }
  }
}

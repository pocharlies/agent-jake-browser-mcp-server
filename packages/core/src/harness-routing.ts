/**
 * Adapter between the MCP tool handlers (which speak `Context.send`) and the negotiated broker.
 * Tool code stays untouched; identity (session, principal) comes from the verified transport, never from args.
 */
import { ProtocolError } from '@agent-jake-browser/protocol';
import type { BrowserConnectionInfo, Context, ExtensionResponse, Tool, ToolName, ToolResult } from './types.js';
import type { HarnessServer } from './harness-server.js';
import { randomUUID } from 'crypto';

export interface HarnessCall {
  sessionId: string;
  principal?: string;
  signal?: AbortSignal;
}

function connectionInfos(harness: HarnessServer, sessionId: string, principal?: string): BrowserConnectionInfo[] {
  const now = Date.now();
  return harness.broker.list(sessionId, principal).map((b) => ({
    connectionId: b.connectionId,
    label: b.label,
    userAgent: '',
    connectedAt: b.connectedAt,
    lastActiveAt: b.lastActiveAt,
    open: true,
    active: b.selected,
    secondsSinceLastActivity: Math.max(0, Math.round((now - b.lastActiveAt) / 1000)),
  }));
}

export function harnessContext(harness: HarnessServer, call: HarnessCall): Context {
  return {
    async send(type: ToolName, payload: Record<string, unknown> = {}): Promise<ExtensionResponse> {
      const r = await harness.broker.call(call.sessionId, type, payload, { principal: call.principal, signal: call.signal });
      const id = randomUUID();
      return r.ok ? { id, success: true, result: r.data } : { id, success: false, error: r.error };
    },
    isConnected: () => harness.broker.list(call.sessionId, call.principal).length > 0,
    listConnections: () => connectionInfos(harness, call.sessionId, call.principal),
  };
}

const text = (message: string, isError = false): ToolResult => ({
  content: [{ type: 'text', text: message }],
  ...(isError ? { isError: true } : {}),
});

/** Run one MCP tool call against the session's bound browser. Stable error codes are visible in the text. */
export async function callToolViaHarness(
  harness: HarnessServer,
  tool: Tool | undefined,
  name: string,
  rawArgs: Record<string, unknown> | undefined,
  call: HarnessCall,
): Promise<ToolResult> {
  if (!tool) return text(`Unknown tool: ${name}`, true);
  const args = { ...(rawArgs ?? {}) };
  const connection = typeof args.connection === 'string' && args.connection.trim() ? args.connection.trim() : undefined;
  // `connection` selects the browser for this session and never reaches the extension.
  delete args.connection;
  try {
    if (connection) harness.broker.select(call.sessionId, connection, call.principal);
    return await tool.handle(harnessContext(harness, call), args);
  } catch (err) {
    if (err instanceof ProtocolError) return text(`${err.code}: ${err.message}`, true);
    return text(`Error: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

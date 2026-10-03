/**
 * MCP Server setup and request handlers.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createContext, type ContextManager } from './context.js';
import { getAllTools } from './tools/index.js';
import { logger } from './utils/logger.js';
import { randomUUID } from 'crypto';
import { createHarnessServer, type HarnessServer, type HarnessServerOptions } from './harness-server.js';
import { callToolViaHarness } from './harness-routing.js';
import type { Tool, ToolResult } from './types.js';

export interface ServerOptions {
  port: number;
  /** Negotiated endpoint (opt-in). Stdio gets one internal session UUID; it never accepts a client-supplied identity. */
  harness?: HarnessServerOptions;
}

export interface MCPServer {
  server: Server;
  context: ContextManager;
  close(): Promise<void>;
}

/**
 * Create and configure the MCP server.
 */
export async function createServer(options: ServerOptions): Promise<MCPServer> {
  const { port } = options;

  // Create context for WebSocket communication
  const context = createContext({ port });
  const harness: HarnessServer | undefined = options.harness ? createHarnessServer(options.harness) : undefined;
  const stdioSessionId = randomUUID();

  // Get all available tools
  const tools = getAllTools();
  const toolMap = new Map<string, Tool>();
  for (const tool of tools) {
    toolMap.set(tool.schema.name, tool);
  }

  // Create MCP server
  const server = new Server(
    {
      name: 'agent-jake-browser-mcp',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Handle tools/list request
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    logger.debug('Handling tools/list request');
    return {
      tools: tools.map(t => t.schema),
    };
  });

  // Handle tools/call request
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: rawArgs } = request.params;
    if (harness) {
      return (await callToolViaHarness(harness, toolMap.get(name), name, rawArgs as Record<string, unknown> | undefined, {
        sessionId: stdioSessionId,
        signal: extra.signal,
      })) as any;
    }
    const args = { ...(rawArgs ?? {}) } as Record<string, unknown>;
    // `connection` selects the browser and never reaches the extension.
    const connection =
      typeof args.connection === 'string' && args.connection.trim() ? args.connection.trim() : undefined;
    delete args.connection;
    const tool = toolMap.get(name);
    if (!tool) {
      logger.error('Unknown tool requested');
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    logger.info(`Calling tool: ${tool.schema.name}`);

    try {
      // Server-side tools answer without a browser
      if (tool.serverSide) {
        return (await tool.handle(context, args)) as any;
      }

      if (connection && !context.isConnected(connection)) {
        const open = context.listConnections().map((c) => c.connectionId).join(', ') || 'none';
        logger.warn('Requested browser connection is not available');
        return {
          content: [
            {
              type: 'text',
              text: `No browser connection with id "${connection}" (open: ${open}). Call browser_list_connections to see the current ones.`,
            },
          ],
          isError: true,
        };
      }

      // Check if connected
      if (!context.isConnected(connection)) {
        logger.warn('Extension not connected, waiting...');
        try {
          await context.waitForConnection(10000);
        } catch {
          return {
            content: [{
              type: 'text',
              text: 'Extension not connected. Please ensure the Chrome extension is running and connected.',
            }],
            isError: true,
          };
        }
      }

      return (await tool.handle(context.forConnection(connection), args)) as any;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Tool error: ${name}`);
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  logger.info('MCP server created');

  return {
    server,
    context,

    async close(): Promise<void> {
      harness?.broker.closeSession(stdioSessionId);
      await harness?.close();
      await context.close();
      await server.close();
      logger.info('MCP server closed');
    },
  };
}

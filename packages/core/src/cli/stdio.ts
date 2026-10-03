/**
 * CLI entry point for the Agent Jake Browser MCP Server.
 */
import { program } from 'commander';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from '../server.js';
import { logger, setLogLevel } from '../utils/logger.js';
import { isPortAvailable, killProcessOnPort, waitForPort } from '../utils/port.js';

const DEFAULT_PORT = 8765;

/**
 * Setup exit watchdog to handle parent process termination.
 */
function setupExitWatchdog(): void {
  // Check if parent process is still alive
  const checkParent = () => {
    try {
      // Sending signal 0 checks if the process exists
      process.kill(process.ppid, 0);
    } catch {
      // Parent process is gone, exit
      logger.info('Parent process terminated, exiting...');
      process.exit(0);
    }
  };

  // Check every 1 second for faster cleanup when parent exits
  setInterval(checkParent, 1000);

  // Handle termination signals
  process.on('SIGINT', () => {
    logger.info('Received SIGINT, exiting...');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logger.info('Received SIGTERM, exiting...');
    process.exit(0);
  });
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  program
    .name('agent-jake-browser-mcp')
    .description('MCP server for browser automation via Chrome extension')
    .version('1.0.0')
    .option('-p, --port <number>', 'WebSocket port for extension connection', String(DEFAULT_PORT))
    .option('-v, --verbose', 'Enable verbose logging')
    .option('--kill-existing', 'Kill any existing process on the port')
    .action(async (options) => {
      const port = parseInt(options.port, 10);

      if (options.verbose) {
        setLogLevel('debug');
      }

      logger.info(`Starting Agent Jake Browser MCP Server on port ${port}`);

      // Check if port is available
      const portAvailable = await isPortAvailable(port);
      if (!portAvailable) {
        if (options.killExisting) {
          logger.warn(`Port ${port} in use, killing existing process...`);
          const killed = await killProcessOnPort(port);
          if (!killed) {
            logger.error(`Failed to kill process on port ${port}`);
            process.exit(1);
          }

          // Wait for port to be released by kernel
          const portFreed = await waitForPort(port, 3000);
          if (!portFreed) {
            logger.error(`Port ${port} still in use after killing process`);
            process.exit(1);
          }
          logger.info(`Port ${port} is now available`);
        } else {
          logger.error(`Port ${port} is already in use. Use --kill-existing to terminate the existing process.`);
          process.exit(1);
        }
      }

      // Create MCP server
      const harnessPort = process.env.BROWSER_HARNESS_PORT ? Number(process.env.BROWSER_HARNESS_PORT) : undefined;
      const mcpServer = await createServer({
        port,
        ...(harnessPort ? { harness: { port: harnessPort, house: process.env.BROWSER_HARNESS_HOUSE } } : {}),
      });

      // Setup exit watchdog
      setupExitWatchdog();

      // Handle cleanup on exit
      process.on('exit', () => {
        mcpServer.close().catch(() => {});
      });

      // Connect to stdio transport
      const transport = new StdioServerTransport();
      await mcpServer.server.connect(transport);

      logger.info('MCP server connected to stdio transport');
      logger.info('Waiting for Chrome extension to connect...');
    });

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  logger.error('Fatal error', err);
  process.exit(1);
});

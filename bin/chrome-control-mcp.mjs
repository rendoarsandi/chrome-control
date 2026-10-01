#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readConfig } from '../src/config.mjs';
import { createServer } from '../src/server.mjs';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`chrome-control-mcp v2 — local Chrome browser tools over MCP stdio

Usage: chrome-control-mcp [--stdio]
       node /absolute/path/chrome-control/bin/chrome-control-mcp.mjs

Register this command in your MCP client; do not run it as an interactive REPL.
No Gemini, OpenAI or Anthropic API key is required by this server.

Configuration:
  CHROME_CDP_URL             Default: http://127.0.0.1:9222
  CHROME_AUTO_ADB            1 (default) or 0 to disable Android recovery
  ANDROID_SERIAL            Explicit ADB device when multiple devices exist
  CHROME_ANDROID_PACKAGE    Default: com.android.chrome
  CHROME_DEVTOOLS_SOCKET    Default: chrome_devtools_remote
  CHROME_ACTION_TIMEOUT_MS  Default: 8000
  CHROME_REQUEST_TIMEOUT_MS Default: 30000

See README.md for Termux setup and Codex/Claude Code/client configuration.`);
} else if (args.some(arg => arg !== '--stdio')) {
  console.error('Unknown option. v2 is an MCP server; use --help for migration instructions.');
  process.exitCode = 1;
} else {
  try {
    const config = readConfig();
    // Termux reports "android". Playwright's CDP client can run there, but its
    // package checks expect a supported desktop platform. No browser is launched.
    if (process.platform === 'android') Object.defineProperty(process, 'platform', { value: 'linux' });
    const { chromium } = await import('playwright-core');
    const app = createServer(chromium, config);
    await app.server.connect(new StdioServerTransport());
    let closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      const timer = setTimeout(() => process.exit(0), 2000);
      timer.unref();
      await app.close().catch(error => console.error(error.message));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.stdin.on('end', shutdown);
  } catch (error) {
    console.error(`chrome-control-mcp: ${error.message}`);
    process.exitCode = 1;
  }
}

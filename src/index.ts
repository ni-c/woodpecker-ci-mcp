#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { loadConfig, missingConfigKeys } from './config.js';
import { createServer } from './server.js';
import { ToolFilterError } from 'mcp-tool-allowlist';

async function main(): Promise<void> {
  const config = loadConfig();

  if (config.insecureTls) {
    console.error(
      'woodpecker-ci-mcp: WOODPECKER_INSECURE_TLS=true — TLS certificate validation is disabled for the Woodpecker connection'
    );
  }
  if (config.readOnly) {
    console.error(
      'woodpecker-ci-mcp: WOODPECKER_READ_ONLY=true — write tools are not registered'
    );
  }
  // Printed only when it is off, like the line above. ELICITATION is
  // unprefixed, so one `export ELICITATION=false` reaches every MCP server in
  // the environment — this line is what makes that visible in the log of each
  // one it actually reached.
  if (!config.elicitation) {
    console.error(
      'woodpecker-ci-mcp: ELICITATION=false — guarded tools fall back to the two-call token'
    );
  }

  let server;
  try {
    server = createServer(config);
  } catch (error) {
    // A bad tool list is operator feedback, not a crash: print the sentence on
    // its own rather than behind "fatal error:" with a stack after it.
    if (error instanceof ToolFilterError) {
      console.error(`woodpecker-ci-mcp: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  // stdout belongs to the protocol; everything human-readable goes to stderr.
  await server.connect(new StdioServerTransport());
  console.error(
    missingConfigKeys(config).length === 0
      ? `woodpecker-ci-mcp: connected, targeting ${config.url}`
      : 'woodpecker-ci-mcp: connected without a complete configuration — tools are listed, but every call will fail until WOODPECKER_URL and WOODPECKER_TOKEN are set'
  );
}

// In a container node runs as PID 1 with no default signal disposition, so
// without this handler `docker stop` waits out the grace period and SIGKILLs.
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

main().catch((error: unknown) => {
  // The message and the stack, not the error object. Printing the object walks
  // its `cause` chain, and the causes here are undici request errors that carry
  // the request they failed on — headers included. The token is out of the
  // environment by this point but still lives in the config, and a crash report
  // is the one place nobody thinks to look for it.
  if (error instanceof Error) {
    console.error(`woodpecker-ci-mcp: fatal error: ${error.message}`);
    if (error.stack !== undefined) console.error(error.stack);
  } else {
    console.error(`woodpecker-ci-mcp: fatal error: ${String(error)}`);
  }
  process.exit(1);
});

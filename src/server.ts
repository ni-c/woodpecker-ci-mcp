import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/server';

import { WoodpeckerApi } from './api.js';
import type { Config } from './config.js';
import { ConfirmationStore } from './confirm.js';
import { buildToolFilter, installToolFilter } from './tool-filter.js';
import { registerAccountTools } from './tools/account.js';
import { registerAgentTools } from './tools/agents.js';
import type { ToolContext } from './tools/context.js';
import { registerCronTools } from './tools/crons.js';
import { registerForgeTools } from './tools/forges.js';
import { registerLogTools } from './tools/logs.js';
import { registerOrgTools } from './tools/orgs.js';
import { registerPipelineTools } from './tools/pipelines.js';
import { registerRegistryTools } from './tools/registries.js';
import { registerRepoTools } from './tools/repos.js';
import { registerSecretTools } from './tools/secrets.js';
import { registerServerTools } from './tools/server-admin.js';
import { registerUserTools } from './tools/users.js';

function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

/**
 * The modules, in the order their tools appear in the catalogue.
 *
 * Each one registers its own read tools and, unless `readOnly`, its write tools:
 * the split is by subject rather than by direction, because `list_secrets` and
 * `create_secret` share a scope parameter and a path builder, and separating
 * them by hundreds of lines is how the two drift apart.
 */
const MODULES = [
  registerRepoTools,
  registerPipelineTools,
  registerLogTools,
  registerSecretTools,
  registerRegistryTools,
  registerCronTools,
  registerOrgTools,
  registerAccountTools,
  registerUserTools,
  registerAgentTools,
  registerForgeTools,
  registerServerTools,
];

export function createServer(config: Config): McpServer {
  // Before anything is built: an unusable tool list should fail on the way in,
  // not leave a server running with tools quietly missing.
  const filter = buildToolFilter(config);

  const context: ToolContext = {
    api: new WoodpeckerApi(config),
    confirmations: new ConfirmationStore(),
    readOnly: config.readOnly,
  };

  const server = new McpServer({
    name: 'woodpecker-ci-mcp',
    version: packageVersion(),
  });

  // Wraps server.registerTool, so it has to sit before the first register call
  // and it does not care how the register functions are organised.
  installToolFilter(server, filter);

  for (const register of MODULES) register(server, context);

  return server;
}

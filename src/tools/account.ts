import type { McpServer } from '@modelcontextprotocol/server';
import {
  listOf,
  objectOf,
  summarizePipeline,
  summarizeUser,
} from '../normalize.js';
import { z } from 'zod';
import { marked, plain } from '../output-schema.js';

import { budgetedUntrustedResult, jsonResult, run } from '../result.js';
import { READ_ONLY } from './annotations.js';
import type { ToolContext } from './context.js';

/**
 * The authenticated account.
 *
 * Deliberately does NOT include `POST /user/token` or `DELETE /user/token`.
 * Those return and rotate the personal access token of the account this server
 * authenticates as — a tool that hands the model its own credential, and one
 * that invalidates the server's own configuration mid-session. Neither belongs
 * on an MCP surface; the Woodpecker UI does both, in front of a person.
 */
export function registerAccountTools(
  server: McpServer,
  { api }: ToolContext
): void {
  server.registerTool(
    'get_current_user',
    {
      title: 'Get the authenticated account',
      description:
        'Returns the account WOODPECKER_TOKEN belongs to, including whether it is ' +
        'an instance administrator. This is the first thing to call when a tool ' +
        'answers 403: the admin-only tools need admin=true here.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
      outputSchema: plain(),
    },
    async () =>
      run(async () =>
        jsonResult(summarizeUser(objectOf(await api.get('/user'), 'user')))
      )
  );

  server.registerTool(
    'get_pipeline_feed',
    {
      title: 'Get the pipeline feed',
      description:
        'The activity feed of the authenticated account: the latest pipeline of ' +
        'every repository it can see, newest first. This is the "what is the state ' +
        'of everything" call — one request instead of list_pipelines per repository.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
      outputSchema: marked(),
    },
    async () =>
      run(async () => {
        const feed = listOf(await api.get('/user/feed'), 'feed entries');
        return budgetedUntrustedResult({
          feed: feed.map((entry) => ({
            repo_id: entry.repo_id,
            full_name: entry.full_name,
            ...summarizePipeline(entry),
          })),
        });
      })
  );
}

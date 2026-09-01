import { z } from 'zod';
import type { McpServer, CallToolResult } from '@modelcontextprotocol/server';

import { guarded } from '../guard.js';
import { jsonResult, run, textResult } from '../result.js';
import { confirmTokenParam } from '../schema.js';
import type { ToolContext } from './context.js';

/**
 * Server state: version, health, queue and log level.
 *
 * `/version` and `/healthz` are the two endpoints that live **outside** the
 * `/api` prefix. The Swagger document lists both under `basePath: "/api"`, but
 * the server registers them one level up — `GET /api/version` falls through to
 * the single-page app and returns the web UI with HTTP 200. Verified against
 * 3.18.0; `api.get(..., { root: true })` is what gets it right.
 */
export function registerServerTools(
  server: McpServer,
  { api, confirmations, approval, readOnly }: ToolContext
): void {
  server.registerTool(
    'get_server_info',
    {
      title: 'Get server version and health',
      description:
        'Returns the Woodpecker version and whether the server reports itself ' +
        'healthy. Works without a token, which makes it the call to use when ' +
        'nothing else does: if this answers, WOODPECKER_URL is right and the ' +
        'problem is WOODPECKER_TOKEN.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () =>
      run(async () => {
        const version = await api.get('/version', {
          root: true,
          anonymous: true,
        });
        // /healthz answers 204 with an empty body when healthy, so there is
        // nothing to parse — reaching this line at all is the result.
        let healthy = true;
        try {
          await api.get('/healthz', { root: true, anonymous: true });
        } catch {
          healthy = false;
        }
        return jsonResult({
          server: api.serverRoot,
          version,
          healthy,
        });
      })
  );

  server.registerTool(
    'get_queue_info',
    {
      title: 'Get queue information',
      description:
        'The server-side build queue: what is pending, running and waiting on an ' +
        'agent, plus the agent statistics. Admin only. Together with ' +
        'list_queued_pipelines this is the whole answer to "why is my build not ' +
        'starting".',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => run(async () => jsonResult(await api.get('/queue/info')))
  );

  server.registerTool(
    'get_log_level',
    {
      title: 'Get the server log level',
      description:
        'Returns the current log level of the Woodpecker server. Admin only.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => run(async () => jsonResult(await api.get('/log-level')))
  );

  if (readOnly) return;

  server.registerTool(
    'pause_queue',
    {
      title: 'Pause the build queue',
      description:
        'Stops the server from handing new work to agents. Running pipelines finish; ' +
        'everything else queues up. Admin only, and instance-wide — this stops CI ' +
        'for everybody, and it stays paused until someone calls resume_queue. ' +
        'Two-step.',
      inputSchema: z.object({ confirm_token: confirmTokenParam.optional() }),
      annotations: { idempotentHint: true },
    },
    async ({ confirm_token }, mcp) =>
      run(async () =>
        guarded(
          server,
          mcp,
          approval,
          confirmations,
          {
            tool: 'pause_queue',
            targets: ['queue'],
            what: 'pause the build queue of this whole Woodpecker instance',
            consequence:
              'No pipeline of any repository starts until resume_queue is called. ' +
              'Nothing announces this to the people whose builds are queuing.',
            confirmToken: confirm_token,
          },
          async () => {
            await api.post('/queue/pause');
            return textResult(
              'The queue is paused. Nothing new will be scheduled until resume_queue.'
            );
          }
        )
      )
  );

  server.registerTool(
    'resume_queue',
    {
      title: 'Resume the build queue',
      description:
        'Lets the server hand work to agents again. Admin only. Queued pipelines ' +
        'start at once, so expect a burst.',
      inputSchema: z.object({}),
      annotations: { idempotentHint: true },
    },
    async () =>
      run(async () => {
        await api.post('/queue/resume');
        return textResult('The queue is running again.');
      })
  );

  server.registerTool(
    'set_log_level',
    {
      title: 'Set the server log level',
      description:
        'Changes the log level of the running Woodpecker server, without a restart. ' +
        'Admin only. "debug" and "trace" are loud — set it back when you are done, ' +
        'and remember that trace logs request bodies.',
      inputSchema: z.object({
        level: z
          .enum([
            'trace',
            'debug',
            'info',
            'warn',
            'error',
            'fatal',
            'panic',
            'disabled',
          ])
          .describe(
            'The new log level. The default is "info". "disabled" turns server ' +
              'logging off entirely — including the records of what happened next. ' +
              'Lowering it below "warn" needs a confirm_token.'
          ),
        confirm_token: confirmTokenParam
          .optional()
          .describe(
            'Required only for the levels that suppress records — fatal, panic ' +
              'and disabled.'
          ),
      }),
    },
    async ({ level, confirm_token }, mcp) =>
      run(async () => {
        const apply = async (): Promise<CallToolResult> =>
          jsonResult(await api.post('/log-level', { 'log-level': level }));

        // Turning the logs up is how someone debugs; turning them off is how
        // someone stops the instance recording what happens next. Only the
        // second direction stops for a confirmation — an audit trail that can
        // be disabled by a single tool call is not one.
        const silencing = ['fatal', 'panic', 'disabled'];
        if (!silencing.includes(level)) return apply();

        return guarded(
          server,
          mcp,
          approval,
          confirmations,
          {
            tool: 'set_log_level',
            targets: [level],
            what: `set the server log level to ${level}`,
            consequence:
              'The server stops recording warnings and errors, so whatever ' +
              'happens next leaves no trace in its log.',
            confirmToken: confirm_token,
          },
          apply
        );
      })
  );
}

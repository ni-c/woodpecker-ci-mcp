import { z } from 'zod';
import { plain } from '../output-schema.js';
import type { McpServer, CallToolResult } from '@modelcontextprotocol/server';

import { guarded } from '../guard.js';
import { READ_ONLY } from './annotations.js';
import { jsonResult, run, sentenceResult } from '../result.js';
import { confirmTokenParam } from '../schema.js';
import { DEFAULT_API_PREFIX } from '../config.js';
import {
  UnexpectedContentTypeError,
  WoodpeckerApiError,
  type WoodpeckerApi,
} from '../api.js';
import type { ToolContext } from './context.js';

const CROW_DOCS =
  'https://woodpecker-ci-mcp.ni-c.de/guide/configuration#crow-ci';

/** A fixed hint when `/version` names Crow CI as its source; never upstream text. */
export function serverNote(
  version: unknown,
  apiPrefix: string
): string | undefined {
  if (typeof version !== 'object' || version === null) return undefined;
  const { source, version: number } = version as Record<string, unknown>;
  if (
    typeof source !== 'string' ||
    !/\/crowci\/crow(?:[/.?#]|$)/i.test(source)
  ) {
    return undefined;
  }
  if (apiPrefix === DEFAULT_API_PREFIX && servesVersionedApi(number)) {
    return (
      'This is Crow CI, which serves its API under /api/v1 since 5.0. Set ' +
      'WOODPECKER_API_PREFIX=/api/v1 — until then every other tool answers ' +
      `with the web UI instead of the API. See ${CROW_DOCS}.`
    );
  }
  return (
    'This is Crow CI, a Woodpecker fork, not Woodpecker itself. This server ' +
    'speaks the Woodpecker 3 API, and against Crow 6.10.0 some writes differ: ' +
    'Crow silently ignores update_cron enabled, the cron timezone, the ' +
    'trigger_pipeline message and the forge oauth_client_secret; update_agent ' +
    'always fails; create_user needs an email and update_forge a type and url; ' +
    'move_repository answers HTTP 500 after it has already moved the ' +
    `repository. Read back what a write changed. See ${CROW_DOCS}.`
  );
}

/** Root first; under the API prefix only when the root route is gone (Woodpecker 4). */
async function rootOrPrefixed(
  api: WoodpeckerApi,
  path: string
): Promise<unknown> {
  try {
    return await api.get(path, { root: true, anonymous: true });
  } catch (error) {
    const gone =
      error instanceof UnexpectedContentTypeError ||
      (error instanceof WoodpeckerApiError && error.status === 404);
    if (!gone) throw error;
    return api.get(path, { anonymous: true });
  }
}

function servesVersionedApi(version: unknown): boolean {
  if (typeof version !== 'string') return false;
  if (version.startsWith('dev-')) return true;
  const major = /^v?(\d+)\./.exec(version);
  return major !== null && Number(major[1]) >= 5;
}

/**
 * Server state: version, health, queue and log level.
 *
 * `/version` and `/healthz` are the two endpoints that live **outside** the
 * API prefix (`/api`, or `WOODPECKER_API_PREFIX`). The Swagger document lists
 * both under `basePath: "/api"`, but the server registers them one level up — `GET /api/version` falls through to
 * the single-page app and returns the web UI with HTTP 200. Verified against
 * 3.18.0; `api.get(..., { root: true })` is what gets it right. 3.19 serves
 * both under `/api` as well and 4.0 drops the root routes, hence the fallback.
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
      annotations: READ_ONLY,
      outputSchema: plain({
        note: z
          .string()
          .optional()
          .describe('Present only when the server is Crow CI.'),
      }),
    },
    async () =>
      run(async () => {
        const version = await rootOrPrefixed(api, '/version');
        // /healthz answers 204 with an empty body when healthy, so there is
        // nothing to parse — reaching this line at all is the result.
        let healthy = true;
        try {
          await rootOrPrefixed(api, '/healthz');
        } catch {
          healthy = false;
        }
        const note = serverNote(version, api.apiPrefix);
        return jsonResult({
          server: api.serverRoot,
          version,
          healthy,
          ...(note === undefined ? {} : { note }),
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
      annotations: READ_ONLY,
      outputSchema: plain(),
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
      annotations: READ_ONLY,
      outputSchema: plain(),
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
      annotations: {
        // A state, not content. Nothing is lost — but nothing starts
        // either, and nobody is told, which is why it is guarded.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      outputSchema: plain(),
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
            return sentenceResult(
              'The queue is paused. Nothing new will be scheduled until resume_queue.',
              { queue_paused: true }
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
      annotations: {
        // Restores service.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      outputSchema: plain(),
    },
    async () =>
      run(async () => {
        await api.post('/queue/resume');
        return sentenceResult('The queue is running again.', {
          queue_paused: false,
        });
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
      annotations: {
        // A setting, not content. Silencing it hides warnings and errors,
        // which is why that direction is guarded — but nothing is lost.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      outputSchema: plain(),
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
            targets: [`level:${level}`],
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

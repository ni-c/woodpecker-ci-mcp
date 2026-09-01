import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  DEFAULT_LOG_LINES,
  decodeLog,
  logNote,
  type LogEntry,
} from '../logs.js';
import {
  confirmTokenParam,
  pipelineNumberParam,
  repoIdParam,
  stepIdParam,
} from '../schema.js';

import { guarded } from '../guard.js';
import { READ_ONLY } from './annotations.js';
import { listOf } from '../normalize.js';
import { run, textResult, untrustedResult } from '../result.js';
import type { ToolContext } from './context.js';

export function registerLogTools(
  server: McpServer,
  { api, confirmations, approval, readOnly }: ToolContext
): void {
  server.registerTool(
    'get_step_logs',
    {
      title: 'Get step logs',
      description:
        'Returns the output of one pipeline step as text, newest end first by ' +
        'default — a failing step almost always explains itself in its last lines. ' +
        'The step id comes from get_pipeline (workflows[].steps[].id). Woodpecker ' +
        'returns these lines base64-encoded; this tool decodes and reassembles them.',
      inputSchema: z.object({
        repo_id: repoIdParam,
        number: pipelineNumberParam,
        step_id: stepIdParam,
        limit: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .optional()
          .describe(
            `Number of output lines to return. Default ${DEFAULT_LOG_LINES}.`
          ),
        from: z
          .enum(['head', 'tail'])
          .optional()
          .describe(
            'Which end to read. Default "tail" — the end of the log, where the ' +
              'error is. Use "head" to see how a step started.'
          ),
      }),
      annotations: READ_ONLY,
    },
    async ({ repo_id, number, step_id, limit, from }) =>
      run(async () => {
        const entries = listOf(
          await api.get(`/repos/${repo_id}/logs/${number}/${step_id}`),
          'log entries'
        ) as LogEntry[];

        const log = decodeLog(entries, {
          limit: limit ?? DEFAULT_LOG_LINES,
          from: from ?? 'tail',
        });
        const note = logNote(log);

        const header = [
          `Step ${step_id} of pipeline ${number}, repository ${repo_id}.`,
          log.exitCode !== undefined
            ? `Exit code: ${log.exitCode}.`
            : undefined,
          note,
        ]
          .filter(Boolean)
          .join(' ');

        return untrustedResult(
          `${header}\n\n${log.text || '(the step produced no output)'}`
        );
      })
  );

  if (readOnly) return;

  server.registerTool(
    'delete_step_logs',
    {
      title: 'Delete the logs of one step',
      description:
        'Deletes the stored output of a single step. The step and the pipeline stay, ' +
        'their logs do not. This is what you use when a step printed a secret. ' +
        'Two-step. Rotate the leaked credential as well — the log was readable ' +
        'until now, and deleting it does not un-read it.',
      inputSchema: z.object({
        repo_id: repoIdParam,
        number: pipelineNumberParam,
        step_id: stepIdParam,
        confirm_token: confirmTokenParam.optional(),
      }),
      annotations: {
        // Idempotent by the specification's wording — "no additional effect
        // on its environment". The second call fails, but the world is the
        // same either way, which is what lets a caller retry after a timeout.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ repo_id, number, step_id, confirm_token }, mcp) =>
      run(async () =>
        guarded(
          server,
          mcp,
          approval,
          confirmations,
          {
            tool: 'delete_step_logs',
            targets: [String(repo_id), String(number), String(step_id)],
            what: `delete the logs of step ${step_id} in pipeline ${number}`,
            consequence:
              'The output of that step is gone and cannot be restored.',
            confirmToken: confirm_token,
          },
          async () => {
            await api.delete(`/repos/${repo_id}/logs/${number}/${step_id}`);
            return textResult(
              `Logs of step ${step_id} in pipeline ${number} were deleted.`
            );
          }
        )
      )
  );

  server.registerTool(
    'delete_pipeline_logs',
    {
      title: 'Delete all logs of a pipeline',
      description:
        'Deletes the stored output of every step of a pipeline. The pipeline and its ' +
        'step results stay, so it still shows which step failed — just not why. ' +
        'Two-step.',
      inputSchema: z.object({
        repo_id: repoIdParam,
        number: pipelineNumberParam,
        confirm_token: confirmTokenParam.optional(),
      }),
      annotations: {
        // Idempotent by the specification's wording — "no additional effect
        // on its environment". The second call fails, but the world is the
        // same either way, which is what lets a caller retry after a timeout.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ repo_id, number, confirm_token }, mcp) =>
      run(async () =>
        guarded(
          server,
          mcp,
          approval,
          confirmations,
          {
            tool: 'delete_pipeline_logs',
            targets: [String(repo_id), String(number)],
            what: `delete every step log of pipeline ${number} in repository ${repo_id}`,
            consequence:
              'The output of all its steps is gone and cannot be restored.',
            confirmToken: confirm_token,
          },
          async () => {
            await api.delete(`/repos/${repo_id}/logs/${number}`);
            return textResult(`All logs of pipeline ${number} were deleted.`);
          }
        )
      )
  );
}

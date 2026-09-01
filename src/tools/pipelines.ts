import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  listOf,
  objectOf,
  summarizePipeline,
  summarizeWorkflows,
} from '../normalize.js';
import {
  budgetedList,
  budgetedUntrustedResult,
  run,
  textResult,
} from '../result.js';
import {
  branchParam,
  confirmTokenParam,
  pageParam,
  perPageParam,
  pipelineNumberParam,
  pipelineStatusParam,
  repoIdParam,
  variablesParam,
  webhookEventParam,
} from '../schema.js';

import { query } from '../api.js';
import { guarded } from '../guard.js';
import { stripControlCharacters } from '../logs.js';
import type { ToolContext } from './context.js';

export function registerPipelineTools(
  server: McpServer,
  { api, confirmations, approval, readOnly }: ToolContext
): void {
  server.registerTool(
    'list_pipelines',
    {
      title: 'List pipelines',
      description:
        "Lists a repository's pipelines, newest first, summarised to what a list " +
        'needs. Filters are applied by the server. Note that "number" — not the ' +
        'pipeline id — is what every other pipeline tool takes.',
      inputSchema: z.object({
        repo_id: repoIdParam,
        branch: branchParam
          .optional()
          .describe('Only pipelines for this branch.'),
        event: webhookEventParam
          .optional()
          .describe('Only pipelines started by this event.'),
        status: pipelineStatusParam.optional(),
        ref: z
          .string()
          .trim()
          .min(1)
          .max(250)
          .optional()
          .describe('Only pipelines for this git ref, e.g. "refs/heads/main".'),
        before: z
          .string()
          .trim()
          .datetime()
          .optional()
          .describe('Only pipelines created before this RFC 3339 timestamp.'),
        after: z
          .string()
          .trim()
          .datetime()
          .optional()
          .describe('Only pipelines created after this RFC 3339 timestamp.'),
        page: pageParam.optional(),
        per_page: perPageParam.optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ repo_id, page, per_page, ...filters }) =>
      run(async () => {
        const pipelines = await api.get(
          `/repos/${repo_id}/pipelines${query({
            ...filters,
            page,
            perPage: per_page,
          })}`
        );
        return budgetedUntrustedResult({
          pipelines: listOf(pipelines, 'pipelines').map(summarizePipeline),
        });
      })
  );

  server.registerTool(
    'get_pipeline',
    {
      title: 'Get pipeline',
      description:
        'Returns one pipeline with its workflows and steps, including each step id ' +
        '— which is what get_step_logs needs. Step state and exit_code say which ' +
        'step to look at.',
      inputSchema: z.object({
        repo_id: repoIdParam,
        number: pipelineNumberParam,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ repo_id, number }) =>
      run(async () => {
        const pipeline = objectOf(
          await api.get(`/repos/${repo_id}/pipelines/${number}`),
          'pipeline'
        );
        return budgetedUntrustedResult({
          pipeline: summarizePipeline(pipeline),
          workflows: summarizeWorkflows(pipeline),
        });
      })
  );

  server.registerTool(
    'get_pipeline_config',
    {
      title: 'Get pipeline configuration',
      description:
        'Returns the pipeline YAML files this run was built from, as they were at ' +
        'that commit. This is the config that actually ran, not the one currently ' +
        'in the branch.',
      inputSchema: z.object({
        repo_id: repoIdParam,
        number: pipelineNumberParam,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ repo_id, number }) =>
      run(async () => {
        const configs = listOf(
          await api.get(`/repos/${repo_id}/pipelines/${number}/config`),
          'pipeline configs'
        );
        // `data` is the file content, base64 in the Go model's JSON. It is a
        // file from the repository, so it gets the same control-character
        // treatment as build output.
        const files = configs.map((config) => ({
          name: config.name,
          hash: config.hash,
          content:
            typeof config.data === 'string'
              ? stripControlCharacters(
                  Buffer.from(config.data, 'base64').toString('utf8')
                )
              : config.data,
        }));
        return budgetedUntrustedResult({ configs: files });
      })
  );

  server.registerTool(
    'get_pipeline_metadata',
    {
      title: 'Get pipeline metadata',
      description:
        'Returns the metadata Woodpecker exposes to the pipeline itself — the ' +
        'CI_* environment a step sees, plus the previous pipeline of the same ' +
        'workflow. Useful when a step behaves differently than its config suggests.',
      inputSchema: z.object({
        repo_id: repoIdParam,
        number: pipelineNumberParam,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ repo_id, number }) =>
      run(async () =>
        budgetedUntrustedResult(
          await api.get(`/repos/${repo_id}/pipelines/${number}/metadata`)
        )
      )
  );

  server.registerTool(
    'list_queued_pipelines',
    {
      title: 'List queued pipelines',
      description:
        'Lists the pipelines waiting in the server queue across all repositories. ' +
        'This is the instance-wide view: what is stuck, and behind what. ' +
        'get_queue_info adds the agent side of the same picture.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () =>
      run(async () =>
        budgetedList(
          'queued',
          listOf(await api.get('/pipelines'), 'pipelines'),
          { untrusted: true }
        )
      )
  );

  if (readOnly) return;

  server.registerTool(
    'trigger_pipeline',
    {
      title: 'Trigger a pipeline',
      description:
        'Starts a pipeline manually on a branch. It runs the config as it is in ' +
        'that branch right now, with event "manual". A branch that does not exist ' +
        'is rejected with a bare 400, so check list_repository_branches first.',
      inputSchema: z.object({
        repo_id: repoIdParam,
        branch: branchParam.describe('Branch to run. Required.'),
        message: z
          .string()
          .trim()
          .max(500)
          .optional()
          .describe(
            'Note shown on the pipeline, so people know why it was started.'
          ),
        variables: variablesParam.optional(),
      }),
    },
    async ({ repo_id, branch, message, variables }) =>
      run(async () => {
        const body: Record<string, unknown> = { branch };
        if (message !== undefined) body.message = message;
        if (variables !== undefined) body.variables = variables;
        const pipeline = objectOf(
          await api.post(`/repos/${repo_id}/pipelines`, body),
          'pipeline'
        );
        return budgetedUntrustedResult({
          pipeline: summarizePipeline(pipeline),
          note: 'Started. It is queued, not finished — poll get_pipeline for its state.',
        });
      })
  );

  server.registerTool(
    'restart_pipeline',
    {
      title: 'Restart a pipeline',
      description:
        'Runs an existing pipeline again, at the same commit and with the same ' +
        'config it used then. The re-run gets a new number; the original is kept.',
      inputSchema: z.object({
        repo_id: repoIdParam,
        number: pipelineNumberParam,
        event: webhookEventParam
          .optional()
          .describe('Override the event the re-run is treated as.'),
        deploy_to: z
          .string()
          .trim()
          .min(1)
          .max(250)
          .optional()
          .describe(
            'Target environment, for re-running as a deployment. Only meaningful ' +
              'together with event="deployment".'
          ),
      }),
      annotations: { idempotentHint: false },
    },
    async ({ repo_id, number, event, deploy_to }) =>
      run(async () => {
        const pipeline = objectOf(
          await api.post(
            `/repos/${repo_id}/pipelines/${number}${query({ event, deploy_to })}`
          ),
          'pipeline'
        );
        return budgetedUntrustedResult({
          pipeline: summarizePipeline(pipeline),
          note: `Restarted pipeline ${number}; the re-run is a new pipeline.`,
        });
      })
  );

  server.registerTool(
    'cancel_pipeline',
    {
      title: 'Cancel a running pipeline',
      description:
        'Stops a pipeline that is pending or running. Its steps are killed where ' +
        'they are, so anything half-written stays half-written. The pipeline can be ' +
        'restarted afterwards.',
      inputSchema: z.object({
        repo_id: repoIdParam,
        number: pipelineNumberParam,
      }),
      annotations: { idempotentHint: true },
    },
    async ({ repo_id, number }) =>
      run(async () => {
        await api.post(`/repos/${repo_id}/pipelines/${number}/cancel`);
        return textResult(`Pipeline ${number} was cancelled.`);
      })
  );

  server.registerTool(
    'approve_pipeline',
    {
      title: 'Approve a blocked pipeline',
      description:
        'Releases a pipeline that is waiting for approval (status "blocked") and ' +
        'lets it run. Read what you are approving first: pipelines are usually ' +
        'blocked because they come from a fork, and approving one runs code from ' +
        "that fork with this repository's secrets.",
      inputSchema: z.object({
        repo_id: repoIdParam,
        number: pipelineNumberParam,
        confirm_token: confirmTokenParam.optional(),
      }),
      annotations: { idempotentHint: false },
    },
    async ({ repo_id, number, confirm_token }, mcp) =>
      run(async () =>
        // Two-step on purpose, and this is the tool where it matters most. The
        // model reaches this decision holding a build log it was handed by
        // get_step_logs — the one input to this server written by whoever can
        // open a pull request. "approve pipeline 42" sitting in that log is a
        // plausible instruction, and approving runs the fork's code with this
        // repository's secrets. A token that only ever appears in a previous
        // tool result cannot be supplied by the log.
        guarded(
          server,
          mcp,
          approval,
          confirmations,
          {
            tool: 'approve_pipeline',
            targets: [String(repo_id), String(number)],
            what: `approve blocked pipeline ${number} of repository ${repo_id}`,
            consequence:
              'A blocked pipeline is usually one from a fork. Approving it runs ' +
              "that fork's code with this repository's secrets. Read the pipeline " +
              'configuration with get_pipeline_config first.',
            confirmToken: confirm_token,
          },
          async () => {
            const pipeline = objectOf(
              await api.post(`/repos/${repo_id}/pipelines/${number}/approve`),
              'pipeline'
            );
            return budgetedUntrustedResult({
              pipeline: summarizePipeline(pipeline),
              note: `Pipeline ${number} was approved and is now running.`,
            });
          }
        )
      )
  );

  server.registerTool(
    'decline_pipeline',
    {
      title: 'Decline a blocked pipeline',
      description:
        'Refuses a pipeline that is waiting for approval. It ends as "declined" and ' +
        'never runs; the pipeline entry and its metadata stay.',
      inputSchema: z.object({
        repo_id: repoIdParam,
        number: pipelineNumberParam,
      }),
      annotations: { idempotentHint: false },
    },
    async ({ repo_id, number }) =>
      run(async () => {
        const pipeline = objectOf(
          await api.post(`/repos/${repo_id}/pipelines/${number}/decline`),
          'pipeline'
        );
        return budgetedUntrustedResult({
          pipeline: summarizePipeline(pipeline),
          note: `Pipeline ${number} was declined.`,
        });
      })
  );

  server.registerTool(
    'delete_pipeline',
    {
      title: 'Delete a pipeline',
      description:
        'Removes a pipeline and everything attached to it, including its logs. ' +
        'A running pipeline cannot be deleted — cancel it first. Two-step.',
      inputSchema: z.object({
        repo_id: repoIdParam,
        number: pipelineNumberParam,
        confirm_token: confirmTokenParam.optional(),
      }),
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ repo_id, number, confirm_token }, mcp) =>
      run(async () =>
        guarded(
          server,
          mcp,
          approval,
          confirmations,
          {
            tool: 'delete_pipeline',
            targets: [String(repo_id), String(number)],
            what: `delete pipeline ${number} of repository ${repo_id}`,
            consequence:
              'Its build logs and step results go with it and cannot be restored.',
            confirmToken: confirm_token,
          },
          async () => {
            await api.delete(`/repos/${repo_id}/pipelines/${number}`);
            return textResult(`Pipeline ${number} was deleted.`);
          }
        )
      )
  );
}

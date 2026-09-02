import { z } from 'zod';
import { marked, plain } from '../output-schema.js';
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
  sentenceResult,
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
import { READ_ONLY } from './annotations.js';
import { guarded } from '../guard.js';
import { stripControlCharacters } from '../logs.js';
import type { ToolContext } from './context.js';

/**
 * Bounds on what one `get_pipeline_config` answer is allowed to cost.
 *
 * Both numbers are decided by the repository rather than by an input schema:
 * `config_file` may name a directory, so `configs` is however many YAML files
 * someone put in `.woodpecker/`, and each of those files is as long as they made
 * it. `budgetedUntrustedResult` bounds what reaches the model, but it runs at the
 * end — after every byte has been base64-decoded and walked six times by
 * `stripControlCharacters`. These bound the work itself, which is the part a
 * single-threaded server cannot get back.
 */
const MAX_CONFIG_FILES = 20;
const MAX_CONFIG_BYTES = 200_000;

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
      annotations: READ_ONLY,
      outputSchema: marked(),
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
      annotations: READ_ONLY,
      outputSchema: marked(),
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
      annotations: READ_ONLY,
      outputSchema: marked(),
    },
    async ({ repo_id, number }) =>
      run(async () => {
        const configs = listOf(
          await api.get(`/repos/${repo_id}/pipelines/${number}/config`),
          'pipeline configs'
        );
        // `data` is the file content, base64 in the Go model's JSON. It is a
        // file from the repository, so it gets the same control-character
        // treatment as build output — and the same bounds, applied before the
        // decoding rather than after it.
        const shown = configs.slice(0, MAX_CONFIG_FILES);
        const files = shown.map((config) => {
          if (typeof config.data !== 'string') {
            return {
              name: config.name,
              hash: config.hash,
              content: config.data,
            };
          }
          const raw = Buffer.from(config.data, 'base64');
          const cut = raw.byteLength > MAX_CONFIG_BYTES;
          const content = stripControlCharacters(
            (cut ? raw.subarray(0, MAX_CONFIG_BYTES) : raw).toString('utf8')
          );
          // The note goes beside the content, not appended to it: an oversized
          // file is exactly the one that budgetedJson shortens, and a marker at
          // the end of the string is the first thing that shortening removes.
          return cut
            ? {
                name: config.name,
                hash: config.hash,
                truncated: `Only the first ${MAX_CONFIG_BYTES} bytes of this ${raw.byteLength}-byte file were read.`,
                content,
              }
            : { name: config.name, hash: config.hash, content };
        });
        return budgetedUntrustedResult({
          configs: files,
          ...(configs.length > shown.length
            ? {
                truncated: {
                  shown: shown.length,
                  total: configs.length,
                  note:
                    `This pipeline was built from ${configs.length} configuration ` +
                    `files; only the first ${shown.length} were read.`,
                },
              }
            : {}),
        });
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
      annotations: READ_ONLY,
      outputSchema: marked(),
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
      annotations: READ_ONLY,
      outputSchema: marked(),
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
        'is rejected with a bare 400, so check list_repository_branches first. ' +
        'Not idempotent and there is no way to make it so — Woodpecker has no ' +
        'idempotency key — so a retry after a timeout starts a second pipeline. ' +
        'Read list_pipelines before calling again.',
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
      annotations: {
        // Runs a build. What that build does is written in the repository,
        // not here, so this server cannot promise it destroys nothing.
        // Each call is a separate pipeline.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      outputSchema: marked(),
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
        'config it used then. The re-run gets a new number; the original is kept. ' +
        'Every call is another run — a retry after a timeout starts a second one, ' +
        'and Woodpecker offers no idempotency key to prevent that.',
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
      annotations: {
        // Runs the build again. Each call is a new pipeline.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      outputSchema: marked(),
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
      annotations: {
        // Stops a run. The pipeline record and its logs stay.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      outputSchema: plain(),
    },
    async ({ repo_id, number }) =>
      run(async () => {
        await api.post(`/repos/${repo_id}/pipelines/${number}/cancel`);
        return sentenceResult(`Pipeline ${number} was cancelled.`, {
          pipeline: number,
          cancelled: true,
        });
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
      annotations: {
        // Runs a blocked pipeline — usually one from a fork — with this
        // repository's secrets. The sharpest of the code-running tools.
        // Guarded for exactly that.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      outputSchema: marked(),
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
            targets: [`repo:${repo_id}`, `pipeline:${number}`],
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
      annotations: {
        // Refuses to run it. Nothing executes and nothing is lost.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      outputSchema: marked(),
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
      annotations: {
        // Idempotent by the specification's wording — "no additional effect
        // on its environment". The second call fails, but the world is the
        // same either way, which is what lets a caller retry after a timeout.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      outputSchema: plain(),
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
            targets: [`repo:${repo_id}`, `pipeline:${number}`],
            what: `delete pipeline ${number} of repository ${repo_id}`,
            consequence:
              'Its build logs and step results go with it and cannot be restored.',
            confirmToken: confirm_token,
          },
          async () => {
            await api.delete(`/repos/${repo_id}/pipelines/${number}`);
            return sentenceResult(`Pipeline ${number} was deleted.`, {
              deleted_pipeline: number,
            });
          }
        )
      )
  );
}

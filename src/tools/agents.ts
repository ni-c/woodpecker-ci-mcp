import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  budgetedList,
  jsonResult,
  rawJsonResult,
  run,
  textResult,
} from '../result.js';
import {
  agentIdParam,
  confirmTokenParam,
  orgIdParam,
  pageParam,
  perPageParam,
} from '../schema.js';

import { query } from '../api.js';
import { guarded } from '../guard.js';
import { listOf, redactAgent } from '../normalize.js';
import type { ToolContext } from './context.js';

/**
 * Build agents.
 *
 * The thing to know here: **the Woodpecker API returns agent tokens in clear
 * text**, on every read, including the list call. Verified against 3.18.0 —
 * `GET /api/agents` hands back a `token` field for every agent. That token is
 * all it takes to register a machine as a build agent, which then receives
 * pipeline workloads and the secrets injected into them.
 *
 * So `list_agents` and `get_agent` redact it, and `create_agent` does not: there
 * the token *is* the result, it is shown once, and the tool says so.
 */
const agentNameParam = z
  .string()
  .trim()
  .min(1)
  .max(250)
  .describe('Display name of the agent.');

const noScheduleParam = z
  .boolean()
  .describe(
    'When true the agent finishes what it has and accepts no new work — how you ' +
      'drain an agent before taking its host down.'
  );

const customLabelsParam = z
  .record(z.string().min(1).max(100), z.string().max(500))
  .describe(
    'Labels this agent advertises, as a flat string map. A pipeline selects agents ' +
      'with a matching "labels" block.'
  );

export function registerAgentTools(
  server: McpServer,
  { api, confirmations, readOnly }: ToolContext
): void {
  server.registerTool(
    'list_agents',
    {
      title: 'List agents',
      description:
        'Lists the build agents, with their platform, capacity, version and last ' +
        'contact — the call that answers "why is nothing being built". Without ' +
        'org_id this is the instance-wide list and needs an administrator. Agent ' +
        'tokens are redacted.',
      inputSchema: z.object({
        org_id: orgIdParam
          .optional()
          .describe(
            'List the agents of one organization instead of the whole instance.'
          ),
        page: pageParam.optional(),
        per_page: perPageParam.optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ org_id, page, per_page }) =>
      run(async () => {
        const base =
          org_id === undefined ? '/agents' : `/orgs/${org_id}/agents`;
        const agents = await api.get(
          `${base}${query({ page, perPage: per_page })}`
        );
        return budgetedList(
          'agents',
          listOf(agents, 'agents').map(redactAgent),
          {
            extra: {
              note:
                'Agent tokens are removed by this server — the Woodpecker API does ' +
                'return them in clear text here.',
            },
          }
        );
      })
  );

  server.registerTool(
    'get_agent',
    {
      title: 'Get an agent',
      description:
        'Returns one agent. Admin only. Its token is redacted; an agent that lost ' +
        'its token needs a new one, which means delete_agent and create_agent.',
      inputSchema: z.object({ agent_id: agentIdParam }),
      annotations: { readOnlyHint: true },
    },
    async ({ agent_id }) =>
      run(async () =>
        jsonResult(
          redactAgent(
            (await api.get(`/agents/${agent_id}`)) as Record<string, unknown>
          )
        )
      )
  );

  server.registerTool(
    'list_agent_tasks',
    {
      title: 'List an agent’s tasks',
      description:
        'The work an agent is currently running. Admin only. This is how you find ' +
        'out what is occupying a busy agent, and which pipeline to cancel.',
      inputSchema: z.object({ agent_id: agentIdParam }),
      annotations: { readOnlyHint: true },
    },
    async ({ agent_id }) =>
      run(async () =>
        budgetedList(
          'tasks',
          listOf(await api.get(`/agents/${agent_id}/tasks`), 'tasks')
        )
      )
  );

  if (readOnly) return;

  server.registerTool(
    'create_agent',
    {
      title: 'Create an agent',
      description:
        'Registers a new build agent and returns its token. THE TOKEN IS A ' +
        'CREDENTIAL: whoever holds it can attach a machine to this server, receive ' +
        'pipeline workloads and read every secret those pipelines use. It is part ' +
        'of this answer because it is the only way to get it — put it straight into ' +
        "the agent's configuration and do not paste it anywhere else.",
      inputSchema: z.object({
        name: agentNameParam,
        org_id: orgIdParam
          .optional()
          .describe(
            'Create an organization-scoped agent, which only runs that ' +
              "organization's pipelines. Without it the agent serves the whole instance."
          ),
        no_schedule: noScheduleParam.optional(),
        custom_labels: customLabelsParam.optional(),
      }),
    },
    async ({ name, org_id, no_schedule, custom_labels }) =>
      run(async () => {
        const base =
          org_id === undefined ? '/agents' : `/orgs/${org_id}/agents`;
        const body: Record<string, unknown> = { name };
        if (no_schedule !== undefined) body.no_schedule = no_schedule;
        if (custom_labels !== undefined) body.custom_labels = custom_labels;
        // The one deliberate exception to the credential scrubber in
        // `jsonResult`: this tool exists to hand over the token, and the API
        // shows it exactly once.
        return rawJsonResult({
          agent: await api.post(base, body),
          note:
            'The token above is shown so it can be configured on the agent host. ' +
            'Treat it like a password: it grants access to pipeline workloads and ' +
            'their secrets.',
        });
      })
  );

  server.registerTool(
    'update_agent',
    {
      title: 'Update an agent',
      description:
        'Changes an agent. Admin only. no_schedule=true is the drain switch: the ' +
        'agent finishes its current work and takes nothing new.',
      inputSchema: z.object({
        agent_id: agentIdParam,
        org_id: orgIdParam
          .optional()
          .describe(
            'Set for an organization-scoped agent when the account is an ' +
              'organization admin rather than an instance admin — that route is the ' +
              'only one they may use.'
          ),
        name: agentNameParam.optional(),
        no_schedule: noScheduleParam.optional(),
        custom_labels: customLabelsParam.optional(),
      }),
    },
    async ({ agent_id, org_id, name, no_schedule, custom_labels }) =>
      run(async () => {
        const body: Record<string, unknown> = {};
        if (name !== undefined) body.name = name;
        if (no_schedule !== undefined) body.no_schedule = no_schedule;
        if (custom_labels !== undefined) body.custom_labels = custom_labels;
        if (Object.keys(body).length === 0) {
          return textResult(
            'Nothing to update — pass name, no_schedule or custom_labels.'
          );
        }
        const path =
          org_id === undefined
            ? `/agents/${agent_id}`
            : `/orgs/${org_id}/agents/${agent_id}`;
        return jsonResult(
          redactAgent((await api.patch(path, body)) as Record<string, unknown>)
        );
      })
  );

  server.registerTool(
    'delete_agent',
    {
      title: 'Delete an agent',
      description:
        'Removes an agent and invalidates its token. Anything it was running is ' +
        'lost and has to be restarted. Drain it first with update_agent ' +
        'no_schedule=true. Two-step.',
      inputSchema: z.object({
        agent_id: agentIdParam,
        org_id: orgIdParam
          .optional()
          .describe(
            'Set for an organization-scoped agent when the account is an ' +
              'organization admin rather than an instance admin.'
          ),
        confirm_token: confirmTokenParam.optional(),
      }),
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ agent_id, org_id, confirm_token }) =>
      run(async () =>
        guarded(
          confirmations,
          {
            tool: 'delete_agent',
            targets: [String(agent_id), String(org_id ?? '')],
            what: `delete agent ${agent_id}`,
            consequence:
              'Its token stops working, the pipelines it is running are lost, and ' +
              'the agent process on that host cannot reconnect without a new token.',
            confirmToken: confirm_token,
          },
          async () => {
            await api.delete(
              org_id === undefined
                ? `/agents/${agent_id}`
                : `/orgs/${org_id}/agents/${agent_id}`
            );
            return textResult(
              `Agent ${agent_id} was deleted and its token invalidated.`
            );
          }
        )
      )
  );
}

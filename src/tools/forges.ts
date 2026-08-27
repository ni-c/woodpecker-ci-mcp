import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { query } from '../api.js';
import { guarded } from '../guard.js';
import { listOf } from '../normalize.js';
import { budgetedList, jsonResult, run, textResult } from '../result.js';
import {
  confirmTokenParam,
  forgeIdParam,
  httpUrlParam,
  pageParam,
  perPageParam,
} from '../schema.js';
import type { ToolContext } from './context.js';

/**
 * The forges Woodpecker authenticates against.
 *
 * This is the deepest administrative surface in the API — the OAuth
 * configuration that every login and every repository read depends on — so both
 * mutating tools that can break an instance beyond the reach of its own UI
 * (update and delete) are two-step.
 *
 * The OAuth client secret is write-only in practice: the read model (`Forge`)
 * has no such field, only the write model (`ForgeWithOAuthClientSecret`) does,
 * so it goes in and never comes back out.
 */
const forgeTypeParam = z
  .enum([
    'github',
    'gitlab',
    'gitea',
    'forgejo',
    'bitbucket',
    'bitbucket-dc',
    'addon',
  ])
  .describe('Which forge software this is.');

const forgeUrlParam = httpUrlParam.describe(
  'Base URL of the forge, e.g. "https://github.com".'
);

/**
 * The public OAuth redirect host.
 *
 * Same scheme guard as the forge URL and for the same reason: Woodpecker builds
 * its OAuth redirect from this value, so a `javascript:` or `file:` URL here is
 * a scheme this server would have accepted on a caller's say-so.
 */
const oauthHostParam = httpUrlParam.describe(
  'Public URL used for the OAuth redirect, when it differs from "url" — the ' +
    'usual case for a forge reachable under two names.'
);

export function registerForgeTools(
  server: McpServer,
  { api, confirmations, readOnly }: ToolContext
): void {
  server.registerTool(
    'list_forges',
    {
      title: 'List forges',
      description:
        'Lists the forges this Woodpecker authenticates against. Admin only. The ' +
        'forge_id shown here is what get_user and delete_user require.',
      inputSchema: {
        page: pageParam.optional(),
        per_page: perPageParam.optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ page, per_page }) =>
      run(async () => {
        const forges = await api.get(
          `/forges${query({ page, perPage: per_page })}`
        );
        return budgetedList('forges', listOf(forges, 'forges'));
      })
  );

  server.registerTool(
    'get_forge',
    {
      title: 'Get a forge',
      description:
        'Returns one forge configuration. Admin only. The OAuth client secret is ' +
        'not part of the read model and is never returned.',
      inputSchema: { forge_id: forgeIdParam },
      annotations: { readOnlyHint: true },
    },
    async ({ forge_id }) =>
      run(async () => jsonResult(await api.get(`/forges/${forge_id}`)))
  );

  if (readOnly) return;

  server.registerTool(
    'create_forge',
    {
      title: 'Add a forge',
      description:
        'Registers an additional forge. Admin only. The OAuth application has to ' +
        'exist on the forge side first, with this Woodpecker as its callback.',
      inputSchema: {
        type: forgeTypeParam,
        url: forgeUrlParam,
        client: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .describe('OAuth client id from the forge.'),
        oauth_client_secret: z
          .string()
          .min(1)
          .max(1000)
          .describe(
            'OAuth client secret. Write-only — Woodpecker never returns it again.'
          ),
        oauth_host: oauthHostParam.optional(),
        skip_verify: z
          .boolean()
          .optional()
          .describe(
            'Skip TLS verification towards this forge. Only for a private CA you ' +
              'cannot install; it disables certificate checking entirely.'
          ),
      },
    },
    async (fields) =>
      run(async () => {
        const body: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(fields)) {
          if (value !== undefined) body[key] = value;
        }
        return jsonResult({ forge: await api.post('/forges', body) });
      })
  );

  server.registerTool(
    'update_forge',
    {
      title: 'Update a forge',
      description:
        'Changes a forge configuration. Admin only, and two-step: this is the ' +
        'setting every login and every repository read depends on, and a wrong ' +
        'value locks everyone out of the instance — including whoever is fixing it.',
      inputSchema: {
        forge_id: forgeIdParam,
        type: forgeTypeParam.optional(),
        url: forgeUrlParam.optional(),
        client: z.string().trim().min(1).max(500).optional(),
        oauth_client_secret: z.string().min(1).max(1000).optional(),
        oauth_host: oauthHostParam.optional(),
        skip_verify: z.boolean().optional(),
        confirm_token: confirmTokenParam.optional(),
      },
      annotations: { idempotentHint: false },
    },
    async ({ forge_id, confirm_token, ...fields }) =>
      run(async () => {
        const body: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(fields)) {
          if (value !== undefined) body[key] = value;
        }
        if (Object.keys(body).length === 0) {
          return textResult('Nothing to update — pass at least one field.');
        }
        return guarded(
          confirmations,
          {
            tool: 'update_forge',
            targets: [String(forge_id), ...Object.keys(body).sort()],
            what: `change the configuration of forge ${forge_id}`,
            consequence:
              'Every login and every repository read goes through this forge. A ' +
              'wrong URL or client secret locks all users out, and the fix is then ' +
              'only reachable from the server configuration, not from the web UI.',
            confirmToken: confirm_token,
          },
          async () =>
            jsonResult({ forge: await api.patch(`/forges/${forge_id}`, body) })
        );
      })
  );

  server.registerTool(
    'delete_forge',
    {
      title: 'Delete a forge',
      description:
        'Removes a forge from Woodpecker. Admin only. Everyone who signs in through ' +
        'it loses access, and its repositories can no longer be read. Two-step.',
      inputSchema: {
        forge_id: forgeIdParam,
        confirm_token: confirmTokenParam.optional(),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ forge_id, confirm_token }) =>
      run(async () =>
        guarded(
          confirmations,
          {
            tool: 'delete_forge',
            targets: [String(forge_id)],
            what: `delete forge ${forge_id} from Woodpecker`,
            consequence:
              'Accounts that authenticate through this forge can no longer sign in, ' +
              'and pipelines of its repositories stop working.',
            confirmToken: confirm_token,
          },
          async () => {
            await api.delete(`/forges/${forge_id}`);
            return textResult(`Forge ${forge_id} was deleted.`);
          }
        )
      )
  );
}

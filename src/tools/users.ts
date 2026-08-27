import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { pathSegment, query } from '../api.js';
import { guarded } from '../guard.js';
import { listOf, summarizeUser } from '../normalize.js';
import { budgetedList, jsonResult, run, textResult } from '../result.js';
import {
  confirmTokenParam,
  loginParam,
  pageParam,
  perPageParam,
} from '../schema.js';
import type { ToolContext } from './context.js';

/**
 * Instance user administration. Every tool here needs admin=true.
 *
 * One shape is unusual enough to spell out: `GET /users/{login}` and
 * `DELETE /users/{login}` take **forge_id as a required query parameter**,
 * because a login is only unique within a forge and Woodpecker 3 supports
 * several. `list_users` shows the forge_id of each account.
 */
const forgeIdQueryParam = z
  .number()
  .int()
  .min(1)
  .describe(
    'Which forge the login belongs to. Required by the API — a login is only ' +
      'unique per forge. list_users shows it; on a single-forge instance it is 1.'
  );

export function registerUserTools(
  server: McpServer,
  { api, confirmations, readOnly }: ToolContext
): void {
  server.registerTool(
    'list_users',
    {
      title: 'List users',
      description:
        'Lists the accounts known to this Woodpecker instance. Admin only. ' +
        'Woodpecker creates an account the first time someone logs in, so this is ' +
        'everyone who has ever used it, not a managed roster.',
      inputSchema: {
        page: pageParam.optional(),
        per_page: perPageParam.optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ page, per_page }) =>
      run(async () => {
        const users = await api.get(
          `/users${query({ page, perPage: per_page })}`
        );
        return budgetedList('users', listOf(users, 'users').map(summarizeUser));
      })
  );

  server.registerTool(
    'get_user',
    {
      title: 'Get a user',
      description:
        'Returns one account by its login. Admin only. forge_id is required — see ' +
        'list_users for the value.',
      inputSchema: {
        login: loginParam,
        forge_id: forgeIdQueryParam,
        forge_remote_id: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe('Disambiguates further if the forge reuses logins.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ login, forge_id, forge_remote_id }) =>
      run(async () =>
        jsonResult(
          summarizeUser(
            (await api.get(
              `/users/${pathSegment(login, 'login')}${query({ forge_id, forge_remote_id })}`
            )) as Record<string, unknown>
          )
        )
      )
  );

  if (readOnly) return;

  server.registerTool(
    'create_user',
    {
      title: 'Create a user',
      description:
        'Registers an account ahead of its first login. Admin only. This does not ' +
        'create anything in the forge and grants no access there — the person still ' +
        'signs in through the forge; this only pre-creates the Woodpecker record, ' +
        'which is how you make someone an admin before they first log in.',
      inputSchema: {
        login: loginParam.describe(
          'The login exactly as the forge spells it. A mismatch creates a second, ' +
            'unused account instead of the one you meant.'
        ),
        email: z
          .string()
          .trim()
          .email()
          .max(500)
          .optional()
          .describe('Email address.'),
        admin: z
          .boolean()
          .optional()
          .describe('Make the account an instance administrator.'),
      },
    },
    async ({ login, email, admin }) =>
      run(async () => {
        const body: Record<string, unknown> = { login };
        if (email !== undefined) body.email = email;
        if (admin !== undefined) body.admin = admin;
        return jsonResult({
          user: summarizeUser(
            (await api.post('/users', body)) as Record<string, unknown>
          ),
        });
      })
  );

  server.registerTool(
    'update_user',
    {
      title: 'Update a user',
      description:
        'Changes an account. Admin only. The one that matters is "admin": granting ' +
        'it gives full control of the instance, including every secret of every ' +
        'repository.',
      inputSchema: {
        login: loginParam,
        email: z.string().trim().email().max(500).optional(),
        admin: z
          .boolean()
          .optional()
          .describe(
            'Instance administrator. Grants access to every repository, secret and ' +
              'agent on the server.'
          ),
      },
    },
    async ({ login, email, admin }) =>
      run(async () => {
        const body: Record<string, unknown> = {};
        if (email !== undefined) body.email = email;
        if (admin !== undefined) body.admin = admin;
        if (Object.keys(body).length === 0) {
          return textResult('Nothing to update — pass email or admin.');
        }
        return jsonResult({
          user: summarizeUser(
            (await api.patch(
              `/users/${pathSegment(login, 'login')}`,
              body
            )) as Record<string, unknown>
          ),
        });
      })
  );

  server.registerTool(
    'delete_user',
    {
      title: 'Delete a user',
      description:
        'Removes an account from Woodpecker. Admin only. Repositories the account ' +
        'owned keep running on a token that no longer exists, which shows up later ' +
        'as pipelines that stop starting — chown_repository moves ownership to ' +
        'someone else, and doing that first is the point. Two-step.',
      inputSchema: {
        login: loginParam,
        forge_id: forgeIdQueryParam,
        confirm_token: confirmTokenParam.optional(),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ login, forge_id, confirm_token }) =>
      run(async () =>
        guarded(
          confirmations,
          {
            tool: 'delete_user',
            targets: [login, String(forge_id)],
            what: `delete the Woodpecker account "${login}"`,
            consequence:
              'Repositories this account owns keep pointing at its forge token, ' +
              'which is gone — their pipelines stop starting. Transfer them with ' +
              'chown_repository first.',
            confirmToken: confirm_token,
          },
          async () => {
            await api.delete(
              `/users/${pathSegment(login, 'login')}${query({ forge_id })}`
            );
            return textResult(`Account "${login}" was deleted.`);
          }
        )
      )
  );
}

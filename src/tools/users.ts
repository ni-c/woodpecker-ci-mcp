import { z } from 'zod';
import type { McpServer, CallToolResult } from '@modelcontextprotocol/server';
import {
  confirmTokenParam,
  loginParam,
  pageParam,
  perPageParam,
} from '../schema.js';

import { pathSegment, query } from '../api.js';
import { identifier } from '../resource-key.js';
import { guarded } from '../guard.js';
import { listOf, summarizeUser } from '../normalize.js';
import { budgetedList, jsonResult, run, textResult } from '../result.js';
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
  { api, confirmations, approval, readOnly }: ToolContext
): void {
  server.registerTool(
    'list_users',
    {
      title: 'List users',
      description:
        'Lists the accounts known to this Woodpecker instance. Admin only. ' +
        'Woodpecker creates an account the first time someone logs in, so this is ' +
        'everyone who has ever used it, not a managed roster.',
      inputSchema: z.object({
        page: pageParam.optional(),
        per_page: perPageParam.optional(),
      }),
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
      inputSchema: z.object({
        login: loginParam,
        forge_id: forgeIdQueryParam,
        forge_remote_id: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe('Disambiguates further if the forge reuses logins.'),
      }),
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
      inputSchema: z.object({
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
      }),
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
        'repository. Fields you do not pass are preserved.',
      inputSchema: z.object({
        login: loginParam,
        forge_id: forgeIdQueryParam,
        email: z.string().trim().email().max(500).optional(),
        admin: z
          .boolean()
          .optional()
          .describe(
            'Instance administrator. Grants access to every repository, secret and ' +
              'agent on the server. Granting it needs a confirm_token.'
          ),
        confirm_token: confirmTokenParam.optional(),
      }),
    },
    async ({ login, forge_id, email, admin, confirm_token }, mcp) =>
      run(async () => {
        if (email === undefined && admin === undefined) {
          return textResult('Nothing to update — pass email or admin.');
        }

        // Only granting admin is guarded. Making every email correction
        // two-step would train whoever reads these prompts to click through
        // them, which costs more than it buys — this is the one field that
        // hands over the whole instance, so this is the one that stops.
        if (admin === true) {
          return guarded(
            server,
            mcp,
            approval,
            confirmations,
            {
              tool: 'update_user',
              targets: [login, String(forge_id ?? ''), 'admin'],
              what: `make the account "${identifier(login, 'login')}" an instance administrator`,
              consequence:
                'An instance administrator reads and writes every repository, ' +
                'secret and agent on this server, and can grant the same to others.',
              confirmToken: confirm_token,
            },
            async () => applyUserUpdate({ login, forge_id, email, admin })
          );
        }
        return applyUserUpdate({ login, forge_id, email, admin });
      })
  );

  async function applyUserUpdate({
    login,
    forge_id,
    email,
    admin,
  }: {
    login: string;
    forge_id: number | undefined;
    email: string | undefined;
    admin: boolean | undefined;
  }): Promise<CallToolResult> {
    // Read-modify-write, and not for tidiness. `PATCH /users/{login}` is a
    // PATCH in name only: the handler assigns login, email, avatar and admin
    // from the request unconditionally, so a body carrying just `{"admin":
    // true}` blanks the account's login and email — verified against 3.18.0,
    // where it answered with `{"id": 0, "login": "", "email": ""}`. Sending
    // the full object, with forge_id and forge_remote_id so the handler's own
    // lookup finds the right row, is the only way to make it behave like the
    // partial update its name promises.
    const current = (await api.get(
      `/users/${pathSegment(login, 'login')}${query({ forge_id })}`
    )) as Record<string, unknown>;

    const body: Record<string, unknown> = {
      login: current.login,
      email: email ?? current.email,
      avatar_url: current.avatar_url,
      admin: admin ?? current.admin ?? false,
      forge_id: current.forge_id ?? forge_id,
      forge_remote_id: current.forge_remote_id,
    };

    await api.patch(`/users/${pathSegment(login, 'login')}`, body);

    // The response to the PATCH is the request echoed back, not the stored
    // account, so it is read again rather than reported.
    const updated = (await api.get(
      `/users/${pathSegment(login, 'login')}${query({ forge_id })}`
    )) as Record<string, unknown>;
    return jsonResult({ user: summarizeUser(updated) });
  }

  server.registerTool(
    'delete_user',
    {
      title: 'Delete a user',
      description:
        'Removes an account from Woodpecker. Admin only. Repositories the account ' +
        'owned keep running on a token that no longer exists, which shows up later ' +
        'as pipelines that stop starting — chown_repository moves ownership to ' +
        'someone else, and doing that first is the point. Two-step.',
      inputSchema: z.object({
        login: loginParam,
        forge_id: forgeIdQueryParam,
        confirm_token: confirmTokenParam.optional(),
      }),
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ login, forge_id, confirm_token }, mcp) =>
      run(async () =>
        guarded(
          server,
          mcp,
          approval,
          confirmations,
          {
            tool: 'delete_user',
            targets: [login, String(forge_id)],
            what: `delete the Woodpecker account "${identifier(login, 'login')}"`,
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

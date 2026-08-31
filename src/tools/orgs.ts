import type { McpServer } from '@modelcontextprotocol/server';
import {
  confirmTokenParam,
  orgFullNameParam,
  orgIdParam,
  pageParam,
  perPageParam,
} from '../schema.js';
import { z } from 'zod';

import { pathSegment, query } from '../api.js';
import { guarded } from '../guard.js';
import { listOf } from '../normalize.js';
import { budgetedList, jsonResult, run, textResult } from '../result.js';
import type { ToolContext } from './context.js';

export function registerOrgTools(
  server: McpServer,
  { api, confirmations, readOnly }: ToolContext
): void {
  server.registerTool(
    'list_organizations',
    {
      title: 'List organizations',
      description:
        'Lists the organizations known to this Woodpecker instance. Admin only. ' +
        'Note that an entry with is_user=true is a personal account, not a real ' +
        'organization — Woodpecker models both the same way, and org-level secrets ' +
        'work for both.',
      inputSchema: z.object({
        page: pageParam.optional(),
        per_page: perPageParam.optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ page, per_page }) =>
      run(async () => {
        const orgs = await api.get(
          `/orgs${query({ page, perPage: per_page })}`
        );
        return budgetedList('organizations', listOf(orgs, 'organizations'));
      })
  );

  server.registerTool(
    'get_organization',
    {
      title: 'Get an organization',
      description: 'Returns one organization by its numeric id.',
      inputSchema: z.object({ org_id: orgIdParam }),
      annotations: { readOnlyHint: true },
    },
    async ({ org_id }) =>
      run(async () => jsonResult(await api.get(`/orgs/${org_id}`)))
  );

  server.registerTool(
    'lookup_organization',
    {
      title: 'Look up an organization by name',
      description:
        'Resolves an organization name to its id — the id every other org-level ' +
        'call needs, including org-scoped secrets and registries.',
      inputSchema: z.object({ name: orgFullNameParam }),
      annotations: { readOnlyHint: true },
    },
    async ({ name }) =>
      run(async () =>
        jsonResult(
          await api.get(
            `/orgs/lookup/${pathSegment(name, 'organization name')}`
          )
        )
      )
  );

  server.registerTool(
    'get_organization_permissions',
    {
      title: 'Get organization permissions',
      description:
        'What the authenticated account may do in this organization: member and ' +
        'admin. Org-level secrets and agents need admin here.',
      inputSchema: z.object({ org_id: orgIdParam }),
      annotations: { readOnlyHint: true },
    },
    async ({ org_id }) =>
      run(async () => jsonResult(await api.get(`/orgs/${org_id}/permissions`)))
  );

  if (readOnly) return;

  server.registerTool(
    'delete_organization',
    {
      title: 'Delete an organization',
      description:
        'Removes an organization from Woodpecker together with its org-level ' +
        'secrets, registries and agents. Admin only. It does not touch the forge, ' +
        'and it does not delete the repositories — but anything of theirs that ' +
        'relied on an org-level secret stops working. Two-step.',
      inputSchema: z.object({
        org_id: orgIdParam,
        confirm_token: confirmTokenParam.optional(),
      }),
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ org_id, confirm_token }) =>
      run(async () =>
        guarded(
          confirmations,
          {
            tool: 'delete_organization',
            targets: [String(org_id)],
            what: `delete organization ${org_id} from Woodpecker`,
            consequence:
              'Its organization-level secrets, registries and agents go with it. ' +
              'Pipelines of its repositories that read an org secret will run ' +
              'without one.',
            confirmToken: confirm_token,
          },
          async () => {
            await api.delete(`/orgs/${org_id}`);
            return textResult(`Organization ${org_id} was deleted.`);
          }
        )
      )
  );
}

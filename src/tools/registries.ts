import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { pathSegment, query } from '../api.js';
import { guarded } from '../guard.js';
import { listOf } from '../normalize.js';
import { budgetedList, jsonResult, run, textResult } from '../result.js';
import {
  confirmTokenParam,
  pageParam,
  perPageParam,
  registryAddressParam,
  scopeParam,
} from '../schema.js';
import type { ToolContext } from './context.js';
import { scopeArguments, scopeBase, scopeLabel } from './scope.js';

const usernameParam = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .describe('Registry username.');

const passwordParam = z
  .string()
  .min(1)
  .max(100_000)
  .describe(
    'Registry password or token. Write-only — Woodpecker strips it from every ' +
      'response, so it cannot be read back.'
  );

export function registerRegistryTools(
  server: McpServer,
  { api, confirmations, readOnly }: ToolContext
): void {
  server.registerTool(
    'list_registries',
    {
      title: 'List container registries',
      description:
        'Lists the container registry credentials at one level. These are what let ' +
        'a pipeline pull private images. Passwords are never returned.',
      inputSchema: {
        scope: scopeParam,
        ...scopeArguments,
        page: pageParam.optional(),
        per_page: perPageParam.optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ scope, repo_id, org_id, page, per_page }) =>
      run(async () => {
        const base = scopeBase('registries', scope, { repo_id, org_id });
        const registries = await api.get(
          `${base}${query({ page, perPage: per_page })}`
        );
        return budgetedList('registries', listOf(registries, 'registries'), {
          extra: { scope: scopeLabel(scope, { repo_id, org_id }) },
        });
      })
  );

  server.registerTool(
    'get_registry',
    {
      title: 'Get a registry entry',
      description:
        'Returns one registry entry — its address and username. The password is ' +
        'stripped by Woodpecker (Registry.Copy), so it is never in the answer.',
      inputSchema: {
        scope: scopeParam,
        ...scopeArguments,
        address: registryAddressParam,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ scope, repo_id, org_id, address }) =>
      run(async () => {
        const base = scopeBase('registries', scope, { repo_id, org_id });
        return jsonResult(
          await api.get(`${base}/${pathSegment(address, 'registry address')}`)
        );
      })
  );

  if (readOnly) return;

  server.registerTool(
    'create_registry',
    {
      title: 'Add registry credentials',
      description:
        'Stores credentials for a container registry so pipelines can pull private ' +
        'images from it. The address is the identifier — there is no separate name ' +
        '— so "docker.io" and "index.docker.io" are two different entries.',
      inputSchema: {
        scope: scopeParam,
        ...scopeArguments,
        address: registryAddressParam,
        username: usernameParam,
        password: passwordParam,
      },
    },
    async ({ scope, repo_id, org_id, address, username, password }) =>
      run(async () => {
        const base = scopeBase('registries', scope, { repo_id, org_id });
        const created = await api.post(base, { address, username, password });
        return jsonResult({
          registry: created,
          note: `Added at ${scopeLabel(scope, { repo_id, org_id })}. The password cannot be read back.`,
        });
      })
  );

  server.registerTool(
    'update_registry',
    {
      title: 'Update registry credentials',
      description:
        'Changes the username or password of a registry entry. The address itself ' +
        'cannot be changed — it is the identifier; delete and re-create instead.',
      inputSchema: {
        scope: scopeParam,
        ...scopeArguments,
        address: registryAddressParam,
        username: usernameParam.optional(),
        password: passwordParam.optional(),
      },
    },
    async ({ scope, repo_id, org_id, address, username, password }) =>
      run(async () => {
        const base = scopeBase('registries', scope, { repo_id, org_id });
        const body: Record<string, unknown> = {};
        if (username !== undefined) body.username = username;
        if (password !== undefined) body.password = password;
        if (Object.keys(body).length === 0) {
          return textResult('Nothing to update — pass username or password.');
        }
        const updated = await api.patch(
          `${base}/${pathSegment(address, 'registry address')}`,
          body
        );
        return jsonResult({ registry: updated });
      })
  );

  server.registerTool(
    'delete_registry',
    {
      title: 'Delete registry credentials',
      description:
        'Removes stored credentials for a registry. Pipelines that pull private ' +
        'images from it start failing at the pull step. Two-step.',
      inputSchema: {
        scope: scopeParam,
        ...scopeArguments,
        address: registryAddressParam,
        confirm_token: confirmTokenParam.optional(),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ scope, repo_id, org_id, address, confirm_token }) =>
      run(async () => {
        const base = scopeBase('registries', scope, { repo_id, org_id });
        const where = scopeLabel(scope, { repo_id, org_id });
        return guarded(
          confirmations,
          {
            tool: 'delete_registry',
            targets: [
              scope,
              String(repo_id ?? ''),
              String(org_id ?? ''),
              address,
            ],
            what: `delete the registry credentials for "${address}" of ${where}`,
            consequence:
              'The password cannot be recovered, and pipelines pulling private ' +
              'images from that registry will fail.',
            confirmToken: confirm_token,
          },
          async () => {
            await api.delete(
              `${base}/${pathSegment(address, 'registry address')}`
            );
            return textResult(
              `Registry credentials for "${address}" of ${where} were deleted.`
            );
          }
        );
      })
  );
}

import { z } from 'zod';
import { plain } from '../output-schema.js';
import type { McpServer, CallToolResult } from '@modelcontextprotocol/server';
import {
  confirmTokenParam,
  pageParam,
  perPageParam,
  registryAddressParam,
  scopeParam,
} from '../schema.js';

import { pathSegment, query } from '../api.js';
import { READ_ONLY } from './annotations.js';
import { fingerprint, identifier } from '../resource-key.js';
import { guarded } from '../guard.js';
import { listOf } from '../normalize.js';
import {
  errorResult,
  budgetedList,
  jsonResult,
  run,
  sentenceResult,
} from '../result.js';
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
  { api, confirmations, approval, readOnly }: ToolContext
): void {
  server.registerTool(
    'list_registries',
    {
      title: 'List container registries',
      description:
        'Lists the container registry credentials at one level. These are what let ' +
        'a pipeline pull private images. Passwords are never returned.',
      inputSchema: z.object({
        scope: scopeParam,
        ...scopeArguments,
        page: pageParam.optional(),
        per_page: perPageParam.optional(),
      }),
      annotations: READ_ONLY,
      outputSchema: plain(),
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
      inputSchema: z.object({
        scope: scopeParam,
        ...scopeArguments,
        address: registryAddressParam,
      }),
      annotations: READ_ONLY,
      outputSchema: plain(),
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
      inputSchema: z.object({
        scope: scopeParam,
        ...scopeArguments,
        address: registryAddressParam,
        username: usernameParam,
        password: passwordParam,
      }),
      annotations: {
        // Additive.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      outputSchema: plain(),
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
      inputSchema: z.object({
        scope: scopeParam,
        ...scopeArguments,
        address: registryAddressParam,
        username: usernameParam.optional(),
        password: passwordParam.optional(),
        confirm_token: confirmTokenParam
          .optional()
          .describe(
            'Required only when passing "password"; changing the username alone ' +
              'applies on the first call.'
          ),
      }),
      annotations: {
        // Replaces stored registry credentials; the old password is not
        // readable through the API and cannot be recovered.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      outputSchema: plain(),
    },
    async (
      { scope, repo_id, org_id, address, username, password, confirm_token },
      mcp
    ) =>
      run(async () => {
        const base = scopeBase('registries', scope, { repo_id, org_id });
        const where = scopeLabel(scope, { repo_id, org_id });
        const body: Record<string, unknown> = {};
        if (username !== undefined) body.username = username;
        if (password !== undefined) body.password = password;
        if (Object.keys(body).length === 0) {
          return errorResult('Nothing to update — pass username or password.');
        }

        const apply = async (): Promise<CallToolResult> =>
          jsonResult({
            registry: await api.patch(
              `${base}/${pathSegment(address, 'registry address')}`,
              body
            ),
          });

        // The password half is guarded for the reason this tool's own
        // annotation already states: Woodpecker strips it from every response,
        // so the value being overwritten is not readable anywhere and nothing
        // brings it back. That is the same sentence update_secret is guarded by
        // and the same damage delete_registry — two-step, right below — does.
        // Correcting a username destroys nothing and stays one call.
        if (password === undefined) return apply();

        return guarded(
          server,
          mcp,
          approval,
          confirmations,
          {
            tool: 'update_registry',
            targets: [
              `scope:${scope}`,
              `repo:${repo_id ?? ''}`,
              `org:${org_id ?? ''}`,
              `address:${address}`,
              `body:${fingerprint(body)}`,
            ],
            what: `replace the password stored for the registry "${identifier(address, 'registry address')}" of ${where}`,
            consequence:
              'The current password cannot be recovered — Woodpecker strips it ' +
              'from every response. If the new one is wrong, pipelines pulling ' +
              'private images from that registry fail at the pull step.',
            confirmToken: confirm_token,
          },
          apply
        );
      })
  );

  server.registerTool(
    'delete_registry',
    {
      title: 'Delete registry credentials',
      description:
        'Removes stored credentials for a registry. Pipelines that pull private ' +
        'images from it start failing at the pull step. Two-step.',
      inputSchema: z.object({
        scope: scopeParam,
        ...scopeArguments,
        address: registryAddressParam,
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
    async ({ scope, repo_id, org_id, address, confirm_token }, mcp) =>
      run(async () => {
        const base = scopeBase('registries', scope, { repo_id, org_id });
        const where = scopeLabel(scope, { repo_id, org_id });
        return guarded(
          server,
          mcp,
          approval,
          confirmations,
          {
            tool: 'delete_registry',
            targets: [
              `scope:${scope}`,
              `repo:${repo_id ?? ''}`,
              `org:${org_id ?? ''}`,
              `address:${address}`,
            ],
            what: `delete the registry credentials for "${identifier(address, 'registry address')}" of ${where}`,
            consequence:
              'The password cannot be recovered, and pipelines pulling private ' +
              'images from that registry will fail.',
            confirmToken: confirm_token,
          },
          async () => {
            await api.delete(
              `${base}/${pathSegment(address, 'registry address')}`
            );
            return sentenceResult(
              `Registry credentials for "${address}" of ${where} were deleted.`,
              { deleted_registry: address, scope: where }
            );
          }
        );
      })
  );
}

import { z } from 'zod';
import type { McpServer, CallToolResult } from '@modelcontextprotocol/server';
import {
  confirmTokenParam,
  eventsParam,
  pageParam,
  perPageParam,
  scopeParam,
  secretNameParam,
} from '../schema.js';

import { pathSegment, query } from '../api.js';
import { identifier } from '../resource-key.js';
import { guarded } from '../guard.js';
import { listOf } from '../normalize.js';
import { budgetedList, jsonResult, run, textResult } from '../result.js';
import type { ToolContext } from './context.js';
import { scopeArguments, scopeBase, scopeLabel } from './scope.js';

/**
 * Images a secret may be exposed to.
 *
 * An empty list means "every image", which is the default and what almost
 * everyone wants; a non-empty list is a real restriction and a common cause of
 * "the secret is set but the step does not see it".
 */
const imagesParam = z
  .array(z.string().trim().min(1).max(200))
  .max(50)
  .describe(
    'Restrict the secret to these container images. An empty list — the default ' +
      '— means every image may read it.'
  );

const noteParam = z
  .string()
  .trim()
  .max(500)
  .describe('Free-text note shown next to the secret in the web UI.');

export function registerSecretTools(
  server: McpServer,
  { api, confirmations, approval, readOnly }: ToolContext
): void {
  server.registerTool(
    'list_secrets',
    {
      title: 'List secrets',
      description:
        'Lists the secrets at one level — repository, organization or instance-wide. ' +
        'Values are never returned by Woodpecker, not even here; you get names, ' +
        'events and image restrictions. Note that a pipeline sees all three levels, ' +
        'so a name missing here may still exist one level up.',
      inputSchema: z.object({
        scope: scopeParam,
        ...scopeArguments,
        page: pageParam.optional(),
        per_page: perPageParam.optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ scope, repo_id, org_id, page, per_page }) =>
      run(async () => {
        const base = scopeBase('secrets', scope, { repo_id, org_id });
        const secrets = await api.get(
          `${base}${query({ page, perPage: per_page })}`
        );
        return budgetedList('secrets', listOf(secrets, 'secrets'), {
          extra: {
            scope: scopeLabel(scope, { repo_id, org_id }),
            note: 'Secret values are never returned by the Woodpecker API.',
          },
        });
      })
  );

  server.registerTool(
    'get_secret',
    {
      title: 'Get a secret',
      description:
        "Returns one secret's metadata: which events and images it applies to, and " +
        'its note. The value is not part of the answer — Woodpecker strips it from ' +
        'every response, including the one right after creating it.',
      inputSchema: z.object({
        scope: scopeParam,
        ...scopeArguments,
        name: secretNameParam,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ scope, repo_id, org_id, name }) =>
      run(async () => {
        const base = scopeBase('secrets', scope, { repo_id, org_id });
        return jsonResult(
          await api.get(`${base}/${pathSegment(name, 'secret name')}`)
        );
      })
  );

  if (readOnly) return;

  server.registerTool(
    'create_secret',
    {
      title: 'Create a secret',
      description:
        'Creates a secret at the chosen level. The value is write-only: it is never ' +
        'readable again through the API, so store it somewhere else too. At least ' +
        'one event is required — the API has no defaults, and a secret without ' +
        'pull_request is invisible to pull-request builds.',
      inputSchema: z.object({
        scope: scopeParam,
        ...scopeArguments,
        name: secretNameParam,
        value: z
          .string()
          .min(1)
          .max(100_000)
          .describe('The secret value. Write-only — it cannot be read back.'),
        events: eventsParam,
        images: imagesParam.optional(),
        note: noteParam.optional(),
      }),
    },
    async ({ scope, repo_id, org_id, name, value, events, images, note }) =>
      run(async () => {
        const base = scopeBase('secrets', scope, { repo_id, org_id });
        const body: Record<string, unknown> = { name, value, events };
        if (images !== undefined) body.images = images;
        if (note !== undefined) body.note = note;
        const created = await api.post(base, body);
        return jsonResult({
          secret: created,
          note:
            `Created at ${scopeLabel(scope, { repo_id, org_id })}. The value is not ` +
            'part of this answer and cannot be read back later.',
        });
      })
  );

  server.registerTool(
    'update_secret',
    {
      title: 'Update a secret',
      description:
        'Changes a secret. Only the fields you pass are touched — but "events" and ' +
        '"images" are replaced wholesale, not merged, so pass the complete list. ' +
        'Passing "value" rotates the secret.',
      inputSchema: z.object({
        scope: scopeParam,
        ...scopeArguments,
        name: secretNameParam,
        value: z
          .string()
          .min(1)
          .max(100_000)
          .optional()
          .describe('New value. Omit it to leave the value alone.'),
        events: eventsParam
          .optional()
          .describe(
            'Replaces the event list entirely. Pass every event that should apply.'
          ),
        images: imagesParam.optional(),
        note: noteParam.optional(),
        confirm_token: confirmTokenParam
          .optional()
          .describe(
            'Required only when passing "value"; changing events, images or the ' +
              'note applies on the first call.'
          ),
      }),
    },
    async (
      {
        scope,
        repo_id,
        org_id,
        name,
        value,
        events,
        images,
        note,
        confirm_token,
      },
      mcp
    ) =>
      run(async () => {
        const base = scopeBase('secrets', scope, { repo_id, org_id });
        const where = scopeLabel(scope, { repo_id, org_id });
        const body: Record<string, unknown> = {};
        if (value !== undefined) body.value = value;
        if (events !== undefined) body.events = events;
        if (images !== undefined) body.images = images;
        if (note !== undefined) body.note = note;
        if (Object.keys(body).length === 0) {
          return textResult(
            'Nothing to update — pass value, events, images or note.'
          );
        }

        const apply = async (): Promise<CallToolResult> => {
          const updated = await api.patch(
            `${base}/${pathSegment(name, 'secret name')}`,
            body
          );
          return jsonResult({ secret: updated });
        };

        // Rotating the value is guarded for the same reason deleting the secret
        // is: the old value was never readable through the API, so overwriting
        // it destroys it just as completely. Editing the events or the note is
        // reversible and applies straight away.
        if (value === undefined) return apply();

        return guarded(
          server,
          mcp,
          approval,
          confirmations,
          {
            tool: 'update_secret',
            targets: [
              scope,
              String(repo_id ?? ''),
              String(org_id ?? ''),
              name,
              'value',
            ],
            what: `overwrite the value of the secret "${identifier(name, 'secret name')}" of ${where}`,
            consequence:
              'The current value cannot be recovered — it was never readable ' +
              'through the API. Pipelines pick up the new one on their next run.',
            confirmToken: confirm_token,
          },
          apply
        );
      })
  );

  server.registerTool(
    'delete_secret',
    {
      title: 'Delete a secret',
      description:
        'Deletes a secret. Any pipeline that reads it starts failing — or worse, ' +
        'keeps running with an empty value. Two-step.',
      inputSchema: z.object({
        scope: scopeParam,
        ...scopeArguments,
        name: secretNameParam,
        confirm_token: confirmTokenParam.optional(),
      }),
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ scope, repo_id, org_id, name, confirm_token }, mcp) =>
      run(async () => {
        const base = scopeBase('secrets', scope, { repo_id, org_id });
        const where = scopeLabel(scope, { repo_id, org_id });
        return guarded(
          server,
          mcp,
          approval,
          confirmations,
          {
            tool: 'delete_secret',
            targets: [scope, String(repo_id ?? ''), String(org_id ?? ''), name],
            what: `delete the secret "${identifier(name, 'secret name')}" of ${where}`,
            consequence:
              'The value cannot be recovered — it was never readable through the ' +
              'API. Pipelines using it will run without it.',
            confirmToken: confirm_token,
          },
          async () => {
            await api.delete(`${base}/${pathSegment(name, 'secret name')}`);
            return textResult(`Secret "${name}" of ${where} was deleted.`);
          }
        );
      })
  );
}

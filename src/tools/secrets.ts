import { z } from 'zod';
import { plain } from '../output-schema.js';
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
import { READ_ONLY } from './annotations.js';
import { fingerprint, identifier } from '../resource-key.js';
import { guarded } from '../guard.js';
import { listOf, objectOf, redactSecret } from '../normalize.js';
import {
  errorResult,
  budgetedList,
  jsonResult,
  run,
  sentenceResult,
} from '../result.js';
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
      annotations: READ_ONLY,
      outputSchema: plain(),
    },
    async ({ scope, repo_id, org_id, page, per_page }) =>
      run(async () => {
        const base = scopeBase('secrets', scope, { repo_id, org_id });
        const secrets = await api.get(
          `${base}${query({ page, perPage: per_page })}`
        );
        return budgetedList(
          'secrets',
          listOf(secrets, 'secrets').map(redactSecret),
          {
            extra: {
              scope: scopeLabel(scope, { repo_id, org_id }),
              note: 'Secret values are never returned by the Woodpecker API.',
            },
          }
        );
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
      annotations: READ_ONLY,
      outputSchema: plain(),
    },
    async ({ scope, repo_id, org_id, name }) =>
      run(async () => {
        const base = scopeBase('secrets', scope, { repo_id, org_id });
        return jsonResult(
          redactSecret(
            objectOf(
              await api.get(`${base}/${pathSegment(name, 'secret name')}`),
              'secret'
            )
          )
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
      annotations: {
        // Additive. Woodpecker refuses a name that already exists, so this
        // cannot quietly overwrite the value update_secret guards.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      outputSchema: plain(),
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
            'Required when passing "value", when adding a pull_request event, or ' +
              'when clearing "images"; narrowing the exposure and changing the ' +
              'note apply on the first call.'
          ),
      }),
      annotations: {
        // Replaces a secret value that was never readable through the API.
        // Nothing can bring the old one back.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      outputSchema: plain(),
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
          return errorResult(
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

        // Two reasons to stop here, and they are different reasons.
        //
        // Rotating the value is guarded because the old value was never readable
        // through the API, so overwriting it destroys it just as completely as
        // delete_secret does.
        //
        // Widening the exposure is guarded because `events` and `images` are the
        // secret's confidentiality boundary, not cosmetics. Adding a
        // pull_request event hands the secret to builds of code that came from a
        // fork — the very thing approve_pipeline exists to put a person in front
        // of — and an empty `images` list means every container image may read
        // it. Calling that "reversible" misses the point: reversible, yes, but
        // the secret has been read by then. Narrowing either direction, and
        // editing the note, still applies on the first call.
        const widened = await widening({ base, name, events, images });
        if (value === undefined && widened.length === 0) return apply();

        const changes = [
          value !== undefined ? 'overwrite its value' : undefined,
          widened.includes('events')
            ? 'let pull-request builds read it'
            : undefined,
          widened.includes('images')
            ? 'let every container image read it'
            : undefined,
        ].filter((part): part is string => part !== undefined);

        return guarded(
          server,
          mcp,
          approval,
          confirmations,
          {
            tool: 'update_secret',
            targets: [
              `scope:${scope}`,
              `repo:${repo_id ?? ''}`,
              `org:${org_id ?? ''}`,
              `secret:${name}`,
              ...widened.map((field) => `widen:${field}`),
              `body:${fingerprint(body)}`,
            ],
            what: `change the secret "${identifier(name, 'secret name')}" of ${where}: ${changes.join(', ')}`,
            consequence: [
              value !== undefined
                ? 'The current value cannot be recovered — it was never readable ' +
                  'through the API. Pipelines pick up the new one on their next run.'
                : undefined,
              widened.includes('events')
                ? 'A pull-request build runs code from whoever opened it, including ' +
                  'from a fork, and this secret is injected into it.'
                : undefined,
              widened.includes('images')
                ? 'An empty image list removes the restriction that limited which ' +
                  'images the secret is exposed to.'
                : undefined,
            ]
              .filter(Boolean)
              .join(' '),
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
            targets: [
              `scope:${scope}`,
              `repo:${repo_id ?? ''}`,
              `org:${org_id ?? ''}`,
              `secret:${name}`,
            ],
            what: `delete the secret "${identifier(name, 'secret name')}" of ${where}`,
            consequence:
              'The value cannot be recovered — it was never readable through the ' +
              'API. Pipelines using it will run without it.',
            confirmToken: confirm_token,
          },
          async () => {
            await api.delete(`${base}/${pathSegment(name, 'secret name')}`);
            return sentenceResult(`Secret "${name}" of ${where} was deleted.`, {
              deleted_secret: name,
              scope: where,
            });
          }
        );
      })
  );
  /**
   * Which of the secret's confidentiality boundaries this call loosens.
   *
   * "Loosens" is a comparison, so the current state has to be read: a call that
   * simply repeats the events a secret already has changes nothing, and asking
   * about it would train whoever reads these prompts to click through them —
   * which costs more than it buys. The read only happens when `events` or
   * `images` is actually in the call, so rotating a value or fixing a note is
   * still one request.
   *
   * Nothing read here reaches the confirmation text. It is compared against, and
   * the sentence a person sees is built from this server's own vocabulary — the
   * rule the whole `guarded` family follows.
   */
  async function widening(input: {
    base: string;
    name: string;
    events: string[] | undefined;
    images: string[] | undefined;
  }): Promise<string[]> {
    if (input.events === undefined && input.images === undefined) return [];
    const current = objectOf(
      await api.get(`${input.base}/${pathSegment(input.name, 'secret name')}`),
      'secret'
    );
    const widened: string[] = [];
    const currentEvents = Array.isArray(current.events)
      ? current.events.map(String)
      : [];
    // Every pull_request* event is a fork's code running with this secret in
    // its environment; the other events are triggered by someone who can
    // already push.
    if (
      input.events?.some(
        (event) =>
          event.startsWith('pull_request') && !currentEvents.includes(event)
      )
    ) {
      widened.push('events');
    }
    const currentImages = Array.isArray(current.images) ? current.images : [];
    if (input.images?.length === 0 && currentImages.length > 0) {
      widened.push('images');
    }
    return widened;
  }
}

import { z } from 'zod';
import type { McpServer, CallToolResult } from '@modelcontextprotocol/server';
import {
  budgetedJsonResult,
  budgetedList,
  budgetedUntrustedResult,
  jsonResult,
  run,
  textResult,
} from '../result.js';
import {
  confirmTokenParam,
  pageParam,
  perPageParam,
  repoFullNameParam,
  repoIdParam,
} from '../schema.js';

import { pathSegment, query } from '../api.js';
import { READ_ONLY } from './annotations.js';
import { fingerprint } from '../resource-key.js';
import { guarded } from '../guard.js';
import { listOf, objectOf, summarizeRepo } from '../normalize.js';
import type { ToolContext } from './context.js';

export function registerRepoTools(
  server: McpServer,
  { api, confirmations, approval, readOnly }: ToolContext
): void {
  server.registerTool(
    'list_repositories',
    {
      title: 'List repositories',
      description:
        'Lists repositories. By default the ones the authenticated account can ' +
        'see in Woodpecker; with include_inactive it also lists repositories that ' +
        'exist in the forge but were never activated, which is where the ' +
        'forge_remote_id for activate_repository comes from. scope="instance" ' +
        'lists every repository on the server and needs an administrator.',
      inputSchema: z.object({
        scope: z
          .enum(['account', 'instance'])
          .optional()
          .describe(
            'Default "account". "instance" lists all repositories on the server (admin only).'
          ),
        include_inactive: z
          .boolean()
          .optional()
          .describe(
            'Also list repositories from the forge that are not activated in ' +
              'Woodpecker. Only meaningful for scope="account"; it makes the call ' +
              'noticeably slower because Woodpecker refreshes them from the forge.'
          ),
        name: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe(
            'Substring filter on the repository name (account scope only).'
          ),
        page: pageParam.optional(),
        per_page: perPageParam.optional(),
      }),
      annotations: READ_ONLY,
    },
    async ({ scope, include_inactive, name, page, per_page }) =>
      run(async () => {
        const path =
          scope === 'instance'
            ? `/repos${query({ page, perPage: per_page })}`
            : `/user/repos${query({ all: include_inactive, name })}`;
        const repos = listOf(await api.get(path), 'repositories');
        return budgetedList('repositories', repos.map(summarizeRepo), {
          extra: {
            note:
              scope === 'instance'
                ? undefined
                : 'The account scope is not paginated by Woodpecker — use "name" to narrow it.',
          },
          narrowWith: 'Narrow with "name", or page through with "page".',
        });
      })
  );

  server.registerTool(
    'get_repository',
    {
      title: 'Get repository',
      description:
        'Returns the full Woodpecker configuration of one repository: trusted ' +
        'flags, timeout, approval mode, config file path and the extension endpoints.',
      inputSchema: z.object({ repo_id: repoIdParam }),
      annotations: READ_ONLY,
    },
    async ({ repo_id }) =>
      run(async () =>
        budgetedJsonResult(
          objectOf(await api.get(`/repos/${repo_id}`), 'repository')
        )
      )
  );

  server.registerTool(
    'lookup_repository',
    {
      title: 'Look up a repository by name',
      description:
        'Resolves an "owner/name" pair to a repository id. Every other repository ' +
        'tool takes the numeric id, and this is how you get one. A repository that ' +
        'exists in the forge but was never activated in Woodpecker answers 404 — ' +
        'use list_repositories with include_inactive to find it.',
      inputSchema: z.object({ full_name: repoFullNameParam }),
      annotations: READ_ONLY,
    },
    async ({ full_name }) =>
      run(async () =>
        budgetedJsonResult(
          objectOf(
            await api.get(
              `/repos/lookup/${pathSegment(full_name, 'repository name')}`
            ),
            'repository'
          )
        )
      )
  );

  server.registerTool(
    'get_repository_permissions',
    {
      title: 'Get repository permissions',
      description:
        'What the authenticated account may do with this repository: pull, push ' +
        'and admin. Woodpecker inherits these from the forge, so this answers "why ' +
        'was that 403" without guessing.',
      inputSchema: z.object({ repo_id: repoIdParam }),
      annotations: READ_ONLY,
    },
    async ({ repo_id }) =>
      run(async () =>
        jsonResult(await api.get(`/repos/${repo_id}/permissions`))
      )
  );

  server.registerTool(
    'list_repository_branches',
    {
      title: 'List branches',
      description:
        'Lists the branches of a repository, as Woodpecker sees them in the forge. ' +
        'Useful before trigger_pipeline, which fails with a bare 400 on a branch ' +
        'that does not exist.',
      inputSchema: z.object({
        repo_id: repoIdParam,
        page: pageParam.optional(),
        per_page: perPageParam.optional(),
      }),
      annotations: READ_ONLY,
    },
    async ({ repo_id, page, per_page }) =>
      run(async () => {
        const branches = await api.get(
          `/repos/${repo_id}/branches${query({ page, perPage: per_page })}`
        );
        return budgetedList('branches', listOf(branches, 'branches'), {
          narrowWith: 'Page through with "page".',
          untrusted: true,
        });
      })
  );

  server.registerTool(
    'list_pull_requests',
    {
      title: 'List open pull requests',
      description:
        'Lists the open pull requests of a repository, with the index a pipeline ' +
        'ref like "refs/pull/42/head" refers to.',
      inputSchema: z.object({
        repo_id: repoIdParam,
        page: pageParam.optional(),
        per_page: perPageParam.optional(),
      }),
      annotations: READ_ONLY,
    },
    async ({ repo_id, page, per_page }) =>
      run(async () => {
        const pulls = await api.get(
          `/repos/${repo_id}/pull_requests${query({ page, perPage: per_page })}`
        );
        return budgetedUntrustedResult({
          pull_requests: listOf(pulls, 'pull requests'),
        });
      })
  );

  if (readOnly) return;

  server.registerTool(
    'activate_repository',
    {
      title: 'Activate repository',
      description:
        'Turns on Woodpecker for a repository that exists in the forge, which ' +
        'installs the webhook and makes pipelines run. Takes the forge-side id, ' +
        'NOT an owner/name pair and not a Woodpecker id — call list_repositories ' +
        'with include_inactive=true and read forge_remote_id from the entry.',
      inputSchema: z.object({
        forge_remote_id: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .regex(/^[A-Za-z0-9._-]+$/, 'must be the forge-side repository id')
          .describe(
            'The repository id as the forge knows it (field forge_remote_id), not ' +
              'the Woodpecker repo_id.'
          ),
      }),
      annotations: {
        // Additive: it starts watching a repository. Activating one that is
        // already active leaves it active.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ forge_remote_id }) =>
      run(async () =>
        budgetedJsonResult(
          objectOf(
            await api.post(`/repos${query({ forge_remote_id })}`),
            'repository'
          )
        )
      )
  );

  server.registerTool(
    'update_repository',
    {
      title: 'Update repository settings',
      description:
        'Changes Woodpecker settings of a repository. Only the fields you pass are ' +
        'touched. Note that "trusted" grants pipelines of this repository elevated ' +
        'container privileges and is an administrator-only change.',
      inputSchema: z.object({
        repo_id: repoIdParam,
        config_file: z
          .string()
          .trim()
          .max(500)
          .optional()
          .describe(
            'Path to the pipeline config, e.g. ".woodpecker.yml" or a directory ' +
              'like ".woodpecker/". Empty string restores the default.'
          ),
        timeout: z
          .number()
          .int()
          .min(1)
          .max(10_080)
          .optional()
          .describe('Pipeline timeout in minutes.'),
        visibility: z
          .enum(['public', 'private', 'internal'])
          .optional()
          .describe(
            '"public" shows builds to anyone, "internal" to logged-in users, ' +
              '"private" only to people with forge access.'
          ),
        allow_pr: z
          .boolean()
          .optional()
          .describe('Run pipelines for pull requests.'),
        allow_deploy: z
          .boolean()
          .optional()
          .describe('Allow deployment events for this repository.'),
        require_approval: z
          .enum(['none', 'forks', 'pull_requests', 'all_events'])
          .optional()
          .describe(
            'Which events wait for a human. "forks" is the default and the one ' +
              'that keeps a fork from running arbitrary code with your secrets.'
          ),
        cancel_previous_pipeline_events: z
          .array(
            z.enum([
              'push',
              'pull_request',
              'pull_request_closed',
              'pull_request_metadata',
              'tag',
              'release',
              'deployment',
              'cron',
              'manual',
            ])
          )
          .max(9)
          .optional()
          .describe(
            'Events where a new pipeline cancels the still-running previous one.'
          ),
        trusted_network: z
          .boolean()
          .optional()
          .describe('Admin only: allow pipelines to use the host network.'),
        trusted_volumes: z
          .boolean()
          .optional()
          .describe('Admin only: allow pipelines to mount host volumes.'),
        trusted_security: z
          .boolean()
          .optional()
          .describe(
            'Admin only: allow privileged containers. This lets a pipeline take ' +
              'over the agent host.'
          ),
        confirm_token: confirmTokenParam
          .optional()
          .describe(
            'Required when granting one of the trusted_* flags, when lowering ' +
              '"require_approval", or when setting visibility to "public"; every ' +
              'other change applies on the first call.'
          ),
      }),
      annotations: {
        // Replaces repository settings, and is the tool that can grant
        // elevated trust — guarded for that reason.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (
      {
        repo_id,
        trusted_network,
        trusted_volumes,
        trusted_security,
        confirm_token,
        ...fields
      },
      mcp
    ) =>
      run(async () => {
        const body: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(fields)) {
          if (value !== undefined) body[key] = value;
        }
        const trusted: Record<string, boolean> = {};
        if (trusted_network !== undefined) trusted.network = trusted_network;
        if (trusted_volumes !== undefined) trusted.volumes = trusted_volumes;
        if (trusted_security !== undefined) trusted.security = trusted_security;
        if (Object.keys(trusted).length > 0) body.trusted = trusted;

        if (Object.keys(body).length === 0) {
          return textResult(
            'Nothing to update — pass at least one field. get_repository shows the ' +
              'current values.'
          );
        }

        const apply = async (): Promise<CallToolResult> =>
          budgetedJsonResult(
            objectOf(await api.patch(`/repos/${repo_id}`, body), 'repository')
          );

        // Only *granting* trust is two-step. These three flags let a pipeline of
        // this repository take the host network, mount arbitrary host paths and
        // run privileged containers — which is the agent host, not just the
        // repository. Withdrawing trust, and every other field, applies straight
        // away: a confirmation on the safe direction is noise.
        const granted = Object.entries(trusted)
          .filter(([, value]) => value)
          .map(([key]) => key);

        // Same rule, applied to the two fields that are the fork gate itself.
        // `require_approval` decides whether a pipeline built from a fork waits
        // for a person before it runs with this repository's secrets — the exact
        // decision approve_pipeline is guarded for — and `visibility: public`
        // decides who may then read the log that build writes. Setting the two
        // together turns the sharpest gate in this server off in one unguarded
        // call, which made every confirmation on approve_pipeline optional.
        // Tightening either stays free, in the same direction-aware way.
        const loosened = await loosening(repo_id, fields);

        if (granted.length === 0 && loosened.length === 0) return apply();

        const what = [
          granted.length > 0
            ? `grant repository ${repo_id} elevated trust (${granted.join(', ')})`
            : undefined,
          loosened.includes('require_approval')
            ? `stop requiring approval for repository ${repo_id} (require_approval="${fields.require_approval}")`
            : undefined,
          loosened.includes('visibility')
            ? `make the pipelines of repository ${repo_id} publicly readable`
            : undefined,
        ].filter((part): part is string => part !== undefined);

        return guarded(
          server,
          mcp,
          approval,
          confirmations,
          {
            tool: 'update_repository',
            targets: [
              `repo:${repo_id}`,
              ...granted.map((key) => `trusted:${key}`),
              ...loosened.map((key) => `loosen:${key}`),
              `body:${fingerprint(body)}`,
            ],
            what: what.join(', and '),
            consequence: [
              granted.length > 0
                ? 'Pipelines of this repository may then use the host network, ' +
                  'mount host paths and run privileged containers. Anyone who ' +
                  'can push to it can take over the agent that runs it.'
                : undefined,
              loosened.includes('require_approval')
                ? 'Fewer pipelines wait for a person, so code from a fork can run ' +
                  "with this repository's secrets without anyone approving it."
                : undefined,
              loosened.includes('visibility')
                ? 'Build logs become readable by anyone, including whatever a step ' +
                  'printed into them.'
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
    'repair_repository',
    {
      title: 'Repair repository webhooks',
      description:
        'Re-installs the forge webhook and refreshes the stored repository data. ' +
        'This is the fix for "pushes no longer start a pipeline" after a repository ' +
        'was renamed or the Woodpecker URL changed. With scope="instance" it does ' +
        'that for every repository on the server, which is two-step and hits the ' +
        'forge API once per repository.',
      inputSchema: z.object({
        repo_id: repoIdParam
          .optional()
          .describe(
            'The repository to repair. Omit it only together with scope="instance".'
          ),
        scope: z
          .enum(['repository', 'instance'])
          .optional()
          .describe(
            'Default "repository". "instance" repairs all of them (admin only).'
          ),
        confirm_token: confirmTokenParam.optional(),
      }),
      annotations: {
        // Rewrites webhooks to what they should be. Idempotent by design —
        // that is what repairing means.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ repo_id, scope, confirm_token }, mcp) =>
      run(async () => {
        if (scope === 'instance') {
          return guarded(
            server,
            mcp,
            approval,
            confirmations,
            {
              tool: 'repair_repository',
              targets: ['instance'],
              what: 'repair every repository on this Woodpecker instance',
              consequence:
                'Woodpecker rewrites the webhook of every activated repository and ' +
                'calls the forge once for each, which is slow on a large instance ' +
                'and shows up in the forge audit log.',
              confirmToken: confirm_token,
            },
            async () => {
              await api.post('/repos/repair');
              return textResult('Repaired every repository on the instance.');
            }
          );
        }
        if (repo_id === undefined) {
          return textResult(
            'repair_repository needs a repo_id, or scope="instance" to repair all of them.'
          );
        }
        await api.post(`/repos/${repo_id}/repair`);
        return textResult(
          `Repaired repository ${repo_id}: its forge webhook was re-installed and its data refreshed.`
        );
      })
  );

  server.registerTool(
    'move_repository',
    {
      title: 'Move repository to a new owner',
      description:
        'Tells Woodpecker that a repository moved to a different owner or name in ' +
        'the forge. It does NOT move anything in the forge — do that first, then ' +
        'call this so Woodpecker follows. Two-step. ' +
        'IMPORTANT, verified against 3.11: this endpoint performs the move and ' +
        'THEN answers HTTP 500 ("could not determine repo for permission") when ' +
        'the caller is an instance administrator. The move has happened — read ' +
        'the repository back with get_repository before deciding anything, and do ' +
        'not retry, which would move it a second time. Most of the time the call ' +
        'is not needed at all: forges that send webhooks report a rename and ' +
        'Woodpecker follows it by itself, and calling this afterwards fails on a ' +
        'duplicate redirection.',
      inputSchema: z.object({
        repo_id: repoIdParam,
        to: repoFullNameParam.describe(
          'The new full name in "owner/name" form, as it now reads in the forge.'
        ),
        confirm_token: confirmTokenParam.optional(),
      }),
      annotations: {
        // Points Woodpecker at a different forge repository. If the move
        // did not happen in the forge first, it loses track of the old one.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ repo_id, to, confirm_token }, mcp) =>
      run(async () =>
        guarded(
          server,
          mcp,
          approval,
          confirmations,
          {
            tool: 'move_repository',
            targets: [`repo:${repo_id}`, `to:${to}`],
            what: `point Woodpecker's repository ${repo_id} at a different forge repository`,
            consequence:
              'If the repository was not actually moved in the forge first, ' +
              'Woodpecker loses track of it and its pipelines stop running.',
            confirmToken: confirm_token,
          },
          async () => {
            await api.post(`/repos/${repo_id}/move${query({ to })}`);
            return textResult(
              `Repository ${repo_id} now points at the new location.`
            );
          }
        )
      )
  );

  server.registerTool(
    'chown_repository',
    {
      title: 'Take ownership of a repository',
      description:
        "Makes the authenticated account the repository's owner in Woodpecker. The " +
        "owner's forge token is what Woodpecker uses to read the repository and " +
        'report build status, so this is the fix when the previous owner left. ' +
        'Asks a person first; where the client cannot show a dialog, call once ' +
        'to receive a token and again with it.',
      inputSchema: z.object({
        repo_id: repoIdParam,
        confirm_token: confirmTokenParam.optional(),
      }),
      annotations: {
        // Transfers which forge token the pipelines run under. The previous
        // owner relationship is not kept anywhere.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ repo_id, confirm_token }, mcp) =>
      run(async () =>
        // Guarded because of what the ownership *is*: every pipeline of this
        // repository afterwards runs under the calling account's forge token,
        // so its reach over the forge becomes this repository's reach.
        // `delete_user` already cites that in its own reasoning; the tool that
        // performs the transfer did not ask.
        guarded(
          server,
          mcp,
          approval,
          confirmations,
          {
            tool: 'chown_repository',
            targets: [`repo:${repo_id}`],
            what: `take ownership of repository ${repo_id}`,
            consequence:
              'Every pipeline of this repository will run under the calling ' +
              "account's forge token from now on, and the previous owner " +
              'relationship is not kept anywhere.',
            confirmToken: confirm_token,
          },
          async () =>
            budgetedJsonResult(
              objectOf(await api.post(`/repos/${repo_id}/chown`), 'repository')
            )
        )
      )
  );

  server.registerTool(
    'delete_repository',
    {
      title: 'Delete repository',
      description:
        'Removes a repository from Woodpecker: the webhook, every pipeline, all ' +
        'logs, secrets, registries and cron jobs of that repository. The forge ' +
        'repository itself is untouched. Two-step.',
      inputSchema: z.object({
        repo_id: repoIdParam,
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
    },
    async ({ repo_id, confirm_token }, mcp) =>
      run(async () =>
        guarded(
          server,
          mcp,
          approval,
          confirmations,
          {
            tool: 'delete_repository',
            targets: [`repo:${repo_id}`],
            what: `delete repository ${repo_id} from Woodpecker`,
            consequence:
              'Its pipeline history, build logs, secrets, registries and cron jobs ' +
              'go with it and cannot be restored. The repository in the forge is ' +
              'not affected.',
            confirmToken: confirm_token,
          },
          async () => {
            await api.delete(`/repos/${repo_id}`);
            return textResult(
              `Repository ${repo_id} was deleted from Woodpecker.`
            );
          }
        )
      )
  );
  /**
   * The strictness order of `require_approval`, weakest first.
   *
   * "none" runs everything unattended; "forks" — the default — stops the
   * pipelines that carry someone else's code; "pull_requests" adds the ones from
   * this repository's own branches; "all_events" stops everything.
   */
  const APPROVAL_ORDER = ['none', 'forks', 'pull_requests', 'all_events'];

  /**
   * Which confidentiality boundaries of a repository this update lowers.
   *
   * A comparison, so the current settings have to be read — and only when one of
   * the two fields is in the call, so an ordinary timeout or config_file change
   * is still a single request. A repository whose `require_approval` this server
   * does not recognise counts as stricter than anything, so an unexpected
   * upstream value asks rather than waves the change through.
   *
   * Nothing read here reaches the confirmation text; the sentence a person sees
   * is built from the enum values in this file's own input schema.
   */
  async function loosening(
    repo_id: number,
    fields: {
      visibility?: string | undefined;
      require_approval?: string | undefined;
    }
  ): Promise<string[]> {
    if (
      fields.visibility === undefined &&
      fields.require_approval === undefined
    ) {
      return [];
    }
    const current = objectOf(await api.get(`/repos/${repo_id}`), 'repository');
    const lowered: string[] = [];
    if (fields.require_approval !== undefined) {
      const index = APPROVAL_ORDER.indexOf(String(current.require_approval));
      const before = index === -1 ? APPROVAL_ORDER.length : index;
      if (APPROVAL_ORDER.indexOf(fields.require_approval) < before) {
        lowered.push('require_approval');
      }
    }
    if (fields.visibility === 'public' && current.visibility !== 'public') {
      lowered.push('visibility');
    }
    return lowered;
  }
}

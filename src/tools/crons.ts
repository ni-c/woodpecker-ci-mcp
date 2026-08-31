import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  budgetedList,
  budgetedUntrustedResult,
  jsonResult,
  run,
  textResult,
} from '../result.js';
import {
  branchParam,
  confirmTokenParam,
  cronIdParam,
  pageParam,
  perPageParam,
  repoIdParam,
} from '../schema.js';

import { query } from '../api.js';
import { guarded } from '../guard.js';
import { listOf, summarizeCron } from '../normalize.js';
import type { ToolContext } from './context.js';

const nameParam = z
  .string()
  .trim()
  .min(1)
  .max(250)
  .describe(
    'Name of the cron job, shown in the UI and on the pipelines it starts.'
  );

/**
 * A cron schedule.
 *
 * Woodpecker 3.18.0 validates these with `gdgvda/cron` under `StandardOptions`,
 * which is `Minute | Hour | Dom | Month | Dow | Descriptor` — so five fields,
 * exactly like a crontab line, plus the `@`-descriptors and `@every <duration>`.
 * Worth stating explicitly because the sibling libraries in this corner of the
 * Go ecosystem default to a *six*-field form that starts with seconds, and a
 * schedule written that way is silently an hour out rather than rejected.
 */
const scheduleParam = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe(
    'Schedule as a five-field cron expression ("0 4 * * *" is 04:00 daily), a ' +
      'descriptor (@yearly, @annually, @monthly, @weekly, @daily, @midnight, ' +
      '@hourly), or "@every <duration>" such as "@every 30m". No seconds field.'
  );

/**
 * The schedule's time zone.
 *
 * Woodpecker resolves it with Go's `time.LoadLocation`, which reads the system
 * zoneinfo database — and the official `woodpeckerci/woodpecker-server` image is
 * distroless and ships none. On a stock Docker install, anything but `UTC` comes
 * back as `can't parse timezone: unknown time zone Europe/Berlin`, which reads
 * like a typo rather than a missing file. Verified against 3.18.0 on 2026-08-27.
 */
const timezoneParam = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(
    /^[A-Za-z0-9_+\-/]+$/,
    'must be an IANA time zone name such as "Europe/Berlin"'
  )
  .describe(
    'IANA time zone the schedule is interpreted in. Defaults to UTC. Note that ' +
      'the official Woodpecker container image carries no time zone database, so ' +
      'on a stock Docker deployment anything but "UTC" is rejected with "unknown ' +
      'time zone" — that is the server missing tzdata, not a wrong name.'
  );

export function registerCronTools(
  server: McpServer,
  { api, confirmations, readOnly }: ToolContext
): void {
  server.registerTool(
    'list_crons',
    {
      title: 'List cron jobs',
      description:
        'Lists the scheduled pipeline runs of a repository, with the next execution ' +
        'time of each.',
      inputSchema: z.object({
        repo_id: repoIdParam,
        page: pageParam.optional(),
        per_page: perPageParam.optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ repo_id, page, per_page }) =>
      run(async () => {
        const crons = await api.get(
          `/repos/${repo_id}/cron${query({ page, perPage: per_page })}`
        );
        return budgetedList(
          'crons',
          listOf(crons, 'cron jobs').map(summarizeCron)
        );
      })
  );

  server.registerTool(
    'get_cron',
    {
      title: 'Get a cron job',
      description: 'Returns one cron job, including the variables it passes.',
      inputSchema: z.object({ repo_id: repoIdParam, cron_id: cronIdParam }),
      annotations: { readOnlyHint: true },
    },
    async ({ repo_id, cron_id }) =>
      run(async () =>
        jsonResult(await api.get(`/repos/${repo_id}/cron/${cron_id}`))
      )
  );

  if (readOnly) return;

  server.registerTool(
    'create_cron',
    {
      title: 'Create a cron job',
      description:
        'Schedules a pipeline run. The pipeline runs with event "cron", so steps ' +
        'and secrets restricted to other events do not apply to it — a cron job ' +
        'whose steps all have "when: event: push" runs and does nothing.',
      inputSchema: z.object({
        repo_id: repoIdParam,
        name: nameParam,
        schedule: scheduleParam,
        branch: branchParam
          .optional()
          .describe(
            'Branch to run. Defaults to the repository default branch.'
          ),
        timezone: timezoneParam.optional(),
      }),
    },
    async ({ repo_id, name, schedule, branch, timezone }) =>
      run(async () => {
        const body: Record<string, unknown> = { name, schedule };
        if (branch !== undefined) body.branch = branch;
        if (timezone !== undefined) body.timezone = timezone;
        const created = await api.post(`/repos/${repo_id}/cron`, body);
        return jsonResult({ cron: created });
      })
  );

  server.registerTool(
    'update_cron',
    {
      title: 'Update a cron job',
      description:
        'Changes a cron job. Only the fields you pass are touched — including ' +
        '"enabled", which is how a schedule is paused without losing it.',
      inputSchema: z.object({
        repo_id: repoIdParam,
        cron_id: cronIdParam,
        name: nameParam.optional(),
        schedule: scheduleParam.optional(),
        branch: branchParam.optional(),
        timezone: timezoneParam.optional(),
        enabled: z
          .boolean()
          .optional()
          .describe('Set false to stop the schedule without deleting it.'),
      }),
    },
    async ({ repo_id, cron_id, ...fields }) =>
      run(async () => {
        const body: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(fields)) {
          if (value !== undefined) body[key] = value;
        }
        if (Object.keys(body).length === 0) {
          return textResult(
            'Nothing to update — pass name, schedule, branch, timezone or enabled.'
          );
        }
        return jsonResult({
          cron: await api.patch(`/repos/${repo_id}/cron/${cron_id}`, body),
        });
      })
  );

  server.registerTool(
    'run_cron',
    {
      title: 'Run a cron job now',
      description:
        "Starts the cron job's pipeline immediately, without waiting for its " +
        'schedule. The schedule itself is unchanged, and the run counts as a cron ' +
        'event — which is the point: this is how you test that a nightly job works ' +
        'before waiting a night for it.',
      inputSchema: z.object({ repo_id: repoIdParam, cron_id: cronIdParam }),
      annotations: { idempotentHint: false },
    },
    async ({ repo_id, cron_id }) =>
      run(async () =>
        budgetedUntrustedResult({
          pipeline: await api.post(`/repos/${repo_id}/cron/${cron_id}`),
          note: 'Started now; the schedule is unaffected.',
        })
      )
  );

  server.registerTool(
    'delete_cron',
    {
      title: 'Delete a cron job',
      description:
        'Removes a scheduled run. If you only want it to stop for now, ' +
        'update_cron with enabled=false keeps the definition. Two-step.',
      inputSchema: z.object({
        repo_id: repoIdParam,
        cron_id: cronIdParam,
        confirm_token: confirmTokenParam.optional(),
      }),
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ repo_id, cron_id, confirm_token }) =>
      run(async () =>
        guarded(
          confirmations,
          {
            tool: 'delete_cron',
            targets: [String(repo_id), String(cron_id)],
            what: `delete cron job ${cron_id} of repository ${repo_id}`,
            consequence:
              'The schedule is gone. Nothing will notice that the job stopped ' +
              'running — that is the failure mode of every deleted scheduled task.',
            confirmToken: confirm_token,
          },
          async () => {
            await api.delete(`/repos/${repo_id}/cron/${cron_id}`);
            return textResult(`Cron job ${cron_id} was deleted.`);
          }
        )
      )
  );
}

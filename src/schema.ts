import { z } from 'zod';

/**
 * Shared parameter schemas.
 *
 * They live here rather than next to each tool so that the same rule is spelled
 * once — and so the regression tests have a single place to prove that the
 * awkward parts of this API cannot be got wrong by a caller. Woodpecker has
 * several: everything is addressed by numeric id except repositories, which are
 * *also* addressable by `owner/name`; secrets and registries exist three times
 * over at three different scopes; and the same webhook-event vocabulary shows up
 * in half a dozen places.
 */

/**
 * Every id in this API is a positive integer.
 *
 * The upper bound is what a Go `int64` holds and what JavaScript can still
 * represent exactly — beyond `Number.MAX_SAFE_INTEGER` an id silently becomes a
 * different id, which is worse than a rejected call.
 */
const id = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const repoIdParam = id.describe(
  'Numeric repository id. lookup_repository turns an "owner/name" pair into one; ' +
    'list_repositories shows both.'
);

export const orgIdParam = id.describe(
  'Numeric organization id, as returned by list_organizations or lookup_organization.'
);

export const agentIdParam = id.describe('Numeric agent id.');

export const forgeIdParam = id.describe('Numeric forge id.');

export const pipelineNumberParam = id.describe(
  'Pipeline number — the per-repository counter shown in the UI, not the global ' +
    'pipeline id.'
);

export const stepIdParam = id.describe(
  'Numeric step id, from the workflows[].children[] of get_pipeline.'
);

export const cronIdParam = id.describe('Numeric cron job id.');

/**
 * An `owner/name` pair.
 *
 * Woodpecker's lookup endpoint takes the full name as a *single* path segment,
 * so the slash is part of the value and has to survive URL-encoding intact.
 */
export const repoFullNameParam = z
  .string()
  .trim()
  .min(3)
  .max(200)
  .regex(
    /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/,
    'must be an "owner/name" pair, for example "my-org/my-repo"'
  )
  .describe('Full repository name in "owner/name" form.');

export const orgFullNameParam = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9._-]+$/,
    'an organization name holds only letters, digits, dot, underscore and hyphen'
  )
  .describe('The organization name as it is spelled in the forge.');

export const loginParam = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9._-]+$/,
    'a login holds only letters, digits, dot, underscore and hyphen'
  )
  .describe('The account login as it is spelled in the forge.');

/**
 * A secret name.
 *
 * Names are case-sensitive: Woodpecker 3.18.0 stores them as given
 * (`model.Secret` has no normalisation and the handlers do not lower-case
 * either), so `MY_TOKEN` and `my_token` are two different secrets even though a
 * pipeline usually only reads one of them.
 */
export const secretNameParam = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(
    /^[A-Za-z0-9_.-]+$/,
    'a secret name holds only letters, digits, underscore, dot and hyphen'
  )
  .describe(
    'Secret name, stored case-sensitively — MY_TOKEN and my_token are two secrets.'
  );

/**
 * A registry address.
 *
 * The address *is* the identifier — there is no separate name — so it travels
 * as a path segment, and a registry on a non-default port carries a colon.
 */
export const registryAddressParam = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9.:_-]+(\/[A-Za-z0-9._-]+)*$/,
    'must be a registry host such as "docker.io" or "registry.example.com:5000"'
  )
  .describe(
    'Registry address, which is also its identifier — for example "docker.io".'
  );

/**
 * The three levels at which secrets and registries exist.
 *
 * Folded into one parameter rather than three tool families: the request bodies
 * are identical and only the path differs, so three sets of five tools would be
 * fifteen names for five operations.
 */
export const scopeParam = z
  .enum(['repository', 'organization', 'global'])
  .describe(
    'Which level to act on. "repository" needs repo_id, "organization" needs ' +
      'org_id, and "global" is instance-wide and needs neither (admin only). ' +
      'A pipeline sees the repository level first, then the organization, then global.'
  );

/**
 * The webhook events a secret or cron can be bound to.
 *
 * Taken from the API's own enum. `pull_request` is the one worth naming: a
 * secret that is not restricted to it is not available to pull-request builds
 * at all, which reads as "the secret is broken" the first time it happens.
 */
export const webhookEventParam = z.enum([
  'push',
  'pull_request',
  'pull_request_closed',
  'pull_request_metadata',
  'tag',
  'release',
  'deployment',
  'cron',
  'manual',
]);

/**
 * Required rather than optional on purpose.
 *
 * `model.Secret.Validate()` refuses an empty event list with "no event
 * specified" — the defaults people expect are applied by the web UI, not by the
 * API, so a create call that omits events is simply a 400.
 */
export const eventsParam = z
  .array(webhookEventParam)
  .min(1)
  .max(9)
  .describe(
    'Events this applies to. The API has no defaults — at least one is required. ' +
      'A secret that should reach pull-request builds has to name pull_request ' +
      'explicitly; "push", "tag" and "manual" are what the web UI preselects.'
  );

export const pipelineStatusParam = z
  .enum([
    'skipped',
    'pending',
    'running',
    'success',
    'failure',
    'killed',
    'canceled',
    'error',
    'blocked',
    'declined',
    'created',
  ])
  .describe('Pipeline status. "blocked" means it is waiting for approval.');

export const branchParam = z
  .string()
  .trim()
  .min(1)
  .max(250)
  .regex(/^[^\s\\~^:?*[\]]+$/, 'not a valid git branch name')
  .describe('Branch name.');

/**
 * Pipeline variables.
 *
 * A flat string map, and only a flat one: Woodpecker's `PipelineOptions.variables`
 * is `map[string]string`, so a nested object is a 400 that names no field.
 */
export const variablesParam = z
  .record(z.string().min(1).max(200), z.string().max(10_000))
  .describe(
    'Extra variables for this run, as a flat string-to-string map. Nested values ' +
      'are rejected by the API.'
  );

/**
 * Woodpecker pages from 1, and a `perPage` above 50 is silently clamped to 50 —
 * asking for 200 returns 50 and no indication that it did.
 */
export const pageParam = z
  .number()
  .int()
  .min(1)
  .max(10_000)
  .describe('Page number, starting at 1.');

export const perPageParam = z
  .number()
  .int()
  .min(1)
  .max(50)
  .describe(
    'Entries per page (1 … 50). Woodpecker clamps anything above 50 without saying so.'
  );

export const confirmTokenParam = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{32}$/, 'a confirmation token is 32 hexadecimal characters')
  .describe('Token from a previous call of this tool.');

/**
 * An absolute http(s) URL.
 *
 * `z.string().url()` is not this. It only asserts that `new URL()` parses, and
 * zod 4.4.3 happily accepts `javascript:`, `file:`, `data:` and `ftp:`. That
 * matters here because the forge URLs are not stored and forgotten — Woodpecker
 * *fetches* them on every login and every repository read, so a caller-supplied
 * scheme is a request the server makes on the caller's behalf.
 */
export const httpUrlParam = z
  .string()
  .trim()
  .max(500)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'must be an absolute http:// or https:// URL');

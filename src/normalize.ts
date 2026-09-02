/**
 * Shaping of upstream objects before they reach the model.
 *
 * Two jobs, and the second one is the important one:
 *
 *  - **Summaries.** A Woodpecker repository carries about thirty fields, most of
 *    them extension endpoints and netrc flags nobody asked about; a pipeline
 *    carries the full commit metadata twice over. Listing fifty of either spends
 *    the whole result budget on noise, so list results are summarised and the
 *    `get_*` tools return everything.
 *  - **Redaction.** `GET /agents` returns each agent's **token in clear text**,
 *    and that token is enough to register a machine as a build agent, which then
 *    receives pipeline workloads and every secret injected into them. Verified
 *    against Woodpecker 3.18.0. A list call would hand over every agent
 *    credential on the instance at once, so the field is removed on the way out.
 */

export type Json = Record<string, unknown>;

/** Reads an array out of a response that should be one. */
export function listOf(body: unknown, what: string): Json[] {
  if (body === undefined || body === null) return [];
  if (!Array.isArray(body)) {
    throw new Error(
      `expected a list of ${what} from Woodpecker but got ${typeof body}`
    );
  }
  return body as Json[];
}

/** Reads an object out of a response that should be one. */
export function objectOf(body: unknown, what: string): Json {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error(`expected a ${what} object from Woodpecker`);
  }
  return body as Json;
}

function pick(source: Json, keys: string[]): Json {
  const result: Json = {};
  for (const key of keys) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

/**
 * What an agent looks like from the outside.
 *
 * The token is replaced rather than dropped silently: a missing field reads as
 * "this agent has no token", which is never true and would send someone
 * looking for a bug.
 */
export function redactAgent(agent: Json): Json {
  if (agent.token === undefined) return agent;
  return {
    ...agent,
    token:
      '(redacted by woodpecker-ci-mcp — the Woodpecker API returns agent tokens in clear text)',
  };
}

/**
 * Field names that must never reach the model, whatever object they turn up in.
 *
 * `redactAgent` covers the one leak that is documented and reproducible today.
 * This covers the ones that are not: Woodpecker's Go models decide field by
 * field what is serialized, a forge addon or a reverse proxy can reshape a body,
 * and every `get_*` tool here hands its response straight through. Matching on
 * the name rather than on the endpoint means a field that starts being returned
 * after an upstream bump is redacted the day it appears, not the day someone
 * notices.
 *
 * Deliberately not on the list: a bare `value`. It is the natural name for any
 * key/value pair — pipeline variables, cron metadata — and redacting it would
 * damage far more legitimate data than it protects. The one shape where `value`
 * really is a credential is a Woodpecker secret, and that is handled by
 * {@link redactSecret} at the two tools that return one.
 */
const SENSITIVE_KEYS = new Set([
  'token',
  'access_token',
  'refresh_token',
  'client_secret',
  'clientsecret',
  'password',
  'private_key',
  'privatekey',
  'secret_key',
  'session_secret',
  'api_key',
  'apikey',
  'totp_secret',
]);

export const REDACTED = '(redacted by woodpecker-ci-mcp)';

/**
 * What a secret looks like from the outside.
 *
 * On a healthy instance this changes nothing: `model.Secret.Copy()` strips the
 * value before it is serialized, which is why every description here can promise
 * that values are never returned. That promise was the *only* thing holding —
 * `get_secret` handed the response through and `list_secrets` budgeted it, and
 * neither removed anything, while the comment on {@link SENSITIVE_KEYS} claimed
 * the field was stripped "where secrets are actually handled". Confidentiality
 * that depends entirely on the other side's Go model is a claim, not a control;
 * this is the control.
 *
 * Replaced rather than dropped, like {@link redactAgent}: an absent field reads
 * as "this secret has no value", which is never true.
 */
export function redactSecret(secret: Json): Json {
  if (secret.value === undefined) return secret;
  return { ...secret, value: REDACTED };
}

/**
 * Replaces credential-shaped fields anywhere in a response.
 *
 * Replaced, not deleted, for the same reason `redactAgent` replaces: an absent
 * field reads as "there is no such credential", which sends the reader looking
 * for a bug that is not there. Values that are already a redaction marker, and
 * non-string values, are left alone.
 */
export function redactSensitive<T>(data: T): T {
  if (Array.isArray(data)) {
    return data.map((entry) => redactSensitive(entry)) as T;
  }
  if (data === null || typeof data !== 'object') return data;
  const result: Json = {};
  for (const [key, value] of Object.entries(data as Json)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase()) && typeof value === 'string') {
      result[key] = value.startsWith('(redacted') ? value : REDACTED;
      continue;
    }
    result[key] = redactSensitive(value);
  }
  return result as T;
}

/**
 * `forge_remote_id` is in the list on purpose.
 *
 * It is the one field `activate_repository` takes, and a repository that is not
 * activated yet has no Woodpecker id to offer instead — so leaving it out of the
 * summary made `list_repositories(include_inactive: true)` unable to feed the
 * only tool that consumes its output. Found by driving the two against a real
 * instance; the tool description had promised the field for a while by then.
 */
export function summarizeRepo(repo: Json): Json {
  return pick(repo, [
    'id',
    'full_name',
    'owner',
    'name',
    'org_id',
    'active',
    'private',
    'visibility',
    'default_branch',
    'config_file',
    'forge_id',
    'forge_remote_id',
    'forge_url',
  ]);
}

/**
 * A pipeline as it appears in a list.
 *
 * `message` is the full commit message including its body; only the subject
 * line is useful in a list, and a repository whose convention is a long body
 * would otherwise dominate the result.
 */
export function summarizePipeline(pipeline: Json): Json {
  const summary = pick(pipeline, [
    'number',
    'status',
    'event',
    'branch',
    'ref',
    'author',
    'created',
    'started',
    'finished',
    'title',
    'errors',
  ]);
  const commit = pipeline.commit;
  if (typeof commit === 'string') summary.commit = commit.slice(0, 12);
  const message = pipeline.message;
  if (typeof message === 'string') {
    summary.message = firstLine(message);
  }
  return summary;
}

/** The steps of a pipeline, flattened to what identifies and explains them. */
export function summarizeWorkflows(pipeline: Json): Json[] {
  const workflows = Array.isArray(pipeline.workflows)
    ? (pipeline.workflows as Json[])
    : [];
  return workflows.map((workflow) => ({
    ...pick(workflow, [
      'id',
      'pid',
      'name',
      'state',
      'error',
      'started',
      'finished',
    ]),
    steps: (Array.isArray(workflow.children)
      ? (workflow.children as Json[])
      : []
    ).map((step) =>
      pick(step, [
        'id',
        'pid',
        'name',
        'type',
        'state',
        'error',
        'exit_code',
        'started',
        'finished',
      ])
    ),
  }));
}

export function summarizeCron(cron: Json): Json {
  return pick(cron, [
    'id',
    'name',
    'schedule',
    'branch',
    'timezone',
    'next_exec',
    'created',
    'creator_id',
  ]);
}

export function summarizeUser(user: Json): Json {
  return pick(user, ['id', 'login', 'email', 'admin', 'org_id', 'forge_id']);
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

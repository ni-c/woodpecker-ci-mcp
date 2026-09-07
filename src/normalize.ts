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

/**
 * What a credential-shaped key ends with, once its separators are gone.
 *
 * The exact list above was the whole control until 0.3.1, and it missed the
 * one map Woodpecker hands to an administrator unfiltered: `GET /forges/{id}`
 * answers an admin with the raw `Forge`, `additional_options` included — and
 * for a Bitbucket Data Center forge that map holds `git-username` and
 * `git-password`, the service account Woodpecker clones with
 * (`server/services/setup.go`, `server/forge/setup/setup.go` upstream).
 * `password` matched `password`; it did not match `git-password`. A map whose
 * keys the forge implementation chooses cannot be listed here in advance, so
 * the rule is the suffix: `git-password`, `gitPassword` and `GIT_PASSWORD`
 * all normalise to something ending in `password`.
 *
 * `key` on its own is not a suffix on purpose — `forge_remote_id`-style names
 * are fine, but `secret_key` is in the exact list because `…key` alone would
 * also catch `config_key`, `ssh_key` fingerprints and every `*_key` id.
 */
const SENSITIVE_SUFFIXES = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'apikey',
  'privatekey',
];

/** Whether a key names something that must not reach the model. */
export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (SENSITIVE_KEYS.has(lower)) return true;
  const bare = lower.replace(/[_-]/g, '');
  return SENSITIVE_SUFFIXES.some((suffix) => bare.endsWith(suffix));
}

export const REDACTED = '(redacted by woodpecker-ci-mcp)';

/**
 * C0 and C1 controls, DEL, and the invisible and direction-changing formatting
 * characters — the same class `mcp-approval` keeps out of a confirmation
 * prompt, kept out of every string this server hands to a model.
 *
 * Tab and newline stay: they are the structure of a log and of a YAML file.
 * `\r` stays too, because `stripControlCharacters` in `logs.ts` gives it its
 * terminal meaning (a rewritten line) before this class runs there.
 *
 * Build logs were the only text this applied to until 0.3.1. A commit message,
 * a branch name, a step's error text and a secret's note are written by the
 * same people, reach `structuredContent` unescaped, and `ESC[1A` or U+202E in
 * any of them rewrites what a terminal client shows next to it.
 */
const UNSAFE_RANGES: [number, number][] = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

// Built from code points rather than spelled as escapes: an editing tool that
// turns `\uXXXX` into the character it names writes a raw NUL into this file,
// and a raw NUL in a source file is visible only as `Bin` in `git diff --stat`.
export const UNSAFE_CHARS = new RegExp(
  `[${UNSAFE_RANGES.map(([from, to]) =>
    from === to
      ? String.fromCodePoint(from)
      : `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`
  ).join('')}]`,
  'g'
);

/**
 * Credentials embedded in a URL: everything between `://` and the last `@`
 * before the path, query or fragment.
 *
 * `[^/?#\s]*` cannot run past the next path separator, and every `://` start
 * contains one, so a string full of `://` is still one linear scan — the
 * greedy run of one start ends where the next one begins.
 */
const URL_CREDENTIALS = /(:\/\/)[^/?#\s]*@/g;

/**
 * Cleans one string the backend wrote before it is shown to a model.
 *
 * Two things, both about what a value can do rather than what it says:
 * the unsafe character class above, and `scheme://user:password@host`, which
 * Woodpecker has no reason to store but a forge URL or a clone URL written by
 * hand could carry. The redaction keeps the URL usable and the credential out.
 */
export function scrubText(text: string): string {
  return text
    .replace(UNSAFE_CHARS, '')
    .replace(URL_CREDENTIALS, '$1(redacted)@');
}

/**
 * Text the instance sent, made safe for an error message.
 *
 * Trimmed, scrubbed, cut to `max` characters — an error body, a header value
 * or anything else a response carries is written by the instance, by a proxy
 * in front of it, or by whoever a mistyped `WOODPECKER_URL` landed on.
 */
export function upstreamText(text: string, max = 200): string {
  const clean = scrubText(text).trim();
  return clean.length > max ? `${clean.slice(0, max)}… (truncated)` : clean;
}

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
 * Replaces credential-shaped fields anywhere in a response, and cleans every
 * other string on the way past.
 *
 * Replaced, not deleted, for the same reason `redactAgent` replaces: an absent
 * field reads as "there is no such credential", which sends the reader looking
 * for a bug that is not there. Values that are already a redaction marker, and
 * non-string values, are left alone.
 *
 * Built with `Object.fromEntries` rather than by assignment: a response object
 * with a `"__proto__"` key — legal JSON, and an own property after
 * `JSON.parse` — would otherwise be *assigned* into the copy, which sets the
 * copy's prototype and drops the field, instead of being carried as data.
 */
export function redactSensitive<T>(data: T): T {
  if (Array.isArray(data)) {
    return data.map((entry) => redactSensitive(entry)) as T;
  }
  if (typeof data === 'string') return scrubText(data) as T;
  if (data === null || typeof data !== 'object') return data;
  return Object.fromEntries(
    Object.entries(data as Json).map(([key, value]) => {
      if (isSensitiveKey(key) && typeof value === 'string') {
        return [key, value.startsWith('(redacted') ? value : REDACTED];
      }
      return [key, redactSensitive(value)];
    })
  ) as T;
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

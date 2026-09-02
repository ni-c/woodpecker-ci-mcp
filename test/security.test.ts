import { afterEach, describe, expect, it, vi } from 'vitest';

import { REDACTED } from '../src/normalize.js';
import {
  call,
  confirmed,
  connect,
  jsonOf,
  pipelineFixture,
  REPO_ID,
  repoFixture,
  stubFetch,
  textOf,
  tokenOf,
} from './harness.js';

/**
 * The regressions for findings from the security audit.
 *
 * Each of these once passed for the wrong reason, or would have.
 */
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('caller-supplied URLs are scheme-checked', () => {
  // `z.string().url()` only asserts that new URL() parses; zod accepts
  // javascript:, file:, data: and ftp:. Woodpecker *fetches* a forge URL on
  // every login and repository read, so the scheme is a request this server
  // would be making on the caller's say-so.
  it.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<script>',
    'ftp://example.com',
    'not a url at all',
  ])('refuses %s as a forge url', async (url) => {
    stubFetch({});
    const result = await call(await connect(), 'create_forge', {
      type: 'gitea',
      url,
      client: 'id',
      oauth_client_secret: 'secret',
    });
    expect(result.isError).toBe(true);
  });

  it.each(['javascript:alert(1)', 'file:///etc/passwd'])(
    'refuses %s as an oauth_host',
    async (oauth_host) => {
      stubFetch({});
      const result = await call(await connect(), 'create_forge', {
        type: 'gitea',
        url: 'https://forge.example.com',
        client: 'id',
        oauth_client_secret: 'secret',
        oauth_host,
      });
      expect(result.isError).toBe(true);
    }
  );

  it('still accepts a plain http forge on an internal network', async () => {
    const stub = stubFetch({ 'POST /forges': { json: { id: 1 } } });
    const result = await call(await connect(), 'create_forge', {
      type: 'forgejo',
      url: 'http://forge.internal:3000',
      client: 'id',
      oauth_client_secret: 'secret',
    });
    expect(result.isError).toBeFalsy();
    expect(stub.calls).toHaveLength(1);
  });
});

describe('unknown fields never reach the API', () => {
  // Every body builder that spreads its arguments (update_repository,
  // update_cron, create_forge, update_forge) would forward whatever survived
  // validation. Zod strips unknown keys — this proves it, rather than trusting
  // that the SDK keeps doing so.
  it('strips an extra field from a repository update', async () => {
    const stub = stubFetch({ [`PATCH /repos/${REPO_ID}`]: { json: {} } });
    await call(await connect(), 'update_repository', {
      repo_id: REPO_ID,
      timeout: 30,
      trusted: { security: true },
      admin: true,
      __proto__: { polluted: true },
    });
    expect(stub.calls[0]?.body).toEqual({ timeout: 30 });
  });

  it('strips an extra field from a cron update', async () => {
    const stub = stubFetch({
      [`PATCH /repos/${REPO_ID}/cron/4`]: { json: {} },
    });
    await call(await connect(), 'update_cron', {
      repo_id: REPO_ID,
      cron_id: 4,
      enabled: false,
      creator_id: 1,
    });
    expect(stub.calls[0]?.body).toEqual({ enabled: false });
  });

  it('strips an extra field from a forge creation', async () => {
    const stub = stubFetch({ 'POST /forges': { json: {} } });
    await call(await connect(), 'create_forge', {
      type: 'gitea',
      url: 'https://forge.example.com',
      client: 'id',
      oauth_client_secret: 'secret',
      id: 99,
    });
    expect(stub.calls[0]?.body).toEqual({
      type: 'gitea',
      url: 'https://forge.example.com',
      client: 'id',
      oauth_client_secret: 'secret',
    });
  });
});

describe('the token stays out of everything it should', () => {
  it('is not in a tool result when the upstream fails', async () => {
    stubFetch({
      [`GET /repos/${REPO_ID}`]: { status: 401, text: 'User not authorized' },
    });
    const result = await call(await connect(), 'get_repository', {
      repo_id: REPO_ID,
    });
    expect(textOf(result)).not.toContain('test-token');
  });

  it('is not echoed back by a path-validation error', async () => {
    stubFetch({});
    const result = await call(await connect(), 'get_secret', {
      scope: 'global',
      name: '../../../test-token',
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain('test-token');
  });
});

describe('upstream error pages do not reach the model', () => {
  it('drops an HTML error body from a proxy', async () => {
    stubFetch({
      [`GET /repos/${REPO_ID}`]: {
        status: 502,
        text: '<!doctype html><html><body>Bad Gateway from the WAF</body></html>',
        contentType: 'text/html',
      },
    });
    const result = await call(await connect(), 'get_repository', {
      repo_id: REPO_ID,
    });
    expect(textOf(result)).toContain('(HTML error page omitted)');
    expect(textOf(result)).not.toContain('Bad Gateway from the WAF');
  });
});

describe('the 404 hint fits the path it came from', () => {
  it('explains an unactivated repository for a repository path', async () => {
    stubFetch({ [`GET /repos/${REPO_ID}`]: { status: 404, text: '' } });
    const result = await call(await connect(), 'get_repository', {
      repo_id: REPO_ID,
    });
    expect(textOf(result)).toContain('never been activated');
  });

  it('says nothing about forges for an agent path', async () => {
    // GET /agents/1/tasks answers 404 on a real instance for an agent with no
    // tasks; a hint about repositories there sends the reader the wrong way.
    stubFetch({ 'GET /agents/1/tasks': { status: 404, text: '' } });
    const result = await call(await connect(), 'list_agent_tasks', {
      agent_id: 1,
    });
    expect(textOf(result)).toContain('No such object on this instance');
    expect(textOf(result)).not.toContain('forge');
  });
});

describe('update_user does not blank the fields it was not given', () => {
  // PATCH /users/{login} assigns login, email, avatar and admin from the request
  // unconditionally — a body of just {"admin": true} wipes the rest. Verified
  // against 3.18.0, which answered {"id": 0, "login": "", "email": ""}.
  it('reads the account first and sends it back whole', async () => {
    const stored = {
      id: 3,
      login: 'octocat',
      email: 'octocat@example.com',
      avatar_url: 'https://forge.example.com/avatars/octocat',
      admin: false,
      forge_id: 1,
      forge_remote_id: '77',
    };
    const stub = stubFetch({
      'GET /users/octocat': { json: stored },
      'PATCH /users/octocat': { json: { id: 0, login: '', email: '' } },
    });
    await confirmed(await connect(), 'update_user', {
      login: 'octocat',
      forge_id: 1,
      admin: true,
    });
    const patch = stub.calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toEqual({
      login: 'octocat',
      email: 'octocat@example.com',
      avatar_url: 'https://forge.example.com/avatars/octocat',
      admin: true,
      forge_id: 1,
      forge_remote_id: '77',
    });
  });

  it('reports the stored account rather than the echoed request', async () => {
    stubFetch({
      'GET /users/octocat': {
        json: { id: 3, login: 'octocat', email: 'a@example.com', admin: true },
      },
      'PATCH /users/octocat': { json: { id: 0, login: '', email: '' } },
    });
    const result = await confirmed(await connect(), 'update_user', {
      login: 'octocat',
      forge_id: 1,
      admin: true,
    });
    expect(jsonOf(result)).toEqual({
      user: { id: 3, login: 'octocat', email: 'a@example.com', admin: true },
    });
  });
});

describe('the escalating writes are two-step, the routine ones are not', () => {
  // Each of these executes an instance-wide privilege change on the first call
  // otherwise, and the model reaching them is usually holding a build log —
  // this server's one input written by whoever can push a commit.
  it('does not approve a blocked pipeline before it is confirmed', async () => {
    const stub = stubFetch({
      [`POST /repos/${REPO_ID}/pipelines/7/approve`]: { json: {} },
    });
    const result = await call(await connect(), 'approve_pipeline', {
      repo_id: REPO_ID,
      number: 7,
    });
    expect(stub.calls).toHaveLength(0);
    expect(textOf(result)).toContain("fork's code");
  });

  it('does not grant admin before it is confirmed', async () => {
    const stub = stubFetch({
      'GET /users/octocat?forge_id=1': { json: { login: 'octocat' } },
      'PATCH /users/octocat': { json: {} },
    });
    const result = await call(await connect(), 'update_user', {
      login: 'octocat',
      forge_id: 1,
      admin: true,
    });
    expect(stub.calls).toHaveLength(0);
    expect(textOf(result)).toContain('confirm_token');
  });

  it('corrects an email on the first call, because that is not an escalation', async () => {
    const stub = stubFetch({
      'GET /users/octocat?forge_id=1': { json: { login: 'octocat' } },
      'PATCH /users/octocat': { json: {} },
    });
    const result = await call(await connect(), 'update_user', {
      login: 'octocat',
      forge_id: 1,
      email: 'new@example.com',
    });
    expect(result.isError).toBeFalsy();
    expect(stub.calls.some((c) => c.method === 'PATCH')).toBe(true);
  });

  it('does not grant repository trust before it is confirmed', async () => {
    const stub = stubFetch({ [`PATCH /repos/${REPO_ID}`]: { json: {} } });
    await call(await connect(), 'update_repository', {
      repo_id: REPO_ID,
      trusted_security: true,
    });
    expect(stub.calls).toHaveLength(0);
  });

  it('withdraws trust on the first call, because that direction is safe', async () => {
    const stub = stubFetch({
      [`PATCH /repos/${REPO_ID}`]: { json: repoFixture() },
    });
    await call(await connect(), 'update_repository', {
      repo_id: REPO_ID,
      trusted_security: false,
    });
    expect(stub.calls[0]?.body).toEqual({ trusted: { security: false } });
  });

  it('does not silence the server log before it is confirmed', async () => {
    const stub = stubFetch({ 'POST /log-level': { json: {} } });
    await call(await connect(), 'set_log_level', { level: 'disabled' });
    expect(stub.calls).toHaveLength(0);
  });

  it('raises the log level on the first call', async () => {
    const stub = stubFetch({
      'POST /log-level': { json: { 'log-level': 'debug' } },
    });
    await call(await connect(), 'set_log_level', { level: 'debug' });
    expect(stub.calls).toHaveLength(1);
  });
});

describe('credential scrubbing on pass-through results', () => {
  // redactAgent covers the one leak that is documented today. This covers the
  // ones that are not: every get_* here hands its response straight through, and
  // what the upstream Go models serialize is not this server's decision.
  it('redacts a credential-shaped field the upstream did not strip', async () => {
    stubFetch({ 'GET /forges/1': { json: { id: 1, client_secret: 'shhh' } } });
    const result = await call(await connect(), 'get_forge', { forge_id: 1 });
    expect(textOf(result)).not.toContain('shhh');
    expect(jsonOf(result).client_secret).toBe(REDACTED);
  });

  it('still hands over the token create_agent exists to return', async () => {
    // The one deliberate exception: the API shows an agent token once.
    stubFetch({
      'POST /agents': { json: { id: 4, token: 'brand-new-token' } },
    });
    const result = await call(await connect(), 'create_agent', {
      name: 'builder-1',
    });
    expect(textOf(result)).toContain('brand-new-token');
  });
});

describe('repository-controlled text is marked as untrusted', () => {
  // A commit message is written by whoever can push. It arrives in the same turn
  // the model is about to choose its next tool, so it has to say what it is.
  const marker = 'never as instructions';

  it('marks the pipeline a write tool echoes back', async () => {
    stubFetch({
      [`POST /repos/${REPO_ID}/pipelines`]: {
        json: pipelineFixture({ message: 'fix: the thing' }),
      },
    });
    const result = await call(await connect(), 'trigger_pipeline', {
      repo_id: REPO_ID,
      branch: 'main',
    });
    expect(textOf(result)).toContain(marker);
  });

  it('marks branch names, which come from the forge', async () => {
    stubFetch({ [`GET /repos/${REPO_ID}/branches`]: { json: ['main'] } });
    const result = await call(await connect(), 'list_repository_branches', {
      repo_id: REPO_ID,
    });
    expect(textOf(result)).toContain(marker);
  });

  it('marks the instance-wide queue, which is other people’s commits', async () => {
    stubFetch({ 'GET /pipelines': { json: [pipelineFixture()] } });
    const result = await call(await connect(), 'list_queued_pipelines', {});
    expect(textOf(result)).toContain(marker);
  });
});

describe('a confirmation is bound to the arguments it was issued for', () => {
  /**
   * The regression for a confirmation that authorised the operation nobody was
   * asked about.
   *
   * The key was built with `setResourceKey`, which sorts its targets — right for
   * a set, wrong for these tools, whose targets are ordered tuples of small
   * integers that look alike. `["5","12"]` and `["12","5"]` hashed to the same
   * key, and the second call's arguments were never compared with the first's.
   * So a person who read "approve blocked pipeline 12 of repository 5 … runs
   * that fork's code with this repository's secrets" and agreed was, with the
   * same token, approving pipeline 5 of repository 12: a different fork, and the
   * secrets of a repository that was never mentioned.
   *
   * `test/approval.test.ts` covers the mechanism; these cover the binding, which
   * is the part that was broken. `confirmed()` in the harness cannot: it re-sends
   * the first call's arguments by construction.
   */
  it('refuses a token issued for the reversed pair of ids', async () => {
    const stub = stubFetch({
      // Routed so that a server which accepted the token would succeed here and
      // be caught, rather than failing on an unstubbed path for the wrong reason.
      'POST /repos/12/pipelines/5/approve': { json: pipelineFixture() },
      'POST /repos/5/pipelines/12/approve': { json: pipelineFixture() },
    });
    const client = await connect();

    const first = await call(client, 'approve_pipeline', {
      repo_id: 5,
      number: 12,
    });
    const swapped = await call(client, 'approve_pipeline', {
      repo_id: 12,
      number: 5,
      confirm_token: tokenOf(first),
    });

    expect(swapped.isError).toBe(true);
    expect(textOf(swapped)).toContain('invalid, expired');
    expect(stub.calls).toHaveLength(0);
  });

  it('names the pair it was issued for, in the order it was issued', async () => {
    stubFetch({ 'POST /repos/5/pipelines/12/approve': { json: {} } });
    const first = await call(await connect(), 'approve_pipeline', {
      repo_id: 5,
      number: 12,
    });
    expect(textOf(first)).toContain('pipeline 12 of repository 5');
  });

  it('refuses a token issued for the reversed scope of a log deletion', async () => {
    const stub = stubFetch({
      [`DELETE /repos/12/logs/5/7`]: { status: 204 },
      [`DELETE /repos/5/logs/12/7`]: { status: 204 },
    });
    const client = await connect();
    const first = await call(client, 'delete_step_logs', {
      repo_id: 5,
      number: 12,
      step_id: 7,
    });
    const swapped = await call(client, 'delete_step_logs', {
      repo_id: 12,
      number: 5,
      step_id: 7,
      confirm_token: tokenOf(first),
    });
    expect(swapped.isError).toBe(true);
    expect(stub.calls).toHaveLength(0);
  });

  it('refuses a token when the second call smuggles an extra field', async () => {
    // The targets say what is touched, the fingerprint says with what. A token
    // for "grant trusted_network" must not carry a body it was not shown.
    const stub = stubFetch({ [`PATCH /repos/${REPO_ID}`]: { json: {} } });
    const client = await connect();
    const first = await call(client, 'update_repository', {
      repo_id: REPO_ID,
      trusted_network: true,
    });
    const smuggled = await call(client, 'update_repository', {
      repo_id: REPO_ID,
      trusted_network: true,
      timeout: 5,
      confirm_token: tokenOf(first),
    });
    expect(smuggled.isError).toBe(true);
    expect(stub.calls).toHaveLength(0);
  });
});

describe('the fork gate cannot be turned off without asking', () => {
  /**
   * `approve_pipeline` is the most carefully reasoned guard in this server, and
   * two ungated calls made every one of its confirmations optional:
   * `update_repository(require_approval: "none", visibility: "public")` in one
   * call, and `update_secret(events: [... "pull_request"], images: [])` in
   * another. Together: a fork's pull request runs unapproved, reads the secret,
   * prints it, and the log is world-readable. The point is not that an
   * administrator may do this — it is that the model which the code tells three
   * times over is holding somebody else's build log did it without a prompt.
   */
  const currentRepo = { [`GET /repos/${REPO_ID}`]: { json: repoFixture() } };

  it('asks before require_approval is lowered', async () => {
    const stub = stubFetch({
      ...currentRepo,
      [`PATCH /repos/${REPO_ID}`]: { json: repoFixture() },
    });
    const result = await call(await connect(), 'update_repository', {
      repo_id: REPO_ID,
      require_approval: 'none',
    });
    expect(textOf(result)).toContain('confirm_token');
    expect(stub.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('asks before a repository is made publicly readable', async () => {
    const stub = stubFetch({
      ...currentRepo,
      [`PATCH /repos/${REPO_ID}`]: { json: repoFixture() },
    });
    const result = await call(await connect(), 'update_repository', {
      repo_id: REPO_ID,
      visibility: 'public',
    });
    expect(textOf(result)).toContain('confirm_token');
    expect(stub.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('raises require_approval on the first call, because that direction is safe', async () => {
    const stub = stubFetch({
      ...currentRepo,
      [`PATCH /repos/${REPO_ID}`]: { json: repoFixture() },
    });
    const result = await call(await connect(), 'update_repository', {
      repo_id: REPO_ID,
      require_approval: 'all_events',
    });
    expect(result.isError).toBeFalsy();
    expect(stub.calls.some((c) => c.method === 'PATCH')).toBe(true);
  });

  it('does not read the repository at all when neither field is named', async () => {
    // The extra request is the price of comparing, so it is only paid when
    // there is something to compare.
    const stub = stubFetch({ [`PATCH /repos/${REPO_ID}`]: { json: {} } });
    await call(await connect(), 'update_repository', {
      repo_id: REPO_ID,
      timeout: 30,
    });
    expect(stub.calls.every((c) => c.method === 'PATCH')).toBe(true);
  });

  it('asks before a secret is let into pull-request builds', async () => {
    const stub = stubFetch({
      'GET /secrets/TOKEN': { json: { events: ['push'], images: [] } },
      'PATCH /secrets/TOKEN': { json: {} },
    });
    const result = await call(await connect(), 'update_secret', {
      scope: 'global',
      name: 'TOKEN',
      events: ['push', 'pull_request'],
    });
    expect(textOf(result)).toContain('confirm_token');
    expect(stub.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('asks before an image restriction is cleared', async () => {
    const stub = stubFetch({
      'GET /secrets/TOKEN': { json: { events: ['push'], images: ['alpine'] } },
      'PATCH /secrets/TOKEN': { json: {} },
    });
    const result = await call(await connect(), 'update_secret', {
      scope: 'global',
      name: 'TOKEN',
      images: [],
    });
    expect(textOf(result)).toContain('confirm_token');
    expect(stub.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('narrows the events on the first call, because that direction is safe', async () => {
    const stub = stubFetch({
      'GET /secrets/TOKEN': {
        json: { events: ['push', 'pull_request'], images: [] },
      },
      'PATCH /secrets/TOKEN': { json: {} },
    });
    const result = await call(await connect(), 'update_secret', {
      scope: 'global',
      name: 'TOKEN',
      events: ['push'],
    });
    expect(result.isError).toBeFalsy();
    expect(stub.calls.some((c) => c.method === 'PATCH')).toBe(true);
  });

  it('edits the note on the first call, and without reading the secret', async () => {
    const stub = stubFetch({ 'PATCH /secrets/TOKEN': { json: {} } });
    const result = await call(await connect(), 'update_secret', {
      scope: 'global',
      name: 'TOKEN',
      note: 'owned by the deploy team',
    });
    expect(result.isError).toBeFalsy();
    expect(stub.calls.every((c) => c.method === 'PATCH')).toBe(true);
  });
});

describe('rotating a registry password asks first', () => {
  // The tool's own annotation states the rule — "the old password is not
  // readable through the API and cannot be recovered" — and update_secret is
  // guarded by that exact sentence, while delete_registry beside it is
  // two-step for the same damage. This one was not.
  it('does not replace the password before it is confirmed', async () => {
    const stub = stubFetch({ 'PATCH /registries/docker.io': { json: {} } });
    const result = await call(await connect(), 'update_registry', {
      scope: 'global',
      address: 'docker.io',
      password: 'new',
    });
    expect(textOf(result)).toContain('confirm_token');
    expect(stub.calls).toHaveLength(0);
  });

  it('corrects a username on the first call, because nothing is destroyed', async () => {
    const stub = stubFetch({ 'PATCH /registries/docker.io': { json: {} } });
    const result = await call(await connect(), 'update_registry', {
      scope: 'global',
      address: 'docker.io',
      username: 'bot',
    });
    expect(result.isError).toBeFalsy();
    expect(stub.calls[0]?.body).toEqual({ username: 'bot' });
  });
});

describe('a secret value never leaves this server', () => {
  // Woodpecker's model.Secret.Copy() strips the value, so on a healthy instance
  // these change nothing — which is why they exist. The comment on
  // SENSITIVE_KEYS claimed `value` was "stripped where secrets are actually
  // handled, in tools/secrets.ts", and nothing there stripped anything: the
  // confidentiality rested entirely on the other side's Go model.
  it('redacts a value an instance did return from get_secret', async () => {
    stubFetch({
      'GET /secrets/TOKEN': { json: { name: 'TOKEN', value: 'sh' } },
    });
    const result = await call(await connect(), 'get_secret', {
      scope: 'global',
      name: 'TOKEN',
    });
    expect(textOf(result)).not.toContain('sh');
    expect(jsonOf(result).value).toBe(REDACTED);
  });

  it('redacts values in a secret list too', async () => {
    stubFetch({
      'GET /secrets': { json: [{ name: 'TOKEN', value: 'leaked-value' }] },
    });
    const result = await call(await connect(), 'list_secrets', {
      scope: 'global',
    });
    expect(textOf(result)).not.toContain('leaked-value');
  });

  it('leaves a value-shaped field that is not a secret alone', async () => {
    // A bare `value` is the natural name for any key/value pair, which is why
    // it cannot go on the blanket list.
    stubFetch({
      [`GET /repos/${REPO_ID}/cron/4`]: {
        json: { id: 4, name: 'nightly', value: 'not a credential' },
      },
    });
    const result = await call(await connect(), 'get_cron', {
      repo_id: REPO_ID,
      cron_id: 4,
    });
    expect(textOf(result)).toContain('not a credential');
  });
});

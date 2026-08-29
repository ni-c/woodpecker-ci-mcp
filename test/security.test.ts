import { afterEach, describe, expect, it, vi } from 'vitest';

import { REDACTED } from '../src/normalize.js';
import {
  call,
  callConfirmed,
  connect,
  jsonOf,
  pipelineFixture,
  REPO_ID,
  repoFixture,
  stubFetch,
  textOf,
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
    await callConfirmed(await connect(), 'update_user', {
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
    const result = await callConfirmed(await connect(), 'update_user', {
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

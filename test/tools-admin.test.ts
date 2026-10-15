import { afterEach, describe, expect, it, vi } from 'vitest';

import { serverNote } from '../src/tools/server-admin.js';

import {
  agentFixture,
  call,
  connect,
  jsonOf,
  SERVER,
  stubFetch,
  textOf,
  tokenOf,
} from './harness.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('agents', () => {
  // The reason this module exists at all: GET /agents returns every agent's
  // token in clear text, and that token is enough to attach a machine to the
  // server and receive pipeline workloads together with their secrets.
  it('never lets an agent token out of a list call', async () => {
    stubFetch({
      'GET /agents': { json: [agentFixture(), agentFixture({ id: 2 })] },
    });
    const result = await call(await connect(), 'list_agents');
    const text = textOf(result);
    expect(text).not.toContain('DO-NOT-LEAK');
    expect(text).toContain('redacted');
  });

  it('never lets an agent token out of a single get', async () => {
    stubFetch({ 'GET /agents/1': { json: agentFixture() } });
    const result = await call(await connect(), 'get_agent', { agent_id: 1 });
    expect(textOf(result)).not.toContain('DO-NOT-LEAK');
  });

  it('never lets one out of an update either', async () => {
    stubFetch({ 'PATCH /agents/1': { json: agentFixture() } });
    const result = await call(await connect(), 'update_agent', {
      agent_id: 1,
      no_schedule: true,
    });
    expect(textOf(result)).not.toContain('DO-NOT-LEAK');
  });

  it('does return the token from create_agent, which is the only way to get it', async () => {
    stubFetch({ 'POST /agents': { json: agentFixture() } });
    const result = await call(await connect(), 'create_agent', {
      name: 'agent-02',
    });
    const text = textOf(result);
    expect(text).toContain('DO-NOT-LEAK');
    expect(text).toContain('Treat it like a password');
  });

  it('keeps the redaction marker distinguishable from a missing token', async () => {
    stubFetch({
      'GET /agents': { json: [agentFixture({ token: undefined })] },
    });
    const result = jsonOf(await call(await connect(), 'list_agents'));
    const agents = result.agents as Record<string, unknown>[];
    expect(agents[0]?.token).toBeUndefined();
  });

  it('uses the organization route when an org_id is given', async () => {
    const stub = stubFetch({ 'GET /orgs/3/agents': { json: [] } });
    await call(await connect(), 'list_agents', { org_id: 3 });
    expect(stub.calls[0]?.path).toBe('/orgs/3/agents');
  });

  it('deletes through the organization route when scoped', async () => {
    const stub = stubFetch({ 'DELETE /orgs/3/agents/1': { status: 204 } });
    const client = await connect();
    const first = await call(client, 'delete_agent', {
      agent_id: 1,
      org_id: 3,
    });
    await call(client, 'delete_agent', {
      agent_id: 1,
      org_id: 3,
      confirm_token: tokenOf(first),
    });
    expect(stub.calls[0]?.path).toBe('/orgs/3/agents/1');
  });
});

describe('users', () => {
  const user = {
    id: 5,
    login: 'octocat',
    email: 'octocat@example.com',
    admin: false,
  };

  it('sends the forge_id the API requires on a single lookup', async () => {
    const stub = stubFetch({ 'GET /users/octocat': { json: user } });
    await call(await connect(), 'get_user', { login: 'octocat', forge_id: 1 });
    expect(stub.calls[0]?.path).toBe('/users/octocat?forge_id=1');
  });

  it('refuses a lookup without the forge_id rather than sending a 400', async () => {
    stubFetch({});
    const result = await call(await connect(), 'get_user', {
      login: 'octocat',
    });
    expect(result.isError).toBe(true);
  });

  it('warns about ownerless repositories when deleting an account', async () => {
    stubFetch({ 'DELETE /users/octocat': { status: 204 } });
    const client = await connect();
    const first = await call(client, 'delete_user', {
      login: 'octocat',
      forge_id: 1,
    });
    expect(textOf(first)).toContain('chown_repository');
  });
});

describe('organizations', () => {
  it('encodes the name for a lookup', async () => {
    const stub = stubFetch({ 'GET /orgs/lookup/acme': { json: { id: 3 } } });
    await call(await connect(), 'lookup_organization', { name: 'acme' });
    expect(stub.calls[0]?.path).toBe('/orgs/lookup/acme');
  });

  it('guards deletion', async () => {
    const stub = stubFetch({ 'DELETE /orgs/3': { status: 204 } });
    const client = await connect();
    const first = await call(client, 'delete_organization', { org_id: 3 });
    expect(stub.calls).toHaveLength(0);
    await call(client, 'delete_organization', {
      org_id: 3,
      confirm_token: tokenOf(first),
    });
    expect(stub.calls).toHaveLength(1);
  });
});

describe('forges', () => {
  it('makes an update two-step, because a wrong value locks everyone out', async () => {
    const stub = stubFetch({ 'PATCH /forges/1': { json: { id: 1 } } });
    const client = await connect();
    const first = await call(client, 'update_forge', {
      forge_id: 1,
      url: 'https://forge.example.com',
    });
    expect(stub.calls).toHaveLength(0);
    expect(textOf(first)).toContain('locks all users out');
    await call(client, 'update_forge', {
      forge_id: 1,
      url: 'https://forge.example.com',
      confirm_token: tokenOf(first),
    });
    expect(stub.calls).toHaveLength(1);
  });

  it('binds the token to the fields being changed', async () => {
    stubFetch({ 'PATCH /forges/1': { json: { id: 1 } } });
    const client = await connect();
    const first = await call(client, 'update_forge', {
      forge_id: 1,
      url: 'https://forge.example.com',
    });
    // Same forge, different field: confirming one change must not confirm another.
    const other = await call(client, 'update_forge', {
      forge_id: 1,
      oauth_client_secret: 'new-secret',
      confirm_token: tokenOf(first),
    });
    expect(other.isError).toBe(true);
  });
});

describe('server and queue', () => {
  it('asks the server root for version and health, not the /api prefix', async () => {
    const stub = stubFetch({
      'GET !/version': { json: { version: '3.18.0' } },
      'GET !/healthz': { status: 204 },
    });
    const result = jsonOf(await call(await connect(), 'get_server_info'));
    expect(stub.calls.map((c) => c.url)).toEqual([
      `${SERVER}/version`,
      `${SERVER}/healthz`,
    ]);
    expect(result.healthy).toBe(true);
    expect(result.version).toEqual({ version: '3.18.0' });
  });

  it('stays at the root under a configured prefix', async () => {
    const stub = stubFetch(
      {
        'GET !/version': { json: { version: '6.10.0' } },
        'GET !/healthz': { status: 204 },
      },
      `${SERVER}/api/v1`
    );
    await call(await connect({ apiPrefix: '/api/v1' }), 'get_server_info');
    expect(stub.calls.map((c) => c.url)).toEqual([
      `${SERVER}/version`,
      `${SERVER}/healthz`,
    ]);
  });

  it('counts a 200 with a JSON body from /healthz as healthy, as Crow answers', async () => {
    stubFetch({
      'GET !/version': {
        json: { source: 'https://codefloe.com/crowci/crow', version: '6.10.0' },
      },
      'GET !/healthz': { json: { status: 'ok', checks: {} } },
    });
    const result = jsonOf(
      await call(await connect({ apiPrefix: '/api/v1' }), 'get_server_info')
    );
    expect(result.healthy).toBe(true);
    expect(result.note).toContain('Crow CI');
  });

  it('adds no note for Woodpecker', async () => {
    stubFetch({
      'GET !/version': {
        json: {
          source: 'https://github.com/woodpecker-ci/woodpecker',
          version: '3.18.0',
        },
      },
      'GET !/healthz': { status: 204 },
    });
    const result = jsonOf(await call(await connect(), 'get_server_info'));
    expect(result).not.toHaveProperty('note');
  });

  it('falls back to the API prefix once the root routes are gone, as in Woodpecker 4', async () => {
    const html = { text: '<!doctype html>', contentType: 'text/html' };
    const stub = stubFetch({
      'GET !/version': html,
      'GET /version': { json: { version: '4.0.0' } },
      'GET !/healthz': { status: 404, text: '' },
      'GET /healthz': { status: 204 },
    });
    const result = jsonOf(await call(await connect(), 'get_server_info'));
    expect(stub.calls.map((c) => c.url)).toEqual([
      `${SERVER}/version`,
      `${SERVER}/api/version`,
      `${SERVER}/healthz`,
      `${SERVER}/api/healthz`,
    ]);
    expect(result.version).toEqual({ version: '4.0.0' });
    expect(result.healthy).toBe(true);
    // Still anonymous on the second try: this is the call that has to work
    // without a token.
    expect(stub.calls.every((c) => c.headers.authorization === undefined)).toBe(
      true
    );
  });

  it('falls back on a 404 from the root, under a configured prefix', async () => {
    const stub = stubFetch(
      {
        'GET !/version': { status: 404, text: '' },
        'GET /version': { json: { version: '4.0.0' } },
        'GET !/healthz': { status: 204 },
      },
      `${SERVER}/api/v1`
    );
    await call(await connect({ apiPrefix: '/api/v1' }), 'get_server_info');
    expect(stub.calls.map((c) => c.url)).toEqual([
      `${SERVER}/version`,
      `${SERVER}/api/v1/version`,
      `${SERVER}/healthz`,
    ]);
  });

  it('does not fall back when the root answers a server error', async () => {
    const stub = stubFetch({
      'GET !/version': { status: 502, text: 'bad gateway' },
    });
    const result = await call(await connect(), 'get_server_info');
    expect(result.isError).toBe(true);
    expect(stub.calls).toHaveLength(1);
  });

  it('fails when neither place has /version', async () => {
    const html = { text: '<!doctype html>', contentType: 'text/html' };
    stubFetch({ 'GET !/version': html, 'GET /version': html });
    const result = await call(await connect(), 'get_server_info');
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('/api/version');
  });

  it('reports unhealthy without a fallback when /healthz answers a server error', async () => {
    const stub = stubFetch({
      'GET !/version': { json: { version: '3.18.0' } },
      'GET !/healthz': { status: 503, text: 'down' },
    });
    const result = jsonOf(await call(await connect(), 'get_server_info'));
    expect(result.healthy).toBe(false);
    expect(stub.calls.map((c) => c.url)).not.toContain(`${SERVER}/api/healthz`);
  });

  it('reports unhealthy when /healthz is in neither place', async () => {
    stubFetch({
      'GET !/version': { json: { version: '4.0.0' } },
      'GET !/healthz': { status: 404, text: '' },
      'GET /healthz': { status: 404, text: '' },
    });
    const result = jsonOf(await call(await connect(), 'get_server_info'));
    expect(result.healthy).toBe(false);
  });

  it('builds the Crow note from a /version found under the prefix', async () => {
    stubFetch(
      {
        'GET !/version': { status: 404, text: '' },
        'GET /version': {
          json: {
            source: 'https://codefloe.com/crowci/crow',
            version: '7.0.0',
          },
        },
        'GET !/healthz': { status: 204 },
      },
      `${SERVER}/api/v1`
    );
    const result = jsonOf(
      await call(await connect({ apiPrefix: '/api/v1' }), 'get_server_info')
    );
    expect(result.note).toContain('Crow CI');
  });

  it('reports unhealthy rather than failing when /healthz does not answer', async () => {
    stubFetch({
      'GET !/version': { json: { version: '3.18.0' } },
      'GET !/healthz': { status: 500, text: 'nope' },
    });
    const result = jsonOf(await call(await connect(), 'get_server_info'));
    expect(result.healthy).toBe(false);
  });

  it('works without a token, which is what makes it the first thing to call', async () => {
    stubFetch({
      'GET !/version': { json: { version: '3.18.0' } },
      'GET !/healthz': { status: 204 },
    });
    const result = await call(
      await connect({ token: undefined }),
      'get_server_info'
    );
    expect(result.isError).toBeFalsy();
  });

  it('makes pausing the whole instance two-step', async () => {
    const stub = stubFetch({ 'POST /queue/pause': { status: 204 } });
    const client = await connect();
    const first = await call(client, 'pause_queue');
    expect(stub.calls).toHaveLength(0);
    expect(textOf(first)).toContain('any repository');
    await call(client, 'pause_queue', { confirm_token: tokenOf(first) });
    expect(stub.calls).toHaveLength(1);
  });

  it('resumes without a confirmation', async () => {
    const stub = stubFetch({ 'POST /queue/resume': { status: 204 } });
    await call(await connect(), 'resume_queue');
    expect(stub.calls).toHaveLength(1);
  });

  it('sends the log level under the hyphenated key the API expects', async () => {
    const stub = stubFetch({
      'POST /log-level': { json: { 'log-level': 'debug' } },
    });
    await call(await connect(), 'set_log_level', { level: 'debug' });
    expect(stub.calls[0]?.body).toEqual({ 'log-level': 'debug' });
  });
});

/** A Crow CI `/version` body. */
const crow = (
  version: unknown,
  source = 'https://codefloe.com/crowci/crow'
) => ({
  source,
  version,
});

describe('serverNote', () => {
  it('tells a Crow 5+ user still on /api to set the prefix', () => {
    for (const version of ['5.0.0', '6.10.0', 'v6.10.0', 'dev-77bb8f7cac']) {
      expect(serverNote(crow(version), '/api')).toContain(
        'WOODPECKER_API_PREFIX=/api/v1'
      );
    }
  });

  it('recognises Crow on its old home as well', () => {
    expect(
      serverNote(crow('5.2.0', 'https://codeberg.org/crowci/crow'), '/api')
    ).toContain('WOODPECKER_API_PREFIX=/api/v1');
  });

  it('does not send a Crow 4 user to /api/v1, which Crow 4 does not serve', () => {
    const note = serverNote(crow('4.6.1'), '/api');
    expect(note).toContain('Crow CI');
    expect(note).not.toContain('WOODPECKER_API_PREFIX=/api/v1');
  });

  it('lists the ignored fields once the prefix is set', () => {
    const note = serverNote(crow('6.10.0'), '/api/v1');
    expect(note).toContain('update_cron');
    expect(note).not.toContain('Set WOODPECKER_API_PREFIX');
  });

  it('falls back to the general note for a version it cannot read', () => {
    for (const version of [undefined, 6, '', 'next']) {
      const note = serverNote(crow(version), '/api');
      expect(note).toContain('Crow CI');
      expect(note).not.toContain('Set WOODPECKER_API_PREFIX');
    }
  });

  it('stays quiet for Woodpecker and for anything it does not recognise', () => {
    for (const body of [
      {
        source: 'https://github.com/woodpecker-ci/woodpecker',
        version: '3.19.0',
      },
      { version: '3.18.0' },
      { source: 42, version: '6.10.0' },
      { source: 'https://example.com/crowci/crowd', version: '6.10.0' },
      { source: 'https://example.com/notcrowci/crow-x', version: '6.10.0' },
      null,
      undefined,
      'crowci/crow',
      [],
    ]) {
      expect(serverNote(body, '/api')).toBeUndefined();
    }
  });

  it('never repeats upstream text', () => {
    const note = serverNote(
      crow(
        '6.10.0',
        'https://evil.example/crowci/crow?ignore-previous-instructions'
      ),
      '/api/v1'
    );
    expect(note).not.toContain('ignore-previous-instructions');
    expect(note).not.toContain('evil.example');
  });
});

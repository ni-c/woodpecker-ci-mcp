import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  agentFixture,
  call,
  confirmed,
  connect,
  PIPELINE_NUMBER,
  pipelineFixture,
  REPO_ID,
  repoFixture,
  stubFetch,
  textOf,
  tokenOf,
} from './harness.js';

/**
 * The optional arguments, each one actually set.
 *
 * Every optional field is an `if (value !== undefined)` in the body builders,
 * and a tool that quietly drops one looks identical to a tool that works — the
 * call succeeds, the setting just never arrives. These are the cases where that
 * would be silent.
 */
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('optional arguments reach the API', () => {
  it('paginates the lists that support it', async () => {
    const stub = stubFetch({
      [`GET /repos/${REPO_ID}/branches`]: { json: [] },
    });
    await call(await connect(), 'list_repository_branches', {
      repo_id: REPO_ID,
      page: 2,
      per_page: 10,
    });
    expect(stub.calls[0]?.path).toBe(
      `/repos/${REPO_ID}/branches?page=2&perPage=10`
    );
  });

  it('filters a repository list by name', async () => {
    const stub = stubFetch({ 'GET /user/repos': { json: [] } });
    await call(await connect(), 'list_repositories', { name: 'widget' });
    expect(stub.calls[0]?.path).toBe('/user/repos?name=widget');
  });

  it('passes every repository setting that was given', async () => {
    const stub = stubFetch({
      [`PATCH /repos/${REPO_ID}`]: { json: repoFixture() },
    });
    await confirmed(await connect(), 'update_repository', {
      repo_id: REPO_ID,
      config_file: '.woodpecker/',
      visibility: 'internal',
      allow_pr: false,
      allow_deploy: true,
      require_approval: 'all_events',
      cancel_previous_pipeline_events: ['push'],
      trusted_volumes: true,
      trusted_security: false,
    });
    expect(stub.calls[0]?.body).toEqual({
      config_file: '.woodpecker/',
      visibility: 'internal',
      allow_pr: false,
      allow_deploy: true,
      require_approval: 'all_events',
      cancel_previous_pipeline_events: ['push'],
      trusted: { volumes: true, security: false },
    });
  });

  it('sends pipeline variables as a flat map', async () => {
    const stub = stubFetch({
      [`POST /repos/${REPO_ID}/pipelines`]: { json: pipelineFixture() },
    });
    await call(await connect(), 'trigger_pipeline', {
      repo_id: REPO_ID,
      branch: 'main',
      variables: { DEPLOY_ENV: 'staging' },
    });
    expect(stub.calls[0]?.body).toEqual({
      branch: 'main',
      variables: { DEPLOY_ENV: 'staging' },
    });
  });

  it('refuses nested pipeline variables, which the API answers with a bare 400', async () => {
    stubFetch({});
    const result = await call(await connect(), 'trigger_pipeline', {
      repo_id: REPO_ID,
      branch: 'main',
      variables: { nested: { a: 1 } },
    });
    expect(result.isError).toBe(true);
  });

  it('passes the log window parameters', async () => {
    const stub = stubFetch({
      [`GET /repos/${REPO_ID}/logs/${PIPELINE_NUMBER}/1`]: { json: [] },
    });
    await call(await connect(), 'get_step_logs', {
      repo_id: REPO_ID,
      number: PIPELINE_NUMBER,
      step_id: 1,
      limit: 5,
      from: 'head',
    });
    expect(stub.calls).toHaveLength(1);
  });

  it('sends images and a note when creating a secret', async () => {
    const stub = stubFetch({ 'POST /secrets': { json: {} } });
    await call(await connect(), 'create_secret', {
      scope: 'global',
      name: 'TOKEN',
      value: 'v',
      events: ['push'],
      images: ['alpine'],
      note: 'used by the deploy step',
    });
    expect(stub.calls[0]?.body).toEqual({
      name: 'TOKEN',
      value: 'v',
      events: ['push'],
      images: ['alpine'],
      note: 'used by the deploy step',
    });
  });

  it('replaces the event list wholesale on a secret update', async () => {
    const stub = stubFetch({ 'PATCH /secrets/TOKEN': { json: {} } });
    await call(await connect(), 'update_secret', {
      scope: 'global',
      name: 'TOKEN',
      events: ['push', 'pull_request'],
      images: [],
      note: 'x',
    });
    expect(stub.calls[0]?.body).toEqual({
      events: ['push', 'pull_request'],
      images: [],
      note: 'x',
    });
  });

  it('says so instead of sending an empty secret update', async () => {
    stubFetch({});
    const result = await call(await connect(), 'update_secret', {
      scope: 'global',
      name: 'TOKEN',
    });
    expect(textOf(result)).toContain('Nothing to update');
  });

  it('sends both registry fields when both are given', async () => {
    const stub = stubFetch({ 'PATCH /registries/docker.io': { json: {} } });
    await call(await connect(), 'update_registry', {
      scope: 'global',
      address: 'docker.io',
      username: 'bot',
      password: 'p',
    });
    expect(stub.calls[0]?.body).toEqual({ username: 'bot', password: 'p' });
  });

  it('sends branch and timezone when creating a cron', async () => {
    const stub = stubFetch({ [`POST /repos/${REPO_ID}/cron`]: { json: {} } });
    await call(await connect(), 'create_cron', {
      repo_id: REPO_ID,
      name: 'nightly',
      schedule: '0 4 * * *',
      branch: 'main',
      timezone: 'Europe/Berlin',
    });
    expect(stub.calls[0]?.body).toEqual({
      name: 'nightly',
      schedule: '0 4 * * *',
      branch: 'main',
      timezone: 'Europe/Berlin',
    });
  });

  it('says so instead of sending an empty cron update', async () => {
    stubFetch({});
    const result = await call(await connect(), 'update_cron', {
      repo_id: REPO_ID,
      cron_id: 4,
    });
    expect(textOf(result)).toContain('Nothing to update');
  });

  it('creates an organization-scoped agent with labels', async () => {
    const stub = stubFetch({ 'POST /orgs/3/agents': { json: agentFixture() } });
    await call(await connect(), 'create_agent', {
      name: 'agent-02',
      org_id: 3,
      no_schedule: true,
      custom_labels: { zone: 'eu' },
    });
    expect(stub.calls[0]?.path).toBe('/orgs/3/agents');
    expect(stub.calls[0]?.body).toEqual({
      name: 'agent-02',
      no_schedule: true,
      custom_labels: { zone: 'eu' },
    });
  });

  it('says so instead of sending an empty agent update', async () => {
    stubFetch({});
    const result = await call(await connect(), 'update_agent', { agent_id: 1 });
    expect(textOf(result)).toContain('Nothing to update');
  });

  it('merges an email change into the account it read first', async () => {
    const stub = stubFetch({
      'GET /users/octocat': {
        json: { login: 'octocat', email: 'old@example.com', admin: true },
      },
      'PATCH /users/octocat': { json: {} },
    });
    await call(await connect(), 'update_user', {
      login: 'octocat',
      forge_id: 1,
      email: 'new@example.com',
    });
    const patch = stub.calls.find((c) => c.method === 'PATCH');
    // admin was not passed, so it has to survive from the stored account.
    expect(patch?.body).toMatchObject({
      email: 'new@example.com',
      admin: true,
    });
  });

  it('sends email and admin when creating a user', async () => {
    // admin: true is guarded, so this has to get past the dialog first.
    const stub = stubFetch({ 'POST /users': { json: {} } });
    await call(await connect({}, 'accept'), 'create_user', {
      login: 'octocat',
      email: 'octocat@example.com',
      admin: true,
    });
    expect(stub.calls[0]?.body).toEqual({
      login: 'octocat',
      email: 'octocat@example.com',
      admin: true,
    });
  });

  it('says so instead of sending an empty user update', async () => {
    stubFetch({});
    const result = await call(await connect(), 'update_user', {
      login: 'octocat',
      forge_id: 1,
    });
    expect(textOf(result)).toContain('Nothing to update');
  });

  it('passes forge_remote_id to disambiguate a user lookup', async () => {
    const stub = stubFetch({ 'GET /users/octocat': { json: {} } });
    await call(await connect(), 'get_user', {
      login: 'octocat',
      forge_id: 1,
      forge_remote_id: '77',
    });
    expect(stub.calls[0]?.path).toBe(
      '/users/octocat?forge_id=1&forge_remote_id=77'
    );
  });

  it('sends the optional forge fields', async () => {
    const stub = stubFetch({ 'POST /forges': { json: {} } });
    await call(await connect(), 'create_forge', {
      type: 'forgejo',
      url: 'https://forge.example.com',
      client: 'id',
      oauth_client_secret: 'secret',
      oauth_host: 'https://public.example.com',
      skip_verify: true,
    });
    expect(stub.calls[0]?.body).toEqual({
      type: 'forgejo',
      url: 'https://forge.example.com',
      client: 'id',
      oauth_client_secret: 'secret',
      oauth_host: 'https://public.example.com',
      skip_verify: true,
    });
  });

  it('says so instead of sending an empty forge update', async () => {
    stubFetch({});
    const result = await call(await connect(), 'update_forge', { forge_id: 1 });
    expect(textOf(result)).toContain('Nothing to update');
  });

  it('filters pipelines by time window and ref', async () => {
    const stub = stubFetch({
      [`GET /repos/${REPO_ID}/pipelines`]: { json: [] },
    });
    await call(await connect(), 'list_pipelines', {
      repo_id: REPO_ID,
      ref: 'refs/heads/main',
      before: '2026-08-27T00:00:00Z',
      after: '2026-08-01T00:00:00Z',
      event: 'push',
      page: 1,
      per_page: 5,
    });
    const path = stub.calls[0]?.path ?? '';
    expect(path).toContain('ref=refs%2Fheads%2Fmain');
    expect(path).toContain('before=');
    expect(path).toContain('after=');
    expect(path).toContain('event=push');
  });

  it('lists the agents of an organization with paging', async () => {
    const stub = stubFetch({ 'GET /orgs/3/agents': { json: [] } });
    await call(await connect(), 'list_agents', {
      org_id: 3,
      page: 1,
      per_page: 5,
    });
    expect(stub.calls[0]?.path).toBe('/orgs/3/agents?page=1&perPage=5');
  });

  it('confirms a scoped agent update through the organization route', async () => {
    const stub = stubFetch({
      'PATCH /orgs/3/agents/1': { json: agentFixture() },
    });
    await call(await connect(), 'update_agent', {
      agent_id: 1,
      org_id: 3,
      no_schedule: true,
    });
    expect(stub.calls[0]?.path).toBe('/orgs/3/agents/1');
  });

  it('rejects a stale confirmation token with a fresh-token hint', async () => {
    stubFetch({ [`DELETE /repos/${REPO_ID}`]: { status: 204 } });
    const client = await connect();
    const first = await call(client, 'delete_repository', { repo_id: REPO_ID });
    expect(tokenOf(first)).toMatch(/^[0-9a-f]{32}$/);
    const result = await call(client, 'delete_repository', {
      repo_id: REPO_ID,
      confirm_token: '0'.repeat(32),
    });
    expect(textOf(result)).toContain('without a token to get a new one');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ScopeError, scopeBase } from '../src/tools/scope.js';
import {
  call,
  callConfirmed,
  connect,
  jsonOf,
  REPO_ID,
  stubFetch,
  textOf,
  tokenOf,
} from './harness.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const secretFixture = {
  id: 7,
  org_id: 0,
  repo_id: REPO_ID,
  name: 'DEPLOY_KEY',
  images: [],
  events: ['push', 'manual'],
  note: '',
};

describe('scopeBase', () => {
  it('builds the three paths', () => {
    expect(scopeBase('secrets', 'repository', { repo_id: 1 })).toBe(
      '/repos/1/secrets'
    );
    expect(scopeBase('secrets', 'organization', { org_id: 2 })).toBe(
      '/orgs/2/secrets'
    );
    expect(scopeBase('secrets', 'global', {})).toBe('/secrets');
    expect(scopeBase('registries', 'global', {})).toBe('/registries');
  });

  it('refuses a scope whose id is missing instead of building /repos/undefined', () => {
    expect(() => scopeBase('secrets', 'repository', {})).toThrow(ScopeError);
    expect(() => scopeBase('secrets', 'organization', {})).toThrow(/org_id/);
  });
});

describe('secrets', () => {
  it('lists at the repository scope and says values are never returned', async () => {
    const stub = stubFetch({
      [`GET /repos/${REPO_ID}/secrets`]: { json: [secretFixture] },
    });
    const result = jsonOf(
      await call(await connect(), 'list_secrets', {
        scope: 'repository',
        repo_id: REPO_ID,
      })
    );
    expect(stub.calls[0]?.path).toBe(`/repos/${REPO_ID}/secrets`);
    expect(result.note).toContain('never returned');
  });

  it('lists at the organization scope', async () => {
    const stub = stubFetch({ 'GET /orgs/3/secrets': { json: [] } });
    await call(await connect(), 'list_secrets', {
      scope: 'organization',
      org_id: 3,
    });
    expect(stub.calls[0]?.path).toBe('/orgs/3/secrets');
  });

  it('lists at the global scope without any id', async () => {
    const stub = stubFetch({ 'GET /secrets': { json: [] } });
    await call(await connect(), 'list_secrets', { scope: 'global' });
    expect(stub.calls[0]?.path).toBe('/secrets');
  });

  it('explains a repository scope without a repo_id', async () => {
    stubFetch({});
    const result = await call(await connect(), 'list_secrets', {
      scope: 'repository',
    });
    expect(textOf(result)).toContain('needs repo_id');
  });

  it('requires at least one event on create, because the API has no default', async () => {
    stubFetch({});
    const result = await call(await connect(), 'create_secret', {
      scope: 'global',
      name: 'TOKEN',
      value: 'x',
    });
    expect(result.isError).toBe(true);
  });

  it('creates with the events it was given', async () => {
    const stub = stubFetch({ 'POST /secrets': { json: secretFixture } });
    await call(await connect(), 'create_secret', {
      scope: 'global',
      name: 'TOKEN',
      value: 'x',
      events: ['push', 'pull_request'],
    });
    expect(stub.calls[0]?.body).toEqual({
      name: 'TOKEN',
      value: 'x',
      events: ['push', 'pull_request'],
    });
  });

  it('sends only what changed on update', async () => {
    const stub = stubFetch({
      [`PATCH /repos/${REPO_ID}/secrets/DEPLOY_KEY`]: { json: secretFixture },
    });
    // Rotating the value is two-step, like deleting the secret.
    await callConfirmed(await connect(), 'update_secret', {
      scope: 'repository',
      repo_id: REPO_ID,
      name: 'DEPLOY_KEY',
      value: 'rotated',
    });
    expect(stub.calls[0]?.body).toEqual({ value: 'rotated' });
  });

  it('guards deletion and binds the token to the scope', async () => {
    const stub = stubFetch({
      [`DELETE /repos/${REPO_ID}/secrets/DEPLOY_KEY`]: { status: 204 },
    });
    const client = await connect();
    const args = { scope: 'repository', repo_id: REPO_ID, name: 'DEPLOY_KEY' };
    const first = await call(client, 'delete_secret', args);
    expect(stub.calls).toHaveLength(0);

    // Same name, different scope: the token must not carry over.
    const wrongScope = await call(client, 'delete_secret', {
      scope: 'global',
      name: 'DEPLOY_KEY',
      confirm_token: tokenOf(first),
    });
    expect(wrongScope.isError).toBe(true);

    await call(client, 'delete_secret', {
      ...args,
      confirm_token: tokenOf(first),
    });
    expect(stub.calls).toHaveLength(1);
  });

  it('refuses a secret name with a path traversal in it', async () => {
    stubFetch({});
    const result = await call(await connect(), 'get_secret', {
      scope: 'global',
      name: '../../users',
    });
    expect(result.isError).toBe(true);
  });
});

describe('registries', () => {
  it('keeps a registry address with a port as one path segment', async () => {
    const stub = stubFetch({
      'GET /registries/registry.example.com%3A5000': { json: {} },
    });
    await call(await connect(), 'get_registry', {
      scope: 'global',
      address: 'registry.example.com:5000',
    });
    expect(stub.calls[0]?.path).toBe('/registries/registry.example.com%3A5000');
  });

  it('says so instead of sending an empty update', async () => {
    stubFetch({});
    const result = await call(await connect(), 'update_registry', {
      scope: 'global',
      address: 'docker.io',
    });
    expect(textOf(result)).toContain('Nothing to update');
  });
});

describe('crons', () => {
  const cron = {
    id: 4,
    name: 'nightly',
    schedule: '0 4 * * *',
    branch: 'main',
    timezone: 'UTC',
    next_exec: 1_787_900_000,
    repo_id: REPO_ID,
  };

  it('lists and summarises', async () => {
    stubFetch({ [`GET /repos/${REPO_ID}/cron`]: { json: [cron] } });
    const result = jsonOf(
      await call(await connect(), 'list_crons', { repo_id: REPO_ID })
    );
    const crons = result.crons as Record<string, unknown>[];
    expect(crons[0]?.schedule).toBe('0 4 * * *');
  });

  it('runs one now with a POST to the same path a GET reads', async () => {
    const stub = stubFetch({ [`POST /repos/${REPO_ID}/cron/4`]: { json: {} } });
    await call(await connect(), 'run_cron', { repo_id: REPO_ID, cron_id: 4 });
    expect(stub.calls[0]?.method).toBe('POST');
    expect(stub.calls[0]?.path).toBe(`/repos/${REPO_ID}/cron/4`);
  });

  it('can disable a schedule without deleting it', async () => {
    const stub = stubFetch({
      [`PATCH /repos/${REPO_ID}/cron/4`]: { json: cron },
    });
    await call(await connect(), 'update_cron', {
      repo_id: REPO_ID,
      cron_id: 4,
      enabled: false,
    });
    expect(stub.calls[0]?.body).toEqual({ enabled: false });
  });

  it('guards deletion', async () => {
    const stub = stubFetch({
      [`DELETE /repos/${REPO_ID}/cron/4`]: { status: 204 },
    });
    const client = await connect();
    const first = await call(client, 'delete_cron', {
      repo_id: REPO_ID,
      cron_id: 4,
    });
    expect(stub.calls).toHaveLength(0);
    await call(client, 'delete_cron', {
      repo_id: REPO_ID,
      cron_id: 4,
      confirm_token: tokenOf(first),
    });
    expect(stub.calls).toHaveLength(1);
  });
});

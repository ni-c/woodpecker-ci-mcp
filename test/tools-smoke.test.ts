import { afterEach, describe, expect, it, vi } from 'vitest';

import { ALL_TOOLS } from '../src/tools/catalogue.js';
import {
  agentFixture,
  call,
  connect,
  logLine,
  PIPELINE_NUMBER,
  pipelineFixture,
  REPO_ID,
  repoFixture,
  STEP_ID,
  stubFetch,
  textOf,
  tokenOf,
} from './harness.js';

/**
 * Every tool, once, against the endpoint it is supposed to call.
 *
 * Two things this catches that the focused tests do not. First, a tool whose
 * path is simply wrong: the stub refuses an unrouted request, so a typo in a
 * path is a failure here rather than a 404 discovered in production. Second,
 * coverage of the whole surface — 71 tools is more than anyone reviews by
 * reading, and a tool nobody ever calls is a tool nobody notices is broken.
 *
 * The expected request is written out per tool on purpose. Deriving it from the
 * implementation would make this test agree with whatever the code does, which
 * is the one thing it must not do.
 */
interface Case {
  /** Arguments for the call. */
  args?: Record<string, unknown>;
  /** `"<METHOD> <path>"`, exactly as the server should request it. */
  expect: string;
  /** What the stub answers. */
  reply?: { json?: unknown; status?: number; text?: string };
  /** True for the two-step tools: the case runs twice, with the token. */
  guarded?: boolean;
  /** Extra routes a tool needs beyond the one it is checked against. */
  alsoRoute?: Record<
    string,
    { json?: unknown; status?: number; text?: string }
  >;
}

const repo = repoFixture();
const pipeline = pipelineFixture();
const secret = { id: 1, name: 'TOKEN', events: ['push'], images: [] };
const registry = { id: 1, address: 'docker.io', username: 'bot' };
const cron = { id: 4, name: 'nightly', schedule: '@daily' };
const org = { id: 3, name: 'acme', is_user: false };
const user = { id: 5, login: 'octocat', admin: false };
const forge = { id: 1, type: 'gitea', url: 'https://forge.example.com' };

const CASES: Record<string, Case> = {
  // Repositories
  list_repositories: { expect: 'GET /user/repos', reply: { json: [repo] } },
  get_repository: {
    args: { repo_id: REPO_ID },
    expect: `GET /repos/${REPO_ID}`,
    reply: { json: repo },
  },
  lookup_repository: {
    args: { full_name: 'acme/widgets' },
    expect: 'GET /repos/lookup/acme%2Fwidgets',
    reply: { json: repo },
  },
  get_repository_permissions: {
    args: { repo_id: REPO_ID },
    expect: `GET /repos/${REPO_ID}/permissions`,
    reply: { json: { pull: true, push: true, admin: false } },
  },
  list_repository_branches: {
    args: { repo_id: REPO_ID },
    expect: `GET /repos/${REPO_ID}/branches`,
    reply: { json: ['main'] },
  },
  list_pull_requests: {
    args: { repo_id: REPO_ID },
    expect: `GET /repos/${REPO_ID}/pull_requests`,
    reply: { json: [{ index: 42, title: 'A change' }] },
  },
  activate_repository: {
    args: { forge_remote_id: '48765432' },
    expect: 'POST /repos?forge_remote_id=48765432',
    reply: { json: repo },
  },
  update_repository: {
    args: { repo_id: REPO_ID, timeout: 30 },
    expect: `PATCH /repos/${REPO_ID}`,
    reply: { json: repo },
  },
  repair_repository: {
    args: { repo_id: REPO_ID },
    expect: `POST /repos/${REPO_ID}/repair`,
    reply: { status: 204 },
  },
  move_repository: {
    args: { repo_id: REPO_ID, to: 'acme/gadgets' },
    expect: `POST /repos/${REPO_ID}/move?to=acme%2Fgadgets`,
    reply: { status: 204 },
    guarded: true,
  },
  chown_repository: {
    args: { repo_id: REPO_ID },
    expect: `POST /repos/${REPO_ID}/chown`,
    reply: { json: repo },
  },
  delete_repository: {
    args: { repo_id: REPO_ID },
    expect: `DELETE /repos/${REPO_ID}`,
    reply: { status: 204 },
    guarded: true,
  },

  // Pipelines
  list_pipelines: {
    args: { repo_id: REPO_ID },
    expect: `GET /repos/${REPO_ID}/pipelines`,
    reply: { json: [pipeline] },
  },
  get_pipeline: {
    args: { repo_id: REPO_ID, number: PIPELINE_NUMBER },
    expect: `GET /repos/${REPO_ID}/pipelines/${PIPELINE_NUMBER}`,
    reply: { json: pipeline },
  },
  get_pipeline_config: {
    args: { repo_id: REPO_ID, number: PIPELINE_NUMBER },
    expect: `GET /repos/${REPO_ID}/pipelines/${PIPELINE_NUMBER}/config`,
    reply: {
      json: [
        {
          name: '.woodpecker.yml',
          hash: 'abc',
          data: Buffer.from('steps:\n  build:\n').toString('base64'),
        },
      ],
    },
  },
  get_pipeline_metadata: {
    args: { repo_id: REPO_ID, number: PIPELINE_NUMBER },
    expect: `GET /repos/${REPO_ID}/pipelines/${PIPELINE_NUMBER}/metadata`,
    reply: { json: { repo: {}, curr: {}, prev: {} } },
  },
  list_queued_pipelines: { expect: 'GET /pipelines', reply: { json: [] } },
  trigger_pipeline: {
    args: { repo_id: REPO_ID, branch: 'main' },
    expect: `POST /repos/${REPO_ID}/pipelines`,
    reply: { json: pipeline },
  },
  restart_pipeline: {
    args: { repo_id: REPO_ID, number: PIPELINE_NUMBER },
    expect: `POST /repos/${REPO_ID}/pipelines/${PIPELINE_NUMBER}`,
    reply: { json: pipeline },
  },
  cancel_pipeline: {
    args: { repo_id: REPO_ID, number: PIPELINE_NUMBER },
    expect: `POST /repos/${REPO_ID}/pipelines/${PIPELINE_NUMBER}/cancel`,
    reply: { status: 204 },
  },
  approve_pipeline: {
    args: { repo_id: REPO_ID, number: PIPELINE_NUMBER },
    expect: `POST /repos/${REPO_ID}/pipelines/${PIPELINE_NUMBER}/approve`,
    reply: { json: pipeline },
  },
  decline_pipeline: {
    args: { repo_id: REPO_ID, number: PIPELINE_NUMBER },
    expect: `POST /repos/${REPO_ID}/pipelines/${PIPELINE_NUMBER}/decline`,
    reply: { json: pipeline },
  },
  delete_pipeline: {
    args: { repo_id: REPO_ID, number: PIPELINE_NUMBER },
    expect: `DELETE /repos/${REPO_ID}/pipelines/${PIPELINE_NUMBER}`,
    reply: { status: 204 },
    guarded: true,
  },

  // Logs
  get_step_logs: {
    args: { repo_id: REPO_ID, number: PIPELINE_NUMBER, step_id: STEP_ID },
    expect: `GET /repos/${REPO_ID}/logs/${PIPELINE_NUMBER}/${STEP_ID}`,
    reply: { json: [logLine(0, 'output\n')] },
  },
  delete_step_logs: {
    args: { repo_id: REPO_ID, number: PIPELINE_NUMBER, step_id: STEP_ID },
    expect: `DELETE /repos/${REPO_ID}/logs/${PIPELINE_NUMBER}/${STEP_ID}`,
    reply: { status: 204 },
    guarded: true,
  },
  delete_pipeline_logs: {
    args: { repo_id: REPO_ID, number: PIPELINE_NUMBER },
    expect: `DELETE /repos/${REPO_ID}/logs/${PIPELINE_NUMBER}`,
    reply: { status: 204 },
    guarded: true,
  },

  // Secrets
  list_secrets: {
    args: { scope: 'global' },
    expect: 'GET /secrets',
    reply: { json: [secret] },
  },
  get_secret: {
    args: { scope: 'global', name: 'TOKEN' },
    expect: 'GET /secrets/TOKEN',
    reply: { json: secret },
  },
  create_secret: {
    args: { scope: 'global', name: 'TOKEN', value: 'v', events: ['push'] },
    expect: 'POST /secrets',
    reply: { json: secret },
  },
  update_secret: {
    args: { scope: 'global', name: 'TOKEN', value: 'v2' },
    expect: 'PATCH /secrets/TOKEN',
    reply: { json: secret },
  },
  delete_secret: {
    args: { scope: 'global', name: 'TOKEN' },
    expect: 'DELETE /secrets/TOKEN',
    reply: { status: 204 },
    guarded: true,
  },

  // Registries
  list_registries: {
    args: { scope: 'organization', org_id: 3 },
    expect: 'GET /orgs/3/registries',
    reply: { json: [registry] },
  },
  get_registry: {
    args: { scope: 'global', address: 'docker.io' },
    expect: 'GET /registries/docker.io',
    reply: { json: registry },
  },
  create_registry: {
    args: {
      scope: 'global',
      address: 'docker.io',
      username: 'bot',
      password: 'p',
    },
    expect: 'POST /registries',
    reply: { json: registry },
  },
  update_registry: {
    args: { scope: 'global', address: 'docker.io', password: 'p2' },
    expect: 'PATCH /registries/docker.io',
    reply: { json: registry },
  },
  delete_registry: {
    args: { scope: 'global', address: 'docker.io' },
    expect: 'DELETE /registries/docker.io',
    reply: { status: 204 },
    guarded: true,
  },

  // Crons
  list_crons: {
    args: { repo_id: REPO_ID },
    expect: `GET /repos/${REPO_ID}/cron`,
    reply: { json: [cron] },
  },
  get_cron: {
    args: { repo_id: REPO_ID, cron_id: 4 },
    expect: `GET /repos/${REPO_ID}/cron/4`,
    reply: { json: cron },
  },
  create_cron: {
    args: { repo_id: REPO_ID, name: 'nightly', schedule: '@daily' },
    expect: `POST /repos/${REPO_ID}/cron`,
    reply: { json: cron },
  },
  update_cron: {
    args: { repo_id: REPO_ID, cron_id: 4, enabled: false },
    expect: `PATCH /repos/${REPO_ID}/cron/4`,
    reply: { json: cron },
  },
  run_cron: {
    args: { repo_id: REPO_ID, cron_id: 4 },
    expect: `POST /repos/${REPO_ID}/cron/4`,
    reply: { json: pipeline },
  },
  delete_cron: {
    args: { repo_id: REPO_ID, cron_id: 4 },
    expect: `DELETE /repos/${REPO_ID}/cron/4`,
    reply: { status: 204 },
    guarded: true,
  },

  // Organizations
  list_organizations: { expect: 'GET /orgs', reply: { json: [org] } },
  get_organization: {
    args: { org_id: 3 },
    expect: 'GET /orgs/3',
    reply: { json: org },
  },
  lookup_organization: {
    args: { name: 'acme' },
    expect: 'GET /orgs/lookup/acme',
    reply: { json: org },
  },
  get_organization_permissions: {
    args: { org_id: 3 },
    expect: 'GET /orgs/3/permissions',
    reply: { json: { member: true, admin: false } },
  },
  delete_organization: {
    args: { org_id: 3 },
    expect: 'DELETE /orgs/3',
    reply: { status: 204 },
    guarded: true,
  },

  // The authenticated account
  get_current_user: { expect: 'GET /user', reply: { json: user } },
  get_pipeline_feed: {
    expect: 'GET /user/feed',
    reply: {
      json: [{ ...pipeline, repo_id: REPO_ID, full_name: 'acme/widgets' }],
    },
  },

  // Users
  list_users: { expect: 'GET /users', reply: { json: [user] } },
  get_user: {
    args: { login: 'octocat', forge_id: 1 },
    expect: 'GET /users/octocat?forge_id=1',
    reply: { json: user },
  },
  create_user: {
    args: { login: 'octocat' },
    expect: 'POST /users',
    reply: { json: user },
  },
  update_user: {
    // Reads the account first — see the note on PatchUser in src/tools/users.ts.
    args: { login: 'octocat', forge_id: 1, admin: true },
    expect: 'PATCH /users/octocat',
    reply: { json: user },
    alsoRoute: { 'GET /users/octocat?forge_id=1': { json: user } },
  },
  delete_user: {
    args: { login: 'octocat', forge_id: 1 },
    expect: 'DELETE /users/octocat?forge_id=1',
    reply: { status: 204 },
    guarded: true,
  },

  // Agents
  list_agents: { expect: 'GET /agents', reply: { json: [agentFixture()] } },
  get_agent: {
    args: { agent_id: 1 },
    expect: 'GET /agents/1',
    reply: { json: agentFixture() },
  },
  list_agent_tasks: {
    args: { agent_id: 1 },
    expect: 'GET /agents/1/tasks',
    reply: { json: [] },
  },
  create_agent: {
    args: { name: 'agent-02' },
    expect: 'POST /agents',
    reply: { json: agentFixture() },
  },
  update_agent: {
    args: { agent_id: 1, name: 'renamed' },
    expect: 'PATCH /agents/1',
    reply: { json: agentFixture() },
  },
  delete_agent: {
    args: { agent_id: 1 },
    expect: 'DELETE /agents/1',
    reply: { status: 204 },
    guarded: true,
  },

  // Forges
  list_forges: { expect: 'GET /forges', reply: { json: [forge] } },
  get_forge: {
    args: { forge_id: 1 },
    expect: 'GET /forges/1',
    reply: { json: forge },
  },
  create_forge: {
    args: {
      type: 'gitea',
      url: 'https://forge.example.com',
      client: 'id',
      oauth_client_secret: 'secret',
    },
    expect: 'POST /forges',
    reply: { json: forge },
  },
  update_forge: {
    args: { forge_id: 1, url: 'https://forge.example.com' },
    expect: 'PATCH /forges/1',
    reply: { json: forge },
    guarded: true,
  },
  delete_forge: {
    args: { forge_id: 1 },
    expect: 'DELETE /forges/1',
    reply: { status: 204 },
    guarded: true,
  },

  // Server and queue
  get_server_info: {
    expect: 'GET !/version',
    reply: { json: { version: '3.18.0' } },
  },
  get_queue_info: { expect: 'GET /queue/info', reply: { json: { stats: {} } } },
  get_log_level: {
    expect: 'GET /log-level',
    reply: { json: { 'log-level': 'info' } },
  },
  pause_queue: {
    expect: 'POST /queue/pause',
    reply: { status: 204 },
    guarded: true,
  },
  resume_queue: { expect: 'POST /queue/resume', reply: { status: 204 } },
  set_log_level: {
    args: { level: 'debug' },
    expect: 'POST /log-level',
    reply: { json: { 'log-level': 'debug' } },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('every tool in the catalogue', () => {
  it('has a smoke case', () => {
    expect(Object.keys(CASES).sort()).toEqual([...ALL_TOOLS].sort());
  });

  it.each(Object.entries(CASES))(
    '%s reaches its endpoint',
    async (name, testCase) => {
      const routes: Record<
        string,
        { json?: unknown; status?: number; text?: string }
      > = {
        [testCase.expect]: testCase.reply ?? { json: {} },
      };
      // get_server_info makes a second, root-level call for the health probe.
      if (name === 'get_server_info') routes['GET !/healthz'] = { status: 204 };
      Object.assign(routes, testCase.alsoRoute ?? {});

      const stub = stubFetch(routes);
      const client = await connect();
      const args = testCase.args ?? {};

      let result = await call(client, name, args);
      if (testCase.guarded) {
        expect(
          stub.calls,
          `${name} acted before it was confirmed`
        ).toHaveLength(0);
        result = await call(client, name, {
          ...args,
          confirm_token: tokenOf(result),
        });
      }

      expect(result.isError, `${name} failed: ${textOf(result)}`).toBeFalsy();
      expect(stub.calls.length, `${name} made no request`).toBeGreaterThan(0);
    }
  );
});

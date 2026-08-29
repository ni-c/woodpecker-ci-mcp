import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { vi } from 'vitest';

import type { Config } from '../src/config.js';
import { createServer } from '../src/server.js';

export const SERVER = 'https://woodpecker.example.com';
export const API = `${SERVER}/api`;
export const TOKEN = 'test-token';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    url: SERVER,
    token: TOKEN,
    insecureTls: false,
    readOnly: false,
    allowTools: undefined,
    denyTools: undefined,
    ...overrides,
  };
}

export interface Recorded {
  method: string;
  url: string;
  /** The path with `/api` stripped, or the bare path for root-level calls. */
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface Reply {
  status?: number;
  json?: unknown;
  text?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

export type Handler = Reply | ((request: Recorded) => Reply);

/**
 * Routes are keyed `"<METHOD> <path>"`.
 *
 * The path excludes `/api` for normal calls; the two root-level endpoints are
 * keyed with a leading `!`, so that a test cannot accidentally satisfy
 * `GET /version` with a route meant for `GET /api/version`. That distinction is
 * the whole point of `RequestOptions.root` — on a real instance the second one
 * returns the web UI.
 */
export type Routes = Record<string, Handler>;

export interface FetchStub {
  calls: Recorded[];
}

/**
 * Replaces global fetch with a router over canned replies.
 *
 * A request with no matching route fails the test loudly rather than returning
 * an empty object: a tool that silently queries the wrong path would otherwise
 * pass every assertion about its output.
 */
export function stubFetch(routes: Routes = {}): FetchStub {
  const calls: Recorded[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const underApi = url.startsWith(API);
      const path = underApi
        ? url.slice(API.length)
        : url.startsWith(SERVER)
          ? url.slice(SERVER.length)
          : url;
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(
        (init?.headers ?? {}) as Record<string, string>
      )) {
        headers[key.toLowerCase()] = value;
      }
      const recorded: Recorded = {
        method,
        url,
        path,
        headers,
        body:
          init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      calls.push(recorded);

      const prefix = underApi ? '' : '!';
      const bare = path.split('?')[0];
      const exact =
        routes[`${method} ${prefix}${path}`] ??
        routes[`${method} ${prefix}${bare}`];
      if (exact === undefined) {
        throw new Error(`no stubbed route for ${method} ${prefix}${path}`);
      }
      const reply = typeof exact === 'function' ? exact(recorded) : exact;
      const body =
        reply.text !== undefined
          ? reply.text
          : JSON.stringify(reply.json ?? {});
      return new Response(reply.status === 204 ? null : body, {
        status: reply.status ?? 200,
        headers: {
          'content-type':
            reply.contentType ??
            (reply.text !== undefined ? 'text/plain' : 'application/json'),
          ...reply.headers,
        },
      });
    })
  );
  return { calls };
}

export async function connect(
  overrides: Partial<Config> = {}
): Promise<Client> {
  const server = createServer(testConfig(overrides));
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return client;
}

export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

/** The text of a tool result, joined across content blocks. */
export function textOf(result: CallToolResult): string {
  return result.content
    .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
    .join('\n');
}

/** The first JSON object embedded in a tool result. */
export function jsonOf(result: CallToolResult): Record<string, unknown> {
  const text = textOf(result);
  const start = text.indexOf('{');
  return JSON.parse(text.slice(start)) as Record<string, unknown>;
}

/**
 * Calls a guarded tool the way a client has to: once to be told no and handed a
 * token, then again with it. Returns the second result — the one that acted.
 */
export async function callConfirmed(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const first = await call(client, name, args);
  return call(client, name, { ...args, confirm_token: tokenOf(first) });
}

/** The confirmation token a guarded tool handed back on its first call. */
export function tokenOf(result: CallToolResult): string {
  const match = /confirm_token="([0-9a-f]{32})"/.exec(textOf(result));
  if (!match?.[1])
    throw new Error(`no confirmation token in: ${textOf(result)}`);
  return match[1];
}

/** Base64-encodes a log line the way Woodpecker does. */
export function logLine(line: number, text: string, type = 0): unknown {
  return {
    id: 59_793_422 + line,
    step_id: STEP_ID,
    time: line,
    line,
    data: Buffer.from(text, 'utf8').toString('base64'),
    type,
  };
}

export const REPO_ID = 21;
export const PIPELINE_NUMBER = 1015;
export const STEP_ID = 84_222;

/*
 * The fixtures below were captured from a real Woodpecker 3.18.0 instance on
 * 2026-08-27 and then only reduced and renamed, never rewritten. That matters:
 * a fixture written from my reading of the upstream source could only prove the
 * server is consistent with my understanding, not that the understanding is
 * right. Three things these captures pinned down:
 *
 *   - `errors` and `event_reason` come back as JSON null, not as absent keys or
 *     empty arrays, so anything walking them has to tolerate null.
 *   - a pipeline's steps are `workflows[].children[]`, and the step id that
 *     `get_step_logs` needs is on the child, while `pid`/`ppid` are per-pipeline
 *     counters that look like ids and are not.
 *   - a log entry's `data` is base64 of a *chunk* — usually one line with its
 *     trailing newline, which is why the decoder strips that newline instead of
 *     joining the chunks blindly.
 *
 * Names and hosts were replaced with documentation values: the real instance is
 * a company one and its repository names have no business in a public repo.
 */

export function repoFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: REPO_ID,
    forge_id: 1,
    forge_remote_id: '48765432',
    owner: 'acme',
    name: 'widgets',
    full_name: 'acme/widgets',
    avatar_url: `${SERVER}/avatar/acme`,
    forge_url: 'https://forge.example.com/acme/widgets',
    clone_url: 'https://forge.example.com/acme/widgets.git',
    clone_url_ssh: 'git@forge.example.com:acme/widgets.git',
    default_branch: 'development',
    pr_enabled: true,
    timeout: 60,
    visibility: 'private',
    private: true,
    trusted: { network: false, security: false, volumes: false },
    require_approval: 'forks',
    active: true,
    allow_pr: true,
    allow_deploy: false,
    config_file: '',
    netrc_trusted: [],
    org_id: 3,
    ...overrides,
  };
}

export function pipelineFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 20_330,
    number: PIPELINE_NUMBER,
    author: 'octocat',
    parent: 0,
    event: 'manual',
    event_reason: null,
    status: 'success',
    errors: null,
    created: 1_787_823_080,
    updated: 1_787_823_502,
    started: 1_787_823_082,
    finished: 1_787_823_502,
    deploy_to: '',
    commit: '01aeae08c59f9c2ae4b02da88e87bc5f191fbed3',
    branch: 'development',
    rerun_count: 0,
    ref: 'refs/heads/development',
    author_avatar: 'https://forge.example.com/avatars/octocat',
    forge_url:
      'https://forge.example.com/acme/widgets/commit/01aeae08c59f9c2ae4b02da88e87bc5f191fbed3',
    reviewed_by: '',
    reviewed: 0,
    version: '3.18.0',
    title: '',
    message:
      'MANUAL PIPELINE @ development\n\nwith a body nobody needs in a list',
    timestamp: 1_787_823_080,
    author_email: 'octocat@example.com',
    workflows: [
      {
        id: 14_106,
        pipeline_id: 20_330,
        pid: 1,
        name: 'woodpecker',
        state: 'success',
        started: 1_787_823_082,
        finished: 1_787_823_502,
        agent_id: 1,
        children: [
          {
            id: STEP_ID,
            uuid: '01M118YHBQHT9B22261HVH911Q',
            pipeline_id: 20_330,
            pid: 2,
            ppid: 1,
            name: 'clone',
            state: 'success',
            exit_code: 0,
            started: 1_787_823_084,
            finished: 1_787_823_089,
            type: 'clone',
          },
        ],
      },
    ],
    ...overrides,
  };
}

/** An agent as the API really returns it — token included, in clear text. */
export function agentFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: 'agent-01',
    owner_id: 1,
    org_id: -1,
    token: 'DO-NOT-LEAK-this-is-an-agent-token',
    last_contact: 1_787_823_502,
    last_work: 1_787_823_502,
    platform: 'linux/amd64',
    backend: 'docker',
    capacity: 4,
    version: '3.18.0',
    no_schedule: false,
    custom_labels: {},
    created: 1_700_000_000,
    updated: 1_787_823_502,
    ...overrides,
  };
}

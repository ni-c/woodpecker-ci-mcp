import { describe, expect, it } from 'vitest';

import {
  listOf,
  objectOf,
  redactAgent,
  summarizeCron,
  summarizePipeline,
  summarizeRepo,
  summarizeUser,
  summarizeWorkflows,
} from '../src/normalize.js';
import { agentFixture, pipelineFixture, repoFixture } from './harness.js';

describe('listOf', () => {
  it('reads an array', () => {
    expect(listOf([{ a: 1 }], 'things')).toHaveLength(1);
  });

  it('treats null as empty — the API sends it for absent lists', () => {
    expect(listOf(null, 'things')).toEqual([]);
    expect(listOf(undefined, 'things')).toEqual([]);
  });

  it('refuses anything else rather than reporting an empty result', () => {
    expect(() => listOf({ not: 'an array' }, 'things')).toThrow(
      /expected a list/
    );
  });
});

describe('objectOf', () => {
  it('refuses an array or a null', () => {
    expect(() => objectOf([], 'repository')).toThrow();
    expect(() => objectOf(null, 'repository')).toThrow();
  });
});

describe('redactAgent', () => {
  it('replaces the token rather than dropping the field silently', () => {
    // A missing field reads as "this agent has no token", which is never true.
    const redacted = redactAgent(agentFixture());
    expect(redacted.token).toContain('redacted');
    expect(redacted.token).not.toContain('DO-NOT-LEAK');
  });

  it('leaves an agent without a token alone', () => {
    // Not `delete agent.token`: the fixture types `token` as required, so the
    // delete is a type error and the field has to be absent rather than
    // undefined — which is the state this test is about in the first place.
    const { token: _token, ...agent } = agentFixture();
    expect(redactAgent(agent).token).toBeUndefined();
  });

  it('keeps everything else', () => {
    expect(redactAgent(agentFixture()).platform).toBe('linux/amd64');
  });
});

describe('the summaries', () => {
  it('keeps a repository identifiable and drops the extension noise', () => {
    const summary = summarizeRepo(repoFixture());
    expect(summary.full_name).toBe('acme/widgets');
    expect(summary.default_branch).toBe('development');
    expect(Object.keys(summary)).not.toContain('secret_extension_endpoint');
  });

  it('keeps forge_remote_id, which activate_repository needs', () => {
    // An inactive repository has no Woodpecker id yet, so this is the only
    // handle on it — and list_repositories is where the tool description sends
    // people to find it.
    expect(summarizeRepo(repoFixture()).forge_remote_id).toBe('48765432');
  });

  it('shortens a commit to twelve characters and a message to its subject', () => {
    const summary = summarizePipeline(pipelineFixture());
    expect(summary.commit).toBe('01aeae08c59f');
    expect(summary.message).toBe('MANUAL PIPELINE @ development');
  });

  it('truncates an absurdly long subject line', () => {
    const summary = summarizePipeline(
      pipelineFixture({ message: 'x'.repeat(500) })
    );
    expect(String(summary.message)).toHaveLength(201);
  });

  it('flattens workflows to their steps', () => {
    const workflows = summarizeWorkflows(pipelineFixture());
    expect(workflows).toHaveLength(1);
    expect(workflows[0]?.steps as unknown[]).toHaveLength(1);
  });

  it('returns no workflows when the pipeline carries none', () => {
    expect(summarizeWorkflows(pipelineFixture({ workflows: null }))).toEqual(
      []
    );
  });

  it('summarises crons and users', () => {
    expect(
      summarizeCron({ id: 1, name: 'n', schedule: '@daily' }).schedule
    ).toBe('@daily');
    expect(summarizeUser({ id: 1, login: 'octocat', admin: true }).admin).toBe(
      true
    );
  });
});

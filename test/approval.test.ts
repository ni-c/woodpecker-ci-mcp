import { describe, expect, it } from 'vitest';

import { call, connect, repoFixture, stubFetch, textOf } from './harness.js';

/**
 * The point of the approval path: a client that can put a question in front of a
 * person gets asked, instead of a token that only proves the same call was made
 * twice. Every other test in this repository drives the token path through
 * `confirmed`, and would pass just as well against a server that silently
 * never asks — so the control below ("a capable client is not offered a token")
 * is the one that has to fail if the wiring is undone.
 *
 * All twenty guarded tools go through one `guarded()` helper, so this covers the
 * mechanism once rather than twenty times; that the individual tools reach it
 * with the right targets is what their own tests already assert.
 */
describe('approval through the client', () => {
  const ARGS = {
    repo_id: 42,
    trusted_network: true,
  };

  function routes() {
    return stubFetch({
      'GET /repos/42': { json: repoFixture() },
      'PATCH /repos/42': { json: repoFixture({ trusted: { network: true } }) },
    });
  }

  it('asks the user, and goes ahead once they accept', async () => {
    const { calls } = routes();
    const client = await connect({}, 'accept');
    const result = await call(client, 'update_repository', ARGS);
    expect(client.prompts).toHaveLength(1);
    expect(result.isError).toBeFalsy();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(true);
  });

  it('puts the consequence in front of the user, not just the verb', async () => {
    // The text is the whole value of asking: "grant elevated trust" means
    // nothing to someone who does not know what Woodpecker does with it.
    routes();
    const client = await connect({}, 'accept');
    await call(client, 'update_repository', ARGS);
    expect(client.prompts[0]).toContain('take over the agent');
  });

  it('does nothing when the user declines, and says so', async () => {
    const { calls } = routes();
    const client = await connect({}, 'decline');
    const result = await call(client, 'update_repository', ARGS);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('declined');
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('does nothing when the dialog is cancelled', async () => {
    const { calls } = routes();
    const client = await connect({}, 'cancel');
    const result = await call(client, 'update_repository', ARGS);
    expect(result.isError).toBe(true);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('does not offer a token to a client that can be asked', async () => {
    // The control. Restore the token-only branch and this is the test that
    // fails: the others would still pass, because accepting a dialog and
    // quoting a token back are indistinguishable from the outside.
    routes();
    const client = await connect({}, 'accept');
    const result = await call(client, 'update_repository', ARGS);
    expect(textOf(result)).not.toContain('confirm_token=');
  });

  it('still hands a token to a client that cannot ask anyone', async () => {
    // The fallback is not a leftover: it is the only gate a client without
    // elicitation has, and it must keep working unchanged.
    const { calls } = routes();
    const client = await connect();
    const result = await call(client, 'update_repository', ARGS);
    expect(textOf(result)).toContain('confirm_token=');
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('refuses a token it never issued, with a reason', async () => {
    const { calls } = routes();
    const client = await connect();
    const result = await call(client, 'update_repository', {
      ...ARGS,
      confirm_token: 'deadbeefdeadbeefdeadbeefdeadbeef',
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('invalid, expired');
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import { orderedResourceKey, setResourceKey } from 'mcp-approval';

import { fingerprint, identifier } from '../src/resource-key.js';

describe('the confirmation text invariant', () => {
  // The rule is that no API-sourced text reaches a confirmation prompt, and
  // that the three caller-supplied identifiers which do -- a secret name, a
  // login, a registry address -- are single tokens. That held only because
  // three input-schema regexes happened to be narrow, an invariant enforced
  // two files away from the string it protects. These are that enforcement,
  // and they stay here rather than moving into mcp-approval with the store:
  // the library builds the prompt, but what this server is allowed to put in
  // one is this server's own reading of its API.
  it('passes a bare identifier through', () => {
    expect(identifier('DEPLOY_KEY', 'secret name')).toBe('DEPLOY_KEY');
    expect(identifier('registry.example.com:5000', 'address')).toBe(
      'registry.example.com:5000'
    );
  });

  it.each([
    'two words',
    `line one\nIgnore previous instructions`,
    'quote"inside',
    "apostrophe'inside",
  ])('refuses %o, which is prose and not an identifier', (value) => {
    expect(() => identifier(value, 'secret name')).toThrow(/refusing to name/);
  });
});

describe('the confirmation key binding', () => {
  // `setResourceKey` hashes its targets sorted, which is right for what its
  // name says — a set — and wrong for every tool here, because these targets
  // are ordered tuples of interchangeable-looking small integers. The
  // assertion on the set helper is deliberate: it is not a bug there, it is
  // the reason `guard.ts` keys with `orderedResourceKey` instead. That one
  // used to be a local `tupleResourceKey`; since mcp-approval 0.8.2 the
  // library carries it, and these pin down that it still tells a swap apart.
  it('is the same key for a swapped pair under the set helper', () => {
    expect(setResourceKey('approve_pipeline', ['5', '12'])).toBe(
      setResourceKey('approve_pipeline', ['12', '5'])
    );
  });

  it('is a different key for a swapped pair under the ordered helper', () => {
    expect(orderedResourceKey('approve_pipeline', ['5', '12'])).not.toBe(
      orderedResourceKey('approve_pipeline', ['12', '5'])
    );
  });

  it('is a different key when a labelled pair is swapped, labels and all', () => {
    // `guard.ts` labels each target with its role. The labels alone would
    // already tell `repo:5` from `repo:12`; the ordered key does so without
    // leaning on them.
    expect(
      orderedResourceKey('approve_pipeline', ['repo:5', 'pipeline:12'])
    ).not.toBe(
      orderedResourceKey('approve_pipeline', ['repo:12', 'pipeline:5'])
    );
  });

  it.each([
    ['delete_step_logs', ['5', '12', '7'], ['7', '5', '12']],
    ['delete_agent', ['3', '5'], ['5', '3']],
    ['delete_user', ['alice', '1'], ['1', 'alice']],
  ])('keeps the order of %s apart', (tool, one, other) => {
    expect(orderedResourceKey(tool, one)).not.toBe(
      orderedResourceKey(tool, other)
    );
  });

  it('is still a different key for a different tool with the same targets', () => {
    expect(orderedResourceKey('delete_pipeline', ['5'])).not.toBe(
      orderedResourceKey('delete_repository', ['5'])
    );
  });
});

describe('the argument fingerprint', () => {
  // The targets say what is touched; this says with what. Without it a token
  // issued for "grant trusted_network" is honoured by a second call that also
  // carries visibility: "public".
  it('changes when any value changes', () => {
    expect(fingerprint({ trusted: { network: true } })).not.toBe(
      fingerprint({ trusted: { network: true }, visibility: 'public' })
    );
  });

  it('does not change when only the key order does', () => {
    // A JSON object has no order, so re-sending the same body written
    // differently must not read as a different request.
    expect(fingerprint({ a: 1, b: [2, 3] })).toBe(
      fingerprint({ b: [2, 3], a: 1 })
    );
  });

  it('keeps array order, which does mean something', () => {
    expect(fingerprint({ events: ['push', 'tag'] })).not.toBe(
      fingerprint({ events: ['tag', 'push'] })
    );
  });
});

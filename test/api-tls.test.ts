import { afterEach, describe, expect, it, vi } from 'vitest';

import { WoodpeckerApi } from '../src/api.js';
import { API, testConfig } from './harness.js';

/**
 * The insecure-TLS branch lives in its own file because it needs its own module
 * mock.
 *
 * `WOODPECKER_INSECURE_TLS=true` switches the request onto undici's `fetch`
 * instead of the global one, which makes the branch invisible to every test that
 * stubs `globalThis.fetch` — which is all of them. It shipped untested for that
 * reason. `Agent` stays real: the point of the test is that the relaxation is
 * carried by a per-request dispatcher rather than a process-wide switch, and a
 * faked Agent would prove nothing about that.
 */
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: vi.fn() };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WOODPECKER_INSECURE_TLS', () => {
  it('relaxes certificate checks through a scoped dispatcher, not globally', async () => {
    const undici = await import('undici');
    const undiciFetch = vi.mocked(undici.fetch);
    undiciFetch.mockResolvedValue(
      new Response('{}', {
        headers: { 'content-type': 'application/json' },
      }) as unknown as Awaited<ReturnType<typeof undici.fetch>>
    );

    await new WoodpeckerApi(testConfig({ insecureTls: true })).get('/repos/1');

    expect(undiciFetch).toHaveBeenCalledTimes(1);
    const [url, init] = undiciFetch.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(url).toBe(`${API}/repos/1`);
    expect(init.dispatcher).toBeInstanceOf(undici.Agent);
    // Global TLS validation is never the mechanism, whatever the option says.
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
  });

  it('keeps the protections the default path has', async () => {
    const undici = await import('undici');
    const undiciFetch = vi.mocked(undici.fetch);
    undiciFetch.mockResolvedValue(
      new Response('{}', {
        headers: { 'content-type': 'application/json' },
      }) as unknown as Awaited<ReturnType<typeof undici.fetch>>
    );

    await new WoodpeckerApi(testConfig({ insecureTls: true })).get('/repos/1');

    const [, init] = undiciFetch.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    // A relaxed certificate must not also mean a followed redirect: that is how
    // the Authorization header reaches a host nobody configured.
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeDefined();
    expect((init.headers as Record<string, string>).Authorization).toMatch(
      /^Bearer /
    );
  });

  it('uses the global fetch when the option is off', async () => {
    const undici = await import('undici');
    const undiciFetch = vi.mocked(undici.fetch);
    undiciFetch.mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{}', {
            headers: { 'content-type': 'application/json' },
          })
      )
    );

    await new WoodpeckerApi(testConfig()).get('/repos/1');

    expect(undiciFetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

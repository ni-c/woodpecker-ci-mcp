import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertPathSegment,
  pathSegment,
  query,
  ResponseTooLargeError,
  UnexpectedContentTypeError,
  WoodpeckerApi,
  WoodpeckerApiError,
} from '../src/api.js';
import { API, SERVER, stubFetch, testConfig, TOKEN } from './harness.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the API client', () => {
  it('sends the token as a bearer header under the /api prefix', async () => {
    const stub = stubFetch({ 'GET /repos/1': { json: { id: 1 } } });
    await new WoodpeckerApi(testConfig()).get('/repos/1');
    expect(stub.calls[0]?.url).toBe(`${API}/repos/1`);
    expect(stub.calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('addresses the server root for /version, which is NOT under /api', async () => {
    // The Swagger document lists /version under basePath "/api", but the server
    // registers it one level up — /api/version returns the web UI with HTTP 200.
    const stub = stubFetch({
      'GET !/version': { json: { version: '3.18.0' } },
    });
    await new WoodpeckerApi(testConfig()).get('/version', {
      root: true,
      anonymous: true,
    });
    expect(stub.calls[0]?.url).toBe(`${SERVER}/version`);
  });

  it('sends no token on an anonymous call', async () => {
    const stub = stubFetch({ 'GET !/version': { json: {} } });
    await new WoodpeckerApi(testConfig()).get('/version', {
      root: true,
      anonymous: true,
    });
    expect(stub.calls[0]?.headers.authorization).toBeUndefined();
  });

  it('works without a token for anonymous calls even when none is configured', async () => {
    stubFetch({ 'GET !/version': { json: { version: '3.18.0' } } });
    const api = new WoodpeckerApi(testConfig({ token: undefined }));
    await expect(
      api.get('/version', { root: true, anonymous: true })
    ).resolves.toEqual({ version: '3.18.0' });
  });

  it('refuses an authenticated call when the token is missing', async () => {
    stubFetch({});
    const api = new WoodpeckerApi(testConfig({ token: undefined }));
    await expect(api.get('/repos/1')).rejects.toThrow('WOODPECKER_TOKEN');
  });

  it('never follows a redirect, which would resend the token elsewhere', async () => {
    const stub = stubFetch({ 'GET /repos/1': { json: {} } });
    await new WoodpeckerApi(testConfig()).get('/repos/1');
    const init = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(init?.redirect).toBe('error');
    expect(stub.calls).toHaveLength(1);
  });

  it('rejects an HTML answer instead of parsing it as an empty result', async () => {
    // The single most likely misconfiguration: a URL that reaches the web UI
    // rather than the API answers 200 with the single-page app.
    stubFetch({
      'GET /repos': {
        text: '<!doctype html><html></html>',
        contentType: 'text/html',
      },
    });
    const api = new WoodpeckerApi(testConfig());
    await expect(api.get('/repos')).rejects.toBeInstanceOf(
      UnexpectedContentTypeError
    );
    await expect(api.get('/repos')).rejects.toThrow(/web UI/);
  });

  it('rejects a JSON content type whose body will not parse', async () => {
    stubFetch({
      'GET /repos': { text: 'not json', contentType: 'application/json' },
    });
    await expect(new WoodpeckerApi(testConfig()).get('/repos')).rejects.toThrow(
      /unparseable/
    );
  });

  it('treats 204 as success with no body', async () => {
    stubFetch({ 'DELETE /repos/1': { status: 204 } });
    await expect(
      new WoodpeckerApi(testConfig()).delete('/repos/1')
    ).resolves.toBe(undefined);
  });

  it('turns a failure into an error carrying the plain-text body', async () => {
    // Woodpecker answers 401 with the string "User not authorized", not JSON.
    stubFetch({ 'GET /repos/1': { status: 401, text: 'User not authorized' } });
    const error = await new WoodpeckerApi(testConfig())
      .get('/repos/1')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WoodpeckerApiError);
    expect((error as WoodpeckerApiError).status).toBe(401);
    expect((error as WoodpeckerApiError).body).toBe('User not authorized');
  });

  it('refuses a response that declares more bytes than the ceiling', async () => {
    stubFetch({
      'GET /repos': {
        json: {},
        headers: { 'content-length': String(64 * 1024 * 1024) },
      },
    });
    await expect(
      new WoodpeckerApi(testConfig()).get('/repos')
    ).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  // The other half of the cap, and the half that matters for logs: a chunked
  // response declares no content-length at all, so the pre-check above never
  // fires and only the streaming byte count stands between an oversized body
  // and the process memory.
  it('refuses a chunked response that outgrows the ceiling while streaming', async () => {
    const chunk = new Uint8Array(1024);
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (let i = 0; i < 16; i++) controller.enqueue(chunk);
              controller.close();
            },
          }),
          { headers: { 'content-type': 'application/json' } }
        )
    );
    await expect(
      new WoodpeckerApi(testConfig()).get('/repos', { maxBytes: 4096 })
    ).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it('sends a JSON body with a content type on writes', async () => {
    const stub = stubFetch({ 'POST /repos/1/cron': { json: {} } });
    await new WoodpeckerApi(testConfig()).post('/repos/1/cron', {
      name: 'nightly',
    });
    expect(stub.calls[0]?.headers['content-type']).toBe('application/json');
    expect(stub.calls[0]?.body).toEqual({ name: 'nightly' });
  });
});

describe('assertPathSegment', () => {
  it('accepts a registry address with a port', () => {
    expect(assertPathSegment('registry.example.com:5000', 'address')).toBe(
      'registry.example.com:5000'
    );
  });

  it('accepts an owner/name pair', () => {
    expect(assertPathSegment('acme/widgets', 'name')).toBe('acme/widgets');
  });

  it.each(['..', 'a/../b', '/leading', 'trailing/', '', 'a b', 'a?b'])(
    'refuses %o',
    (value) => {
      expect(() => assertPathSegment(value, 'name')).toThrow(/invalid name/);
    }
  );

  it('encodes the slash so the value stays one path segment', () => {
    expect(pathSegment('acme/widgets', 'name')).toBe('acme%2Fwidgets');
  });
});

describe('query', () => {
  it('omits undefined values entirely', () => {
    expect(query({ a: 1, b: undefined })).toBe('?a=1');
  });

  it('is empty when nothing is set', () => {
    expect(query({ a: undefined })).toBe('');
  });

  it('repeats a key for an array', () => {
    expect(query({ e: ['push', 'tag'] })).toBe('?e=push&e=tag');
  });

  it('keeps booleans, which the "all" and "active" filters need', () => {
    expect(query({ all: true })).toBe('?all=true');
  });
});

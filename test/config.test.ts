import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loadConfig,
  missingConfigKeys,
  missingConfigMessage,
  normalizeServerRoot,
} from '../src/config.js';

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    WOODPECKER_URL: 'https://woodpecker.example.com',
    WOODPECKER_TOKEN: 'a-token',
    ...overrides,
  } as NodeJS.ProcessEnv;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadConfig', () => {
  it('reads a complete configuration', () => {
    const config = loadConfig(env());
    expect(config.url).toBe('https://woodpecker.example.com');
    expect(config.token).toBe('a-token');
    expect(config.readOnly).toBe(false);
    expect(config.insecureTls).toBe(false);
  });

  it('removes the token from the environment it was read from', () => {
    // /proc/<pid>/environ and every child process can read it otherwise.
    const source = env();
    loadConfig(source);
    expect(source.WOODPECKER_TOKEN).toBeUndefined();
  });

  it('starts without credentials so tools stay listable', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const config = loadConfig({} as NodeJS.ProcessEnv);
    expect(config.url).toBeUndefined();
    expect(config.token).toBeUndefined();
    expect(missingConfigKeys(config)).toEqual([
      'WOODPECKER_URL',
      'WOODPECKER_TOKEN',
    ]);
    expect(warn).toHaveBeenCalled();
  });

  it('reads the boolean switches', () => {
    const config = loadConfig(
      env({ WOODPECKER_READ_ONLY: 'true', WOODPECKER_INSECURE_TLS: 'true' })
    );
    expect(config.readOnly).toBe(true);
    expect(config.insecureTls).toBe(true);
  });

  it('treats anything other than "true" as false', () => {
    const config = loadConfig(env({ WOODPECKER_READ_ONLY: '1' }));
    expect(config.readOnly).toBe(false);
  });

  it('warns about plain http to a remote host', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    loadConfig(env({ WOODPECKER_URL: 'http://woodpecker.example.com' }));
    expect(warn.mock.calls.flat().join(' ')).toContain('unencrypted');
  });

  it('does not warn about plain http to localhost', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    loadConfig(env({ WOODPECKER_URL: 'http://localhost:8000' }));
    expect(warn.mock.calls.flat().join(' ')).not.toContain('unencrypted');
  });

  it('treats an IPv4-mapped loopback literal as local', () => {
    // URL canonicalises this to [::ffff:7f00:1]; a string comparison misses it.
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    loadConfig(env({ WOODPECKER_URL: 'http://[::ffff:127.0.0.1]:8000' }));
    expect(warn.mock.calls.flat().join(' ')).not.toContain('unencrypted');
  });

  it('never echoes a rejected URL, which may be a mispasted token', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    expect(() =>
      loadConfig(env({ WOODPECKER_URL: 'eyJhbGciOiJIUzI1NiJ9.secret.value' }))
    ).toThrow();
    expect(exit).toHaveBeenCalledWith(1);
    expect(error.mock.calls.flat().join(' ')).not.toContain('secret');
  });

  it('refuses a non-http scheme', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    expect(() =>
      loadConfig(env({ WOODPECKER_URL: 'file:///etc/passwd' }))
    ).toThrow();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('refuses credentials embedded in the URL', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    expect(() =>
      loadConfig(
        env({ WOODPECKER_URL: 'https://user:pass@woodpecker.example.com' })
      )
    ).toThrow();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('drops a query string instead of gluing it in front of /api', () => {
    const config = loadConfig(
      env({ WOODPECKER_URL: 'https://woodpecker.example.com/?tab=repos' })
    );
    expect(config.url).toBe('https://woodpecker.example.com');
  });
});

describe('normalizeServerRoot', () => {
  it('trims trailing slashes', () => {
    expect(normalizeServerRoot('https://ci.example.com///')).toBe(
      'https://ci.example.com'
    );
  });

  it('trims an /api suffix people copy from the Swagger page', () => {
    expect(normalizeServerRoot('https://ci.example.com/api')).toBe(
      'https://ci.example.com'
    );
  });

  it('keeps a path that is not the API prefix', () => {
    expect(normalizeServerRoot('https://example.com/woodpecker')).toBe(
      'https://example.com/woodpecker'
    );
  });
});

describe('missingConfigMessage', () => {
  it('names both variables and the optional ones', () => {
    const message = missingConfigMessage(['WOODPECKER_URL']);
    expect(message).toContain('WOODPECKER_URL');
    expect(message).toContain('WOODPECKER_TOKEN');
    expect(message).toContain('WOODPECKER_ALLOW_TOOLS');
  });
});

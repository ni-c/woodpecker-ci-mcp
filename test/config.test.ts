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

describe('ELICITATION', () => {
  it('defaults to on, and to on for an empty value', () => {
    // The only variable of this family that defaults to *on*. An unset switch
    // has to mean "ask", or a deployment that never heard of it would quietly
    // stop asking.
    expect(loadConfig(env()).elicitation).toBe(true);
    expect(loadConfig(env({ ELICITATION: '' })).elicitation).toBe(true);
  });

  it('is switched off by "false", in any casing or padding', () => {
    for (const raw of ['false', 'FALSE', ' False ']) {
      expect(loadConfig(env({ ELICITATION: raw })).elicitation, raw).toBe(
        false
      );
    }
  });

  it('refuses to start on anything else, naming both valid values', () => {
    // Deliberately fatal rather than falling back to the default: a typo would
    // leave the dialog running while the operator believes it is off, and
    // nothing else would ever tell them.
    for (const raw of ['1', 'off', 'no']) {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('exit');
      }) as never);
      expect(() => loadConfig(env({ ELICITATION: raw }))).toThrow('exit');
      expect(exit).toHaveBeenCalledWith(1);
      const message = String(error.mock.calls[0]?.[0] ?? '');
      expect(message, raw).toContain('ELICITATION');
      expect(message, raw).toContain('"true"');
      expect(message, raw).toContain('"false"');
      vi.restoreAllMocks();
    }
  });

  it('has already wiped the credential by the time it can exit', () => {
    // parseElicitation sits *after* the delete on purpose. An exit above it
    // would leave the credential in the environment for whatever a crash
    // reporter or an inspector does next — which is exactly what that delete
    // exists to prevent, and its comment says so.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    const e = env({ ELICITATION: 'nonsense' });
    expect(() => loadConfig(e)).toThrow('exit');
    expect(e.WOODPECKER_TOKEN).toBeUndefined();
    vi.restoreAllMocks();
  });
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

  // A protection and a permission are parsed differently on purpose, so both
  // halves are asserted here: `WOODPECKER_READ_ONLY=1` — what a Compose file or
  // a systemd unit is most likely to say — used to leave every write tool
  // registered while the operator believed the server could not write.
  it.each(['1', 'yes', 'TRUE', ' true '])(
    'reads %o as read-only, because a protection must not fail silently open',
    (value) => {
      expect(loadConfig(env({ WOODPECKER_READ_ONLY: value })).readOnly).toBe(
        true
      );
    }
  );

  it('still refuses a value that grants nothing', () => {
    expect(loadConfig(env({ WOODPECKER_READ_ONLY: 'no' })).readOnly).toBe(
      false
    );
    expect(loadConfig(env({ WOODPECKER_READ_ONLY: '' })).readOnly).toBe(false);
  });

  it('keeps the TLS switch strict, because that one grants a permission', () => {
    // Mirror image of the above. Turning certificate verification off should
    // take the exact word that turns it off, never a near miss.
    expect(loadConfig(env({ WOODPECKER_INSECURE_TLS: '1' })).insecureTls).toBe(
      false
    );
    expect(
      loadConfig(env({ WOODPECKER_INSECURE_TLS: 'yes' })).insecureTls
    ).toBe(false);
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

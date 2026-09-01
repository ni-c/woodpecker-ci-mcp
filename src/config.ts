import { internalHostKind } from 'mcp-internal-hosts';

export interface Config {
  /**
   * Root URL of the Woodpecker server, e.g. `https://woodpecker.example.com`.
   * The `/api` prefix is added by the API client — a URL that already ends in
   * `/api` is accepted and trimmed back.
   *
   * May be undefined together with the token: the server still starts and lists
   * its tools, and every API call then fails with {@link missingConfigMessage}.
   */
  url: string | undefined;
  token: string | undefined;
  insecureTls: boolean;
  /** When true, only the read tools are registered at all. */
  readOnly: boolean;
  /**
   * Raw value of `WOODPECKER_ALLOW_TOOLS` — comma-separated tool names,
   * `list_*` prefixes, or `essential`. Kept unparsed on purpose: this file is a
   * mirror of the environment, and the names can only be checked against the
   * tool catalogue, which `buildToolFilter` does.
   */
  allowTools: string | undefined;
  /** Raw value of `WOODPECKER_DENY_TOOLS`, same shape, subtracted from the above. */
  denyTools: string | undefined;
}

/** Shown when the configuration is incomplete — at startup and on every API call. */
export function missingConfigMessage(missing: string[]): string {
  return (
    `missing required environment variable(s): ${missing.join(', ')}\n` +
    'Required: WOODPECKER_URL (the server root, e.g. https://woodpecker.example.com), ' +
    'WOODPECKER_TOKEN (a personal access token from your Woodpecker user settings)\n' +
    'Optional: WOODPECKER_READ_ONLY=true to expose only read tools, ' +
    'WOODPECKER_INSECURE_TLS=true to accept self-signed certificates, ' +
    'WOODPECKER_ALLOW_TOOLS / WOODPECKER_DENY_TOOLS to narrow the tool list ' +
    '(comma-separated names, "list_*" prefixes, or "essential")'
  );
}

/** Names of the required environment variables that are unset in `config`. */
export function missingConfigKeys(config: Config): string[] {
  return [
    !config.url && 'WOODPECKER_URL',
    !config.token && 'WOODPECKER_TOKEN',
  ].filter((value): value is string => Boolean(value));
}

/**
 * Reads the configuration from environment variables.
 *
 * Missing credentials are only a warning, not a fatal error: the server must be
 * able to complete the MCP handshake and answer `tools/list` without them, so
 * registries and sandbox inspectors can introspect it. A malformed URL still
 * exits — that one could send the token to the wrong host.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawUrl = env.WOODPECKER_URL;
  const token = env.WOODPECKER_TOKEN;
  const insecureTls = env.WOODPECKER_INSECURE_TLS === 'true';
  const readOnly = env.WOODPECKER_READ_ONLY === 'true';
  const allowTools = env.WOODPECKER_ALLOW_TOOLS;
  const denyTools = env.WOODPECKER_DENY_TOOLS;

  // Don't keep the token in the environment for the process lifetime — it is
  // visible to child processes and in /proc/<pid>/environ.
  delete env.WOODPECKER_TOKEN;

  const config: Config = {
    url: undefined,
    token,
    insecureTls,
    readOnly,
    allowTools,
    denyTools,
  };

  if (rawUrl) {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      // The value is not echoed: a token pasted into the wrong variable would
      // otherwise be printed into the client's log.
      fail('WOODPECKER_URL is not a valid URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      fail(
        `WOODPECKER_URL must use http:// or https:// (got ${parsed.protocol})`
      );
    }
    // Credentials embedded in the URL would end up in logs and error messages.
    if (parsed.username || parsed.password) {
      fail(
        'WOODPECKER_URL must not contain credentials — use WOODPECKER_TOKEN'
      );
    }
    if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
      console.error(
        'woodpecker-ci-mcp: WARNING: WOODPECKER_URL uses plain http to a non-local host — ' +
          'the access token will be sent unencrypted. Use https:// instead.'
      );
    }
    // From `parsed`, not `rawUrl`: normalizeServerRoot only trims slashes and an
    // API suffix, so a query or fragment would survive it and end up glued in
    // front of /api on every request.
    config.url = normalizeServerRoot(`${parsed.origin}${parsed.pathname}`);
  }

  const missing = missingConfigKeys(config);
  if (missing.length > 0) {
    console.error(`woodpecker-ci-mcp: ${missingConfigMessage(missing)}`);
  }

  return config;
}

/**
 * Trims a configured URL back to the server root.
 *
 * Woodpecker's own documentation, its CLI (`WOODPECKER_SERVER`) and its Swagger
 * page all name the root, but every example request in that page is a full
 * `https://…/api/repos/…` URL — so both spellings arrive here. Keeping only the
 * origin and any path *above* the API prefix means both work, instead of one of
 * them producing `/api/api/repos` and a bare 404.
 */
export function normalizeServerRoot(url: string): string {
  return url.replace(/\/+$/, '').replace(/\/api$/, '');
}

function isLoopbackHost(hostname: string): boolean {
  return internalHostKind(hostname) === 'loopback';
}

/**
 * Reports a fatal configuration problem and stops.
 *
 * The `throw` after `process.exit` is not dead code. `process.exit` is typed
 * `never` and behaves that way in production, but the tests stub it — and
 * without the throw, execution would fall through the guard that just failed
 * and carry on with the very value that was rejected. Making the abort explicit
 * means the checks above are testable and mean the same thing either way.
 */
function fail(message: string): never {
  console.error(`woodpecker-ci-mcp: ${message}`);
  process.exit(1);
  throw new Error(message);
}

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
   * Whether a client that *can* show a dialog is asked before a guarded tool
   * acts. `ELICITATION=false` turns the dialog off — the guard stays and falls
   * back to the two-call token, so there is no setting in which a guarded call
   * goes unannounced.
   */
  elicitation: boolean;

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
 * Reads `ELICITATION` — deliberately unprefixed, and deliberately fatal on
 * anything it does not recognise.
 *
 * Unprefixed: environment variables are process-wide, so this is one switch for
 * every server in the same environment. That is also its risk, which is why a
 * server started with it off says so on its startup line.
 *
 * Fatal: this is the first variable of the family that defaults to *on*. The
 * others fail open on a typo, which is the safe direction for them. Here a typo
 * would leave the dialog running while the operator believes it is off — and an
 * operator who believes that has no way to find out. It goes through `fail`
 * like every other refusal in this file, so there is one exit rather than two.
 */
export function parseElicitation(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === '' || value === 'true') return true;
  if (value === 'false') return false;
  return fail(
    `ELICITATION must be "true" or "false" — got "${raw}". ` +
      'Refusing to start rather than guess.'
  );
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
  // Strict on purpose, and the asymmetry with the line below is the point.
  // Turning certificate verification *off* is a permission, and a permission
  // should be granted only by the exact word that grants it — an operator who
  // wrote `=yes` here and meant it can write `=true`, and one who wrote it by
  // accident gets the safe behaviour.
  const insecureTls = env.WOODPECKER_INSECURE_TLS === 'true';
  // Tolerant on purpose, for the mirror-image reason. This one is a protection,
  // and `WOODPECKER_READ_ONLY=1` is what a Docker Compose file or a systemd unit
  // is most likely to say. Under an exact `=== 'true'` that spelling left every
  // write tool registered while the operator believed the server could not
  // write — a failure that announces itself only by something being deleted.
  // Matches the fleet: hetzner-dns-mcp reads its own read-only switch this way.
  const readOnly = /^(1|true|yes)$/i.test(
    env.WOODPECKER_READ_ONLY?.trim() ?? ''
  );
  const allowTools = env.WOODPECKER_ALLOW_TOOLS;
  const denyTools = env.WOODPECKER_DENY_TOOLS;

  // Don't keep the token in the environment for the process lifetime — it is
  // visible to child processes and in /proc/<pid>/environ.
  delete env.WOODPECKER_TOKEN;

  // After the delete, deliberately: this one can exit the process, and an exit
  // above would leave the token in the environment for whatever runs next.
  const elicitation = parseElicitation(env.ELICITATION);

  const config: Config = {
    url: undefined,
    token,
    insecureTls,
    readOnly,
    elicitation,
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

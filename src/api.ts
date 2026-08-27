import {
  Agent,
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
} from 'undici';

import {
  missingConfigKeys,
  missingConfigMessage,
  type Config,
} from './config.js';

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Ceiling on a single upstream response.
 *
 * Woodpecker paginates lists but not log entries: `GET /repos/{id}/logs/{n}/{s}`
 * returns every line of a step in one array, and a step that ran `set -x` over a
 * container build produces tens of megabytes. `await response.text()` would
 * buffer whatever arrives; this bounds it before the bytes are ever in memory as
 * a string.
 */
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export class WoodpeckerApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    method: string,
    /** Kept, because the 404 hint reads differently for a repository path. */
    public readonly path: string
  ) {
    super(`Woodpecker API ${method} ${path} failed with HTTP ${status}`);
    this.name = 'WoodpeckerApiError';
  }
}

/** Thrown when a response is larger than the ceiling that applied to it. */
export class ResponseTooLargeError extends Error {
  constructor(path: string, limit: number) {
    super(
      `the Woodpecker response for ${path} exceeds the ${formatLimit(limit)} ` +
        'ceiling and was not read.'
    );
    this.name = 'ResponseTooLargeError';
  }
}

function formatLimit(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${Math.round(bytes / 1024 / 1024)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

/**
 * Thrown when a response that has to be JSON is not.
 *
 * This is the single most likely misconfiguration of this server, and it does
 * not look like one. Woodpecker serves its web UI from the same origin as its
 * API and falls through to the single-page app for anything it does not route —
 * so a wrong path or a URL pointing at a reverse proxy answers **200 with HTML**
 * rather than 404. Handing that to `JSON.parse` produces a syntax error nobody
 * can act on, so it is named here instead.
 */
export class UnexpectedContentTypeError extends Error {
  constructor(path: string, contentType: string) {
    super(
      `Woodpecker answered ${path} with "${contentType || 'no content type'}" ` +
        'instead of JSON. Woodpecker serves its web UI from the same origin and ' +
        'falls back to it for unrouted paths, so an HTML answer with HTTP 200 ' +
        'usually means WOODPECKER_URL points at something other than the ' +
        'Woodpecker server, or at a proxy that intercepted the call. Check ' +
        'WOODPECKER_URL and try get_server_info.'
    );
    this.name = 'UnexpectedContentTypeError';
  }
}

export interface RequestOptions {
  /**
   * Address the server root instead of the `/api` prefix.
   *
   * Only `/version` and `/healthz` need it, and they need it badly: the Swagger
   * document lists both under `basePath: "/api"`, but the server registers them
   * one level up. `GET /api/version` therefore hits the SPA fallback and returns
   * the web UI with HTTP 200 — verified against Woodpecker 3.18.0.
   */
  root?: boolean;
  /** Send no `Authorization` header. Only `/version` and `/healthz`. */
  anonymous?: boolean;
  /** Overrides {@link MAX_RESPONSE_BYTES} for endpoints with a known small ceiling. */
  maxBytes?: number;
}

export interface RawResponse {
  body: string;
  status: number;
  contentType: string;
}

/** Client for the Woodpecker CI API. */
export class WoodpeckerApi {
  private readonly config: Config;
  /**
   * Only set when WOODPECKER_INSECURE_TLS is enabled. Scopes the relaxed
   * certificate validation to requests against the configured host instead of
   * disabling it process-wide via NODE_TLS_REJECT_UNAUTHORIZED.
   */
  private readonly insecureDispatcher?: Agent;

  constructor(config: Config) {
    this.config = config;
    if (config.insecureTls) {
      this.insecureDispatcher = new Agent({
        connect: { rejectUnauthorized: false },
      });
    }
  }

  /** The configured server root, for messages that need to name the instance. */
  get serverRoot(): string | undefined {
    return this.config.url;
  }

  async requestRaw(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {}
  ): Promise<RawResponse> {
    // The configuration is only required here, not at startup, so the server can
    // still be started and introspected without it.
    const missing = missingConfigKeys(this.config).filter(
      // `/version` needs no token, so an unconfigured token must not stop the
      // one call that tells the caller whether the URL is even right.
      (key) => !(options.anonymous && key === 'WOODPECKER_TOKEN')
    );
    if (missing.length > 0) throw new Error(missingConfigMessage(missing));

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (!options.anonymous && this.config.token) {
      headers.Authorization = `Bearer ${this.config.token}`;
    }

    const init: RequestInit = {
      method,
      headers,
      // Never follow a redirect: it would resend the access token to whatever
      // host the upstream points at.
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const url = `${this.config.url ?? ''}${options.root ? '' : '/api'}${path}`;
    // The insecure dispatcher requires undici's own fetch; the default path uses
    // the (stubbable) global fetch so tests can intercept it.
    const response = this.insecureDispatcher
      ? await undiciFetch(url, {
          ...init,
          dispatcher: this.insecureDispatcher,
        } as UndiciRequestInit)
      : await fetch(url, init);

    const limit = options.maxBytes ?? MAX_RESPONSE_BYTES;
    const text = await readCapped(
      response as unknown as Response,
      limit,
      path,
      options.root ? '' : '/api'
    );

    if (!response.ok) {
      throw new WoodpeckerApiError(response.status, text, method, path);
    }

    return {
      body: text,
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
    };
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {}
  ): Promise<unknown> {
    const raw = await this.requestRaw(method, path, body, options);
    // Woodpecker answers DELETE and the queue controls with 204 and no body, and
    // `/healthz` does the same. There is nothing to parse and nothing wrong.
    if (raw.status === 204 || raw.body.length === 0) return undefined;
    // Anything that is not JSON here is the web UI, not an API answer — see
    // UnexpectedContentTypeError. Returning the body would send an HTML document
    // into a list helper, which finds no array and reports an empty result: an
    // error swallowed and replaced with a plausible wrong answer.
    if (!raw.contentType.includes('application/json')) {
      throw new UnexpectedContentTypeError(path, raw.contentType);
    }
    try {
      return JSON.parse(raw.body) as unknown;
    } catch {
      throw new UnexpectedContentTypeError(
        path,
        `${raw.contentType} (unparseable)`
      );
    }
  }

  get(path: string, options?: RequestOptions): Promise<unknown> {
    return this.request('GET', path, undefined, options);
  }

  post(path: string, body?: unknown): Promise<unknown> {
    return this.request('POST', path, body);
  }

  patch(path: string, body?: unknown): Promise<unknown> {
    return this.request('PATCH', path, body);
  }

  delete(path: string): Promise<unknown> {
    return this.request('DELETE', path);
  }
}

/**
 * Reads a response body with a hard byte ceiling.
 *
 * Both halves matter: `content-length` catches an oversized answer before a
 * single byte is read, and the streaming count catches a chunked response,
 * which declares no length at all. Log endpoints are chunked.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
  path: string,
  prefix: string
): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    // Nothing has been read yet, so the body can simply be discarded.
    await response.body?.cancel();
    throw new ResponseTooLargeError(`${prefix}${path}`, maxBytes);
  }

  const body = response.body;
  if (!body) return '';

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    if (total + value.byteLength > maxBytes) {
      await reader.cancel();
      throw new ResponseTooLargeError(`${prefix}${path}`, maxBytes);
    }
    chunks.push(value);
    total += value.byteLength;
  }

  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Guards a value that ends up in a URL path. Path traversal here would let a
 * caller reach a different resource — or a different API entirely.
 *
 * Defence in depth: every caller already validated the value against a schema,
 * and this catches the one that some day will not. Secret and registry names
 * are the interesting case, because they are free-form strings chosen by users
 * rather than numeric ids.
 */
export function assertPathSegment(value: string, what: string): string {
  if (
    !/^[A-Za-z0-9._:@/-]+$/.test(value) ||
    value === '.' ||
    value === '..' ||
    value.includes('..') ||
    value.startsWith('/') ||
    value.endsWith('/')
  ) {
    throw new Error(
      `invalid ${what}: it must not be empty, contain "..", start or end with a ` +
        'slash, or hold characters other than letters, digits and . _ - : @ /'
    );
  }
  return value;
}

/**
 * Encodes a value for use as a single path segment.
 *
 * Registry addresses are the reason: they are identified by their host, so a
 * path segment like `registry.example.com:5000` is normal, and a repository is
 * looked up by `owner/name`. Both have to survive as one segment.
 */
export function pathSegment(value: string, what: string): string {
  return encodeURIComponent(assertPathSegment(value, what));
}

/** Builds a query string from the parameters that are actually set. */
export function query(
  params: Record<
    string,
    string | number | boolean | undefined | (string | number)[]
  >
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const entry of Array.isArray(value) ? value : [value]) {
      search.append(key, String(entry));
    }
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}

import { assertLoopback, waitForHttp } from 'mcp-integration-harness';

/**
 * Brings the throwaway Woodpecker from empty to a personal access token.
 *
 * The longest bootstrap in this family, and the reason is structural:
 * **Woodpecker has no accounts of its own.** Signing in means completing an
 * OAuth flow against the forge, which is a browser journey, so this does what
 * a browser would — six steps, each with something worth knowing:
 *
 *  1. Sign in to Gitea. Two form fields, and nothing else: 1.26 dropped the
 *     CSRF token this step used to carry.
 *  2. Ask Woodpecker for `/authorize`. It answers a redirect to the forge.
 *  3. **Rewrite the host in that redirect.** Woodpecker knows the forge as
 *     `gitea:3000`, which is how it reaches it from inside the compose
 *     network; nothing outside can resolve that. A browser on the docker host
 *     would have the same problem — the forge simply has two addresses — so
 *     the script translates.
 *  4. Grant consent. Another form: the three fields Gitea checks against the
 *     session, plus `granted=true`.
 *  5. Follow the code back to Woodpecker, which sets a session cookie.
 *  6. Exchange the session for a personal access token — and this needs a
 *     **CSRF header** whose value is not in any cookie. Woodpecker injects it
 *     into `/web-config.js` as `window.WOODPECKER_CSRF`, which is where the
 *     web interface reads it from. Without it the answer is a bare 401 that
 *     looks like the session having failed.
 */

export const USERNAME = 'integration';
export const PASSWORD = 'integration-not-a-secret';

/** The forge, as this machine reaches it. */
const GITEA = 'http://127.0.0.1:3200';
/** The forge, as Woodpecker reaches it. */
const GITEA_INTERNAL = 'http://gitea:3000';

export interface Sandbox {
  url: string;
  gitea: string;
  token: string;
  env: Record<string, string>;
}

/** Keeps cookies per host: the flow crosses two servers. */
class Jar {
  private readonly jars = new Map<string, Map<string, string>>();

  private of(origin: string): Map<string, string> {
    const existing = this.jars.get(origin);
    if (existing) return existing;
    const fresh = new Map<string, string>();
    this.jars.set(origin, fresh);
    return fresh;
  }

  remember(origin: string, response: Response): void {
    const jar = this.of(origin);
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';')[0] ?? '';
      const eq = pair.indexOf('=');
      // Merged rather than replaced: Set-Cookie carries only what changed.
      if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
  }

  header(origin: string): string {
    return [...this.of(origin)]
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }
}

const jar = new Jar();

function originOf(url: string): string {
  return new URL(url).origin;
}

async function get(url: string): Promise<Response> {
  const response = await fetch(url, {
    headers: { cookie: jar.header(originOf(url)) },
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  jar.remember(originOf(url), response);
  return response;
}

async function postForm(
  url: string,
  form: Record<string, string>
): Promise<Response> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: jar.header(originOf(url)),
      // What a browser sends when it submits one of these forms: the page and
      // the target are the same origin. Since 1.26 Gitea guards its web POSTs
      // with Go's net/http CrossOriginProtection, which reads this header
      // first and only falls back to comparing `Origin` against `Host` when it
      // is absent — and an `Origin` the runtime adds on its own would be a 403
      // nobody wrote. `/login/oauth/grant` is behind that guard.
      'sec-fetch-site': 'same-origin',
    },
    body: new URLSearchParams(form),
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  jar.remember(originOf(url), response);
  return response;
}

/** Reads one hidden input out of a rendered form. */
function hiddenField(html: string, field: string): string {
  const match = new RegExp(`name="${field}"[^>]*value="([^"]+)"`).exec(html);
  if (match?.[1] === undefined) {
    throw new Error(
      `no ${field} in the page — it is usually a redirect rather than a form. ` +
        `Got: ${html.slice(0, 200)}`
    );
  }
  return match[1];
}

export async function bootstrap(
  url = 'http://127.0.0.1:8010'
): Promise<Sandbox> {
  assertLoopback(url);
  assertLoopback(GITEA);
  await waitForHttp(`${GITEA}/api/v1/version`, {
    timeoutSeconds: 300,
    ready: (response) => response.ok,
  });
  await waitForHttp(url, { timeoutSeconds: 300, ready: (r) => r.ok });

  // 1. Sign in to the forge. Nothing is read out of the page, but it is still
  //    fetched: it is what puts Gitea's session cookie in the jar, and the
  //    POST below is answered on that session.
  await get(`${GITEA}/user/login`);
  const signedIn = await postForm(`${GITEA}/user/login`, {
    // No _csrf: Gitea dropped the token in 1.26 in favour of net/http
    // CrossOriginProtection, and this route is exempt from that check anyway
    // (it is registered in the reqSignOut group, which the guard skips).
    user_name: USERNAME,
    password: PASSWORD,
  });
  if (signedIn.status !== 303 && signedIn.status !== 302) {
    throw new Error(
      `Gitea refused the login: HTTP ${signedIn.status}. The account is ` +
        'created by the container command in compose.yml — `docker compose ' +
        'logs gitea` shows whether it ran.'
    );
  }

  // 2. Start the OAuth flow at Woodpecker.
  const start = await get(`${url}/authorize`);
  const forgeUrl = start.headers.get('location');
  if (forgeUrl === null) {
    throw new Error(
      `Woodpecker did not redirect to the forge (HTTP ${start.status}). ` +
        'Usually the OAuth application is missing — `docker compose logs ' +
        'oauth` shows whether the init container created it.'
    );
  }

  // 3. The forge has two addresses. Use the one this machine can reach.
  const authorizeUrl = forgeUrl.replace(GITEA_INTERNAL, GITEA);
  const authorize = await get(authorizeUrl);

  // 4. Grant — **if asked**. Gitea shows the consent form once per
  //    application and skips it afterwards, redirecting straight back with a
  //    code. Both paths are normal: the first run of a fresh stack sees the
  //    form, a re-run against a stack that was left up does not.
  let callback = authorize.headers.get('location');
  if (callback === null) {
    const consent = await authorize.text();
    // These three are echoed back rather than composed: Gitea compares each
    // against what the `/authorize` above put in the session and answers 400
    // on any difference.
    const granted = await postForm(`${GITEA}/login/oauth/grant`, {
      client_id: hiddenField(consent, 'client_id'),
      state: hiddenField(consent, 'state'),
      scope: '',
      nonce: '',
      redirect_uri: hiddenField(consent, 'redirect_uri'),
      granted: 'true',
    });
    callback = granted.headers.get('location');
    if (callback === null) {
      throw new Error(
        `Gitea did not redirect back after the grant (HTTP ${granted.status})`
      );
    }
  }

  // 5. Back to Woodpecker, which sets its session cookie.
  const session = await get(callback);
  if (session.status >= 400) {
    throw new Error(`Woodpecker refused the callback: HTTP ${session.status}`);
  }

  // 6. Exchange the session for a token. The CSRF value is in the page config,
  //    not in a cookie.
  const config = await (await get(`${url}/web-config.js`)).text();
  const csrfToken = /WOODPECKER_CSRF = "([^"]+)"/.exec(config)?.[1];
  if (csrfToken === undefined) {
    throw new Error(
      'Woodpecker served no CSRF token in /web-config.js, which means the ' +
        'session did not take. The OAuth flow above reported success, so the ' +
        'likeliest cause is a cookie that was not carried across the two hosts.'
    );
  }

  const minted = await fetch(`${url}/api/user/token`, {
    method: 'POST',
    headers: {
      cookie: jar.header(originOf(url)),
      'x-csrf-token': csrfToken,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!minted.ok) {
    throw new Error(
      `Woodpecker refused to mint a token: HTTP ${minted.status}. Without the ` +
        'X-CSRF-TOKEN header this is a bare 401 that looks like the session ' +
        'having failed.'
    );
  }
  const token = (await minted.text()).trim();

  return {
    url,
    gitea: GITEA,
    token,
    env: {
      WOODPECKER_URL: url,
      WOODPECKER_TOKEN: token,
      // Defaults to true in this server; the suite exists to drive the writes.
      WOODPECKER_READ_ONLY: 'false',
    },
  };
}

const auth = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}`;

/** One call against the forge's own API, with the failure body kept. */
async function forge(
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  const response = await fetch(`${GITEA}${path}`, {
    method,
    headers: { authorization: auth, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 200);
    if (response.status === 409) {
      throw new Error(
        `${method} ${path} answered 409: something of this run is still in the ` +
          'forge from a previous one. The suite needs a fresh stack — ' +
          '`docker compose -f test/integration/compose.yml down -v` and up again.'
      );
    }
    throw new Error(
      `${method} ${path} failed: HTTP ${response.status} — ${text}`
    );
  }
  return response;
}

/**
 * Creates a repository in the forge, with a pipeline definition in it.
 *
 * Woodpecker only knows repositories the forge has, so there is nothing to
 * activate until this has run. `owner` is for the organization case: an
 * organization repository is created on a different route, not by naming the
 * owner in the body.
 */
export async function createRepository(
  name: string,
  pipeline: string,
  owner = USERNAME
): Promise<{ fullName: string }> {
  await forge(
    'POST',
    owner === USERNAME ? '/api/v1/user/repos' : `/api/v1/orgs/${owner}/repos`,
    { name, auto_init: true, private: false }
  );

  await forge(
    'POST',
    `/api/v1/repos/${owner}/${name}/contents/.woodpecker.yaml`,
    {
      content: Buffer.from(pipeline).toString('base64'),
      message: 'Add a pipeline',
    }
  );

  return { fullName: `${owner}/${name}` };
}

/**
 * Creates an organization in the forge.
 *
 * Woodpecker has no way to create one: an organization is a forge concept and
 * Woodpecker records it the first time it sees a repository that belongs to
 * one. So this is what `delete_organization` needs to have something to delete
 * that is not the personal account every repository of this suite hangs off.
 */
export async function createOrganization(name: string): Promise<void> {
  await forge('POST', '/api/v1/orgs', { username: name, visibility: 'public' });
}

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  listOf,
  objectOf,
  redactAgent,
  redactSecret,
  redactSensitive,
  REDACTED,
} from '../src/normalize.js';

/**
 * Properties of the normalising layer.
 *
 * `redactSensitive` is the control that the tool descriptions' promise rests
 * on. The file says it plainly: on a healthy instance `model.Secret.Copy()`
 * strips a value before serialising, and confidentiality that depends entirely
 * on the other side's Go model is a claim rather than a control. What is stated
 * here is what the control actually does — for every shape a response can take,
 * not the handful an example names.
 */

const RUNS = { numRuns: 500 };

const SENSITIVE_KEYS = [
  'token',
  'access_token',
  'refresh_token',
  'client_secret',
  'clientsecret',
  'password',
  'private_key',
  'privatekey',
  'secret_key',
  'session_secret',
  'api_key',
  'apikey',
  'totp_secret',
];

const CANARY = 'CREDENTIAL-THAT-MUST-NOT-ESCAPE';

describe('credential-shaped fields never reach the model', () => {
  /**
   * A sensitive key is replaced wherever it sits, however deep the response
   * nests it.
   */
  it('a sensitive string is redacted at any depth', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SENSITIVE_KEYS),
        fc.integer({ min: 0, max: 6 }),
        (key, depth) => {
          let value: unknown = { [key]: CANARY };
          for (let index = 0; index < depth; index++) {
            value = index % 2 === 0 ? [value] : { nested: value };
          }
          expect(JSON.stringify(redactSensitive(value))).not.toContain(CANARY);
        }
      ),
      RUNS
    );
  });

  it('the match does not depend on how the key is cased', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SENSITIVE_KEYS),
        fc.boolean(),
        (key, upper) => {
          const spelled = upper ? key.toUpperCase() : key;
          const redacted = redactSensitive({ [spelled]: CANARY });
          expect(redacted[spelled]).toBe(REDACTED);
        }
      ),
      RUNS
    );
  });

  /**
   * Replaced, never dropped.
   *
   * An absent field reads as "there is no such credential", which sends the
   * reader looking for a bug that is not there. The shape of the response is
   * part of what it says.
   */
  it('the key survives even though the value does not', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SENSITIVE_KEYS),
        fc.string(),
        (key, value) => {
          const redacted = redactSensitive({ [key]: value, id: 7 });
          expect(key in redacted).toBe(true);
          expect(redacted.id).toBe(7);
        }
      ),
      RUNS
    );
  });

  /**
   * A marker is not re-wrapped.
   *
   * `redactAgent` and `redactSecret` write their own sentences, and running the
   * generic pass over their output must leave those readable rather than
   * nesting one redaction notice inside another.
   */
  it('is idempotent, and does not re-redact its own markers', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.constantFrom(...SENSITIVE_KEYS, 'id', 'name', 'branch'),
          fc.oneof(fc.string(), fc.integer(), fc.boolean()),
          { maxKeys: 6 }
        ),
        (body) => {
          const once = redactSensitive(body);
          expect(redactSensitive(once)).toEqual(once);
        }
      ),
      RUNS
    );
  });

  /**
   * Only strings are replaced, and that is deliberate rather than an oversight.
   *
   * Woodpecker types all of these as strings in its Go models, so a non-string
   * under one of these keys is not a credential this server can recognise —
   * and replacing an object wholesale would take its structure with it. What
   * the property pins is that recursion still descends into it, so a credential
   * *inside* such an object is still caught by its own key.
   */
  it('descends into a non-string held under a sensitive key', () => {
    fc.assert(
      fc.property(fc.constantFrom(...SENSITIVE_KEYS), (key) => {
        const redacted = redactSensitive({ [key]: { token: CANARY, id: 1 } });
        expect(JSON.stringify(redacted)).not.toContain(CANARY);
      }),
      RUNS
    );
  });
});

describe('the two shaped redactions replace rather than drop', () => {
  it('an agent keeps every other field and loses its token', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.constantFrom('id', 'name', 'platform', 'capacity'),
          fc.jsonValue(),
          {
            maxKeys: 4,
          }
        ),
        fc.string({ minLength: 1 }),
        (agent, token) => {
          const redacted = redactAgent({ ...agent, token });
          expect(redacted.token).not.toBe(token);
          for (const [key, value] of Object.entries(agent)) {
            if (key !== 'token') expect(redacted[key]).toEqual(value);
          }
        }
      ),
      RUNS
    );
  });

  it('an agent without a token is handed back untouched', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.constantFrom('id', 'name', 'platform'),
          fc.jsonValue(),
          { maxKeys: 3 }
        ),
        (agent) => {
          fc.pre(!('token' in agent));
          expect(redactAgent(agent)).toEqual(agent);
        }
      ),
      RUNS
    );
  });

  /**
   * A secret's value never comes back, whatever the instance chose to put in
   * it — which is the point, since the promise used to rest on the far side's
   * `Copy()` doing the stripping.
   */
  it("a secret's value is always replaced when present", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.dictionary(fc.constantFrom('id', 'name', 'events'), fc.jsonValue(), {
          maxKeys: 3,
        }),
        (value, rest) => {
          const redacted = redactSecret({ ...rest, value });
          expect(redacted.value).toBe(REDACTED);
          expect(redacted.value).not.toBe(value);
        }
      ),
      RUNS
    );
  });
});

describe('response readers refuse rather than guess', () => {
  /**
   * Totality with a named failure. A malformed response is an error the caller
   * can read, not a `TypeError` from three frames further in — and never a
   * silently empty list, which would read as "the instance has none".
   */
  it('listOf returns an array or throws, and never invents entries', () => {
    fc.assert(
      fc.property(fc.anything(), (body) => {
        try {
          const list = listOf(body, 'things');
          expect(Array.isArray(list)).toBe(true);
          if (body === undefined || body === null) expect(list).toHaveLength(0);
          else expect(list).toEqual(body);
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toContain('things');
        }
      }),
      RUNS
    );
  });

  it('objectOf returns an object or throws, and never accepts an array', () => {
    fc.assert(
      fc.property(fc.anything(), (body) => {
        try {
          const object = objectOf(body, 'thing');
          expect(typeof object).toBe('object');
          expect(Array.isArray(object)).toBe(false);
          expect(object).not.toBeNull();
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toContain('thing');
        }
      }),
      RUNS
    );
  });
});

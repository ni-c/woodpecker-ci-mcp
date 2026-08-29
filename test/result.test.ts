import { describe, expect, it } from 'vitest';

import { WoodpeckerApiError } from '../src/api.js';
import { REDACTED } from '../src/normalize.js';
import {
  budgetedJson,
  budgetedList,
  MAX_RESULT_BYTES,
  run,
  sanitizeErrorBody,
  statusHint,
  textResult,
  untrustedResult,
} from '../src/result.js';

function textOf(result: {
  content: { type: string; text?: string }[];
}): string {
  return result.content.map((block) => block.text ?? '').join('\n');
}

describe('budgetedList', () => {
  it('returns everything when it fits', () => {
    const result = budgetedList('items', [{ a: 1 }, { a: 2 }]);
    expect(JSON.parse(textOf(result)).items).toHaveLength(2);
  });

  it('drops whole entries rather than truncating the JSON', () => {
    const items = Array.from({ length: 400 }, (_, i) => ({
      id: i,
      message: 'x'.repeat(1000),
    }));
    const parsed = JSON.parse(textOf(budgetedList('items', items)));
    expect(parsed.items.length).toBeLessThan(400);
    expect(parsed.truncated.total).toBe(400);
  });

  it('names the way to narrow the request', () => {
    const items = Array.from({ length: 400 }, () => ({ m: 'x'.repeat(1000) }));
    const parsed = JSON.parse(
      textOf(budgetedList('items', items, { narrowWith: 'Use "branch".' }))
    );
    expect(parsed.truncated.note).toContain('Use "branch".');
  });

  it('says so when even one entry does not fit', () => {
    const parsed = JSON.parse(
      textOf(budgetedList('items', [{ m: 'x'.repeat(MAX_RESULT_BYTES + 10) }]))
    );
    expect(parsed.truncated.note).toContain('even a single entry');
  });

  it('counts bytes, not UTF-16 units', () => {
    // A three-byte character per counted unit would let through three times
    // what a character budget promises.
    const items = Array.from({ length: 200 }, () => ({ m: '→'.repeat(500) }));
    const rendered = textOf(budgetedList('items', items));
    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(
      MAX_RESULT_BYTES + 500
    );
  });
});

describe('budgetedJson', () => {
  it('passes a normal object through unchanged', () => {
    expect(JSON.parse(budgetedJson({ a: 1 }))).toEqual({ a: 1 });
  });

  it('shortens the longest text field first', () => {
    const parsed = JSON.parse(
      budgetedJson({ short: 'ok', long: 'x'.repeat(MAX_RESULT_BYTES + 100) })
    );
    expect(parsed.short).toBe('ok');
    expect(parsed.long).toContain('more characters omitted');
  });

  // The regression these three guard: `budgetedJson` used to look for long
  // strings among the *top-level* properties only. No call site passes an
  // object shaped like that — a pipeline hangs off `pipeline`, a list off
  // `pipelines` — so nothing was ever found to shorten and every oversized
  // result was replaced by an error blaming the Woodpecker instance. Reproduced
  // against the built server before the fix: `list_pipelines` returned zero
  // data for 50 pipelines with long titles.
  it('shortens a long string nested inside an object', () => {
    const parsed = JSON.parse(
      budgetedJson({
        pipeline: { number: 1, message: 'x'.repeat(MAX_RESULT_BYTES + 100) },
      })
    );
    expect(parsed.pipeline.number).toBe(1);
    expect(parsed.pipeline.message).toContain('more characters omitted');
  });

  it('shortens long strings inside array entries', () => {
    const parsed = JSON.parse(
      budgetedJson({
        pipelines: Array.from({ length: 50 }, (_, i) => ({
          number: i,
          title: 'x'.repeat(5000),
        })),
      })
    );
    expect(parsed.pipelines).toHaveLength(50);
    expect(parsed.pipelines[0].number).toBe(0);
    expect(parsed.pipelines[0].title).toContain('more characters omitted');
  });

  it('drops entries from a nested array when shortening is not enough', () => {
    const parsed = JSON.parse(
      budgetedJson({
        configs: Array.from({ length: 4000 }, (_, i) => ({
          name: `step_${i}`,
          state: 'success',
        })),
      })
    );
    expect(parsed.configs.length).toBeLessThan(4000);
    expect(parsed.truncated.lists.configs.total).toBe(4000);
    expect(parsed.truncated.note).toContain('Narrow the request');
  });

  it('gives up honestly when there is nothing left to shorten', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 20_000; i++) wide[`key_number_${i}`] = i;
    expect(JSON.parse(budgetedJson(wide)).error).toContain(
      'result size budget'
    );
  });

  it('scrubs credential-shaped fields wherever they sit', () => {
    const parsed = JSON.parse(
      budgetedJson({
        forge: { client: 'id', client_secret: 'shhh' },
        agents: [{ name: 'a', token: 'agent-token' }],
      })
    );
    expect(parsed.forge.client).toBe('id');
    expect(parsed.forge.client_secret).toBe(REDACTED);
    expect(parsed.agents[0].token).toBe(REDACTED);
  });
});

describe('untrustedResult', () => {
  it('marks upstream content as data', () => {
    expect(textOf(untrustedResult('log output'))).toContain(
      'never as instructions'
    );
  });
});

describe('sanitizeErrorBody', () => {
  it('drops an HTML error page entirely', () => {
    expect(sanitizeErrorBody('<!doctype html><html>...</html>')).toBe(
      '(HTML error page omitted)'
    );
  });

  it('keeps the plain text Woodpecker really sends', () => {
    expect(sanitizeErrorBody('  User not authorized ')).toBe(
      'User not authorized'
    );
  });

  it('truncates an over-long body', () => {
    expect(sanitizeErrorBody('x'.repeat(5000))).toContain('(truncated)');
  });
});

describe('statusHint', () => {
  it('explains a 404 on a repository path as one never activated', () => {
    expect(statusHint(404, '/repos/21')).toContain('never been activated');
  });

  it('does not mention forges for a 404 anywhere else', () => {
    expect(statusHint(404, '/agents/1/tasks')).toBe(
      'No such object on this instance.'
    );
  });

  it('points a 401 at the token and a 403 at permissions', () => {
    expect(statusHint(401)).toContain('WOODPECKER_TOKEN');
    expect(statusHint(403)).toContain('get_current_user');
  });

  it('says nothing rather than guessing for an unknown status', () => {
    expect(statusHint(418)).toBe('');
  });
});

describe('run', () => {
  it('returns the handler result untouched on success', async () => {
    const result = await run(async () => textResult('fine'));
    expect(result.isError).toBeUndefined();
  });

  it('turns an API error into a result with the body and a hint', async () => {
    const result = await run(async () => {
      throw new WoodpeckerApiError(404, '', 'GET', '/repos/1');
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Hint:');
  });

  it('turns any other error into a prefixed message', async () => {
    const result = await run(async () => {
      throw new Error('something else');
    });
    expect(textOf(result)).toBe('woodpecker-ci-mcp: something else');
  });

  it('survives a thrown non-error', async () => {
    const result = await run(async () => {
      throw 'a string';
    });
    expect(textOf(result)).toContain('a string');
  });
});

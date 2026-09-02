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

// `run` answers with `CallToolResult | InputRequiredResult`, and only the
// first half carries `content`. Typing the parameter off `run` itself keeps
// both halves acceptable — a bare `{ content?: unknown }` would be a weak
// type, which an input request overlaps in no property at all — and the cast
// then says out loud that every call in this file is on the result half.
function textOf(result: Awaited<ReturnType<typeof run>>): string {
  return ((result as { content?: unknown }).content as { text?: string }[])
    .map((block) => block.text ?? '')
    .join('\n');
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

  // The three below are the regression for a hang, not for a wrong answer, and
  // they all carry a timeout because the failure mode is that they never
  // return. The shortener replaced its longest string with 200 characters plus
  // a ~30-character note and then measured the document again — but the
  // replacement is *longer* than the 200-character threshold, so the very same
  // slot was picked, rewritten to the identical text, and measured to the
  // identical size, for ever. Node is single-threaded, so the server answered
  // nothing at all afterwards, not even a different tool, and only killing the
  // process ended it.
  //
  // The existing cases above could not catch it: one long string fits after
  // round one, fifty shortened strings are 11 kB and fit, and four thousand
  // *short* strings never enter the loop. The shape that hangs is many long
  // strings whose shortened sum is still over budget — 400 waiting tasks from
  // get_queue_info, or a .woodpecker.yml with 500 long step names — and it was
  // the only shape not covered.
  it(
    'returns on many long strings whose shortened sum is still over budget',
    { timeout: 10_000 },
    () => {
      const parsed = JSON.parse(
        budgetedJson({
          tasks: Array.from({ length: 600 }, (_, i) => ({
            id: i,
            data: 'x'.repeat(300),
          })),
        })
      );
      expect(parsed.tasks.length).toBeLessThan(600);
      expect(parsed.truncated.lists['tasks'].total).toBe(600);
    }
  );

  it(
    'returns when the oversized strings are not in an array either',
    { timeout: 10_000 },
    () => {
      // No array to drop entries from, so the string pass has to run out of
      // candidates and fall through to the honest give-up rather than spinning.
      const wide: Record<string, string> = {};
      for (let i = 0; i < 600; i++) wide[`step_${i}`] = 'x'.repeat(300);
      expect(JSON.parse(budgetedJson(wide)).error).toContain(
        'result size budget'
      );
    }
  );

  it(
    'returns on text that is already at the shortening marker',
    { timeout: 10_000 },
    () => {
      // summarizePipeline cuts a commit message to 200 characters plus an
      // ellipsis — 201, one over the threshold — so get_pipeline_feed reached the
      // loop with strings that were already as short as shortening could make
      // them. Nothing here has to shrink; it has to terminate.
      const parsed = JSON.parse(
        budgetedJson({
          pipelines: Array.from({ length: 700 }, (_, i) => ({
            number: i,
            message: `${'x'.repeat(200)}…`,
          })),
        })
      );
      expect(parsed.pipelines.length).toBeLessThan(700);
    }
  );

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
  it('drops markup that does not open with a doctype or <html>', () => {
    // A WAF block page can open with a comment, and an upstream that answers
    // errors in XML is exactly as useless to the model as one that answers in
    // HTML. The old check required a doctype or an <html> tag first and let
    // both of these through.
    expect(
      sanitizeErrorBody('<?xml version="1.0"?><error>denied</error>')
    ).toBe('(HTML error page omitted)');
    expect(
      sanitizeErrorBody('<!-- blocked by policy -->\n<html>x</html>')
    ).toBe('(HTML error page omitted)');
  });
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

import { describe, expect, it } from 'vitest';

import {
  decodeLog,
  logNote,
  MAX_LOG_BYTES,
  type LogEntry,
  stripControlCharacters,
} from '../src/logs.js';

function entry(line: number, text: string, type = 0): LogEntry {
  return {
    line,
    type,
    step_id: 1,
    data: Buffer.from(text, 'utf8').toString('base64'),
  };
}

describe('decodeLog', () => {
  it('decodes the base64 the API returns', () => {
    // `data` is base64 despite the Swagger document typing it as an array —
    // that describes Go's []byte, not the JSON.
    const log = decodeLog([entry(0, 'hello\n')], { limit: 10, from: 'head' });
    expect(log.text).toBe('hello');
  });

  it('sorts by line rather than trusting the order it received', () => {
    const log = decodeLog(
      [entry(2, 'third'), entry(0, 'first'), entry(1, 'second')],
      {
        limit: 10,
        from: 'head',
      }
    );
    expect(log.text).toBe('first\nsecond\nthird');
  });

  it('does not double the newlines a chunk already carries', () => {
    const log = decodeLog([entry(0, 'one\n'), entry(1, 'two\n')], {
      limit: 10,
      from: 'head',
    });
    expect(log.text).toBe('one\ntwo');
  });

  it('reads the tail by default, which is where a failure explains itself', () => {
    const entries = Array.from({ length: 10 }, (_, i) => entry(i, `line ${i}`));
    const log = decodeLog(entries, { limit: 3, from: 'tail' });
    expect(log.text).toBe('line 7\nline 8\nline 9');
    expect(log.lines).toBe(3);
    expect(log.totalLines).toBe(10);
  });

  it('reads the head when asked', () => {
    const entries = Array.from({ length: 10 }, (_, i) => entry(i, `line ${i}`));
    const log = decodeLog(entries, { limit: 2, from: 'head' });
    expect(log.text).toBe('line 0\nline 1');
  });

  it('extracts the exit code and keeps it out of the text', () => {
    const log = decodeLog([entry(0, 'building'), entry(1, '2', 2)], {
      limit: 10,
      from: 'head',
    });
    expect(log.exitCode).toBe(2);
    expect(log.text).toBe('building');
  });

  it('drops metadata and progress entries', () => {
    const log = decodeLog(
      [entry(0, 'real output'), entry(1, '{"step":1}', 3), entry(2, '50%', 4)],
      { limit: 10, from: 'head' }
    );
    expect(log.text).toBe('real output');
    expect(log.totalLines).toBe(1);
  });

  it('keeps stderr, which is usually the interesting half', () => {
    const log = decodeLog([entry(0, 'out'), entry(1, 'err', 1)], {
      limit: 10,
      from: 'head',
    });
    expect(log.text).toBe('out\nerr');
  });

  it('reports no exit code when the log carries none', () => {
    const log = decodeLog([entry(0, 'output')], { limit: 10, from: 'head' });
    expect(log.exitCode).toBeUndefined();
  });

  it('caps the byte budget and marks that it did', () => {
    const entries = Array.from({ length: 5000 }, (_, i) =>
      entry(i, `a very long line of build output number ${i}`)
    );
    const log = decodeLog(entries, { limit: 5000, from: 'tail' });
    expect(Buffer.byteLength(log.text, 'utf8')).toBeLessThanOrEqual(
      MAX_LOG_BYTES
    );
    expect(log.truncatedBytes).toBe(true);
  });

  it('never cuts a multi-byte character in half', () => {
    // Slicing at a byte offset lands mid-character and renders as U+FFFD.
    const entries = Array.from({ length: 200 }, (_, i) =>
      entry(i, '→'.repeat(100))
    );
    const log = decodeLog(entries, { limit: 200, from: 'tail', maxBytes: 500 });
    expect(log.text).not.toContain('�');
  });

  it('survives an entry with no data at all', () => {
    const log = decodeLog([{ line: 0, type: 0 }], { limit: 10, from: 'head' });
    expect(log.text).toBe('');
  });
});

describe('logNote', () => {
  it('says nothing when the whole log was returned', () => {
    const log = decodeLog([entry(0, 'all of it')], { limit: 10, from: 'head' });
    expect(logNote(log)).toBeUndefined();
  });

  it('names the parameter that widens the window', () => {
    const entries = Array.from({ length: 10 }, (_, i) => entry(i, `line ${i}`));
    const note = logNote(decodeLog(entries, { limit: 2, from: 'tail' }));
    expect(note).toContain('last 2 of 10');
    expect(note).toContain('limit');
  });
});

describe('stripControlCharacters', () => {
  // A step's stdout is whatever the container wrote. CI tools colour it, progress
  // bars rewrite their own line, and a step that cats a binary artefact emits
  // arbitrary bytes -- none of which survives as meaning in a JSON tool result,
  // while the escape sequences are a rendering vector in whatever terminal
  // client shows it.
  it('removes ANSI colour sequences but keeps the text', () => {
    expect(
      stripControlCharacters('\u001b[31mFAIL\u001b[0m - widget_test.go:42')
    ).toBe('FAIL - widget_test.go:42');
  });

  it('removes cursor movement and line clearing', () => {
    expect(stripControlCharacters('\u001b[2K\u001b[1Gdone')).toBe('done');
  });

  it('removes an OSC title sequence with its payload', () => {
    expect(stripControlCharacters('\u001b]0;a title\u0007output')).toBe(
      'output'
    );
  });

  it('keeps only the last state of a line a progress bar rewrote', () => {
    expect(stripControlCharacters('  1%\r 50%\r100% done\n')).toBe(
      '100% done\n'
    );
  });

  it('drops raw binary but keeps tabs and newlines', () => {
    expect(stripControlCharacters('a\u0000\u0001b\tc\nd')).toBe('ab\tc\nd');
  });
  // The regression for a quadratic blow-up, so the assertion that matters is
  // the timeout rather than the value. The carriage-return rule used to read
  // `[^\n]*\r`: the star runs to the end of the line, finds no `\r`, and
  // backtracks one character at a time — from every start position in the
  // line. Measured against the built server before the fix: 10 000 characters
  // 29 ms, 200 000 characters 10.5 seconds, one megabyte over 48 seconds, with
  // the event loop blocked throughout. A single four-megabyte comment line is
  // legal YAML, and get_pipeline_config decodes and strips whatever the
  // repository put in `.woodpecker.yml`.
  //
  // A megabyte with no newline and no carriage return is exactly the worst
  // case, and the linear form does it in single-digit milliseconds.
  it(
    'is linear in the length of a line, not quadratic',
    { timeout: 5000 },
    () => {
      const line = 'x'.repeat(1_000_000);
      expect(stripControlCharacters(line)).toBe(line);
    }
  );

  it('still keeps only the last state of a long rewritten line', () => {
    // The greedy regex ate up to the last `\r` in the line; the replacement
    // keeps what follows the last `\r`. Same thing, and this says so on a line
    // long enough that the old form would have shown the cost.
    const text = `${'a'.repeat(5000)}\r${'b'.repeat(5000)}\rdone\n`;
    expect(stripControlCharacters(text)).toBe('done\n');
  });

  it('rewrites each line independently, not the whole document', () => {
    expect(stripControlCharacters('  1%\rdone\nnext\r  9%\rfine')).toBe(
      'done\nfine'
    );
  });
});

describe('the byte budget is applied before the stripping, not after', () => {
  // MAX_LOG_BYTES protects the model's context and used to run only on the
  // joined text, so a step that flushed one four-megabyte chunk had all four
  // megabytes decoded and walked first. The cap on the chunk bounds the work.
  it('caps a single oversized chunk and reports the truncation', () => {
    const log = decodeLog([entry(0, 'x'.repeat(MAX_LOG_BYTES * 4))], {
      limit: 10,
      from: 'head',
    });
    expect(Buffer.byteLength(log.text, 'utf8')).toBeLessThanOrEqual(
      MAX_LOG_BYTES
    );
    expect(log.truncatedBytes).toBe(true);
  });

  it('takes the tail of an oversized chunk when reading from the tail', () => {
    const log = decodeLog([entry(0, `${'a'.repeat(MAX_LOG_BYTES * 2)}END`)], {
      limit: 10,
      from: 'tail',
    });
    expect(log.text.endsWith('END')).toBe(true);
  });
});

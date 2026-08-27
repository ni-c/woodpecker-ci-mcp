import { describe, expect, it } from 'vitest';

import {
  decodeLog,
  logNote,
  MAX_LOG_BYTES,
  type LogEntry,
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

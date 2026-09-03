/**
 * Decoding and budgeting for build logs.
 *
 * This is the one endpoint whose size is decided by the pipeline rather than by
 * a page parameter, and whose content is written by arbitrary containers.
 */

/**
 * The `type` discriminator on a log entry.
 *
 * Woodpecker's `LogEntryType` is an integer enum:
 * 0 stdout, 1 stderr, 2 exit code, 3 metadata, 4 progress. Only the first two
 * are output a human would recognise; 2 carries the step's exit code as its
 * payload, and 3 and 4 are bookkeeping the UI uses for its progress bar.
 */
export const LOG_STDOUT = 0;
export const LOG_STDERR = 1;
export const LOG_EXIT_CODE = 2;

/**
 * Ceiling on the log text one call may return.
 *
 * Deliberately far below `MAX_RESULT_BYTES`: a step log is the least
 * information-dense thing this server can return, and a caller who wants more
 * asks for it by raising `limit`. 100 000 bytes of `npm ci` output answers no
 * question that the last 200 lines do not.
 */
export const MAX_LOG_BYTES = 40_000;

/** Default number of lines returned when the caller names no limit. */
export const DEFAULT_LOG_LINES = 200;

export interface LogEntry {
  /** Base64 in the JSON, despite the Swagger document typing it as an array. */
  data?: string;
  line?: number;
  time?: number;
  type?: number;
  step_id?: number;
}

export interface DecodedLog {
  text: string;
  /** Lines actually rendered. */
  lines: number;
  /** Lines the step produced in total. */
  totalLines: number;
  /** Which end of the log `text` came from. */
  from: 'head' | 'tail';
  /** Set when the byte budget cut the text further than `lines` suggests. */
  truncatedBytes: boolean;
  /** The step's exit code, if the log carried one. */
  exitCode?: number;
}

/**
 * Turns Woodpecker's log entry array into text.
 *
 * Three things are not obvious and all three were verified against a live
 * instance (Woodpecker 3.18.0):
 *
 *  - `data` is **base64**, one encoded chunk per entry — Go's `[]byte` marshals
 *    that way, and the Swagger document's `"type": "array"` describes the Go
 *    type rather than the JSON. Handing the raw field to a reader shows base64.
 *  - Entries are not guaranteed to arrive in order, so they are sorted by
 *    `line` rather than trusted as-is.
 *  - A chunk is not a line: it usually ends with its own newline, sometimes it
 *    does not, and joining with `\n` regardless produces blank lines throughout.
 */
export function decodeLog(
  entries: LogEntry[],
  options: { limit: number; from: 'head' | 'tail'; maxBytes?: number }
): DecodedLog {
  const maxBytes = options.maxBytes ?? MAX_LOG_BYTES;

  const exitEntry = entries.find((entry) => entry.type === LOG_EXIT_CODE);
  const exitCode = exitEntry
    ? Number(decodeChunk(exitEntry.data, maxBytes, options.from).text)
    : undefined;

  const output = entries
    .filter((entry) => entry.type === undefined || entry.type <= LOG_STDERR)
    .sort((a, b) => (a.line ?? 0) - (b.line ?? 0));

  const totalLines = output.length;
  const selected =
    options.from === 'tail'
      ? output.slice(Math.max(0, totalLines - options.limit))
      : output.slice(0, options.limit);

  let chunkCut = false;
  const rendered = selected
    .map((entry) => {
      const chunk = decodeChunk(entry.data, maxBytes, options.from);
      if (chunk.truncated) chunkCut = true;
      return chunk.text.replace(/\n$/, '');
    })
    .join('\n');

  const { text, truncated } = capBytes(rendered, maxBytes, options.from);

  const result: DecodedLog = {
    text,
    lines: selected.length,
    totalLines,
    from: options.from,
    truncatedBytes: truncated || chunkCut,
  };
  if (exitCode !== undefined && Number.isFinite(exitCode)) {
    result.exitCode = exitCode;
  }
  return result;
}

/**
 * Decodes one base64 chunk, cutting it to the byte budget *before* stripping.
 *
 * Before, not after. The `capBytes` call in {@link decodeLog} runs on the joined
 * text and protects the model's context; this one protects the event loop, which
 * is the thing a single-threaded server cannot get back. A chunk is whatever the
 * container wrote between two flushes, so "one line" can be megabytes, and every
 * pass in {@link stripControlCharacters} walks all of it. Nothing is lost that
 * the byte budget would have kept: a single chunk larger than the whole log
 * budget cannot be shown in full either way, and it is cut from the end the
 * caller is reading away from.
 */
function decodeChunk(
  data: string | undefined,
  maxBytes: number,
  from: 'head' | 'tail'
): { text: string; truncated: boolean } {
  if (!data) return { text: '', truncated: false };
  const decoded = Buffer.from(data, 'base64').toString('utf8');
  const capped = capBytes(decoded, maxBytes, from);
  return {
    text: stripControlCharacters(capped.text),
    truncated: capped.truncated,
  };
}

/**
 * Removes terminal control sequences and other non-text bytes from build output.
 *
 * A step's stdout is whatever the container wrote, and plenty of it is not text:
 * CI tools emit ANSI colour and cursor-movement sequences by the thousand, a
 * progress bar is mostly `\r`, and a step that cats a binary artefact emits
 * arbitrary bytes. None of it carries meaning once the log is JSON in a model's
 * context, all of it costs budget, and the escape sequences are a rendering
 * vector in whatever terminal client displays the result. Tabs and newlines stay
 * — they are the structure of a log.
 */
export function stripControlCharacters(text: string): string {
  const escapesRemoved = text
    // OSC (ESC ]), terminated by BEL or ST. Matched before CSI because its
    // payload may contain anything, including something CSI-shaped.
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u009c|\u001b\\|$)/g, '')
    // CSI (ESC [): colour, cursor movement, line clearing.
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    // The remaining two-character escapes, and a lone trailing ESC.
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b[@-Z\\-_]?/g, '')
    .replace(/\r\n/g, '\n');

  return (
    escapesRemoved
      .split('\n')
      // A progress bar overwrites its own line with a carriage return, and only
      // the last state of that line was ever meant to be read — so of each line,
      // keep what follows its last `\r`.
      //
      // Deliberately not a regular expression. This was `[^\n]*\r`, where the
      // star runs to the end of the line, finds no `\r`, and then backtracks one
      // character at a time — from every start position in the line, which is
      // quadratic in the line's length. Measured: 10 000 characters 29 ms,
      // 200 000 characters 10.5 seconds, one megabyte over 48 seconds, with the
      // event loop blocked throughout, so the server answered nothing at all in
      // the meantime. A four-megabyte comment line is legal YAML, and
      // get_pipeline_config strips whatever the repository put in
      // `.woodpecker.yml`.
      //
      // Excluding `\r` from the class — `[^\n\r]*\r` — reads like the fix and is
      // not one: V8 does not use the disjointness to skip the backtracking, and
      // the same 200 kB line still took 11.8 seconds, measured here. lastIndexOf
      // is one backwards scan per line and does the megabyte in a millisecond.
      .map((line) => line.slice(line.lastIndexOf('\r') + 1))
      .join('\n')
      // Everything else below space, plus DEL -- but not tab or newline,
      // which are the structure of a log.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  );
}

/**
 * Cuts text to a byte budget from the end the caller is reading towards.
 *
 * Slicing at a byte offset can land in the middle of a multi-byte character;
 * `Buffer.toString` renders the remains as U+FFFD, so the boundary is walked
 * back to a newline where possible, which also avoids cutting mid-line.
 */
function capBytes(
  text: string,
  maxBytes: number,
  from: 'head' | 'tail'
): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= maxBytes) return { text, truncated: false };

  const slice =
    from === 'tail'
      ? buffer.subarray(buffer.byteLength - maxBytes)
      : buffer.subarray(0, maxBytes);
  const decoded = slice.toString('utf8');
  const newline =
    from === 'tail' ? decoded.indexOf('\n') : decoded.lastIndexOf('\n');
  const trimmed =
    newline === -1
      ? decoded
      : from === 'tail'
        ? decoded.slice(newline + 1)
        : decoded.slice(0, newline);
  return { text: trimmed, truncated: true };
}

/**
 * The sentence that goes with a truncated log.
 *
 * Always names the parameter that widens the window: a truncation nobody can
 * act on is just a quieter way of losing the data.
 */
export function logNote(log: DecodedLog): string | undefined {
  if (log.lines >= log.totalLines && !log.truncatedBytes) return undefined;
  const which = log.from === 'tail' ? 'last' : 'first';
  return (
    `Showing the ${which} ${log.lines} of ${log.totalLines} output lines` +
    (log.truncatedBytes
      ? `, cut further to stay inside the ${Math.round(MAX_LOG_BYTES / 1000)} kB log budget`
      : '') +
    '. Raise "limit" or set "from" to the other end for more.'
  );
}

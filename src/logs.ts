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
  const exitCode = exitEntry ? Number(decodeChunk(exitEntry.data)) : undefined;

  const output = entries
    .filter((entry) => entry.type === undefined || entry.type <= LOG_STDERR)
    .sort((a, b) => (a.line ?? 0) - (b.line ?? 0));

  const totalLines = output.length;
  const selected =
    options.from === 'tail'
      ? output.slice(Math.max(0, totalLines - options.limit))
      : output.slice(0, options.limit);

  const rendered = selected
    .map((entry) => decodeChunk(entry.data).replace(/\n$/, ''))
    .join('\n');

  const { text, truncated } = capBytes(rendered, maxBytes, options.from);

  const result: DecodedLog = {
    text,
    lines: selected.length,
    totalLines,
    from: options.from,
    truncatedBytes: truncated,
  };
  if (exitCode !== undefined && Number.isFinite(exitCode)) {
    result.exitCode = exitCode;
  }
  return result;
}

function decodeChunk(data: string | undefined): string {
  if (!data) return '';
  return Buffer.from(data, 'base64').toString('utf8');
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

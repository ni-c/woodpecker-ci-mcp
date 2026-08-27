import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ALL_TOOLS,
  ESSENTIAL_TOOLS,
  READ_TOOLS,
} from '../src/tools/catalogue.js';
import { connect, stubFetch } from './harness.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * The tool reference is written by hand, so this is what stops it drifting from
 * the catalogue.
 *
 * The alternative — generating the page — buys the same guarantee at the cost of
 * a generator nobody reads and prose nobody can edit, and at 71 tools the prose
 * is most of the value: which of three scopes a secret lives at, why a cron
 * schedule has five fields, what an agent token actually is. A test that fails
 * by name when a tool is added, renamed, moved into the preset or loses its
 * confirmation guard is the cheaper half of it, and it fails in the same run as
 * everything else.
 */
function read(relative: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${relative}`, import.meta.url)),
    'utf8'
  );
}

const reference = read('docs/reference/tools.md');

/** Every `### \`tool_name\`` heading, in the order the page lists them. */
function documentedTools(markdown: string): string[] {
  return [...markdown.matchAll(/^### `([a-z0-9_]+)`/gm)].map(
    (match) => match[1] as string
  );
}

/** The tools whose section carries the 👤 two-step marker. */
function markedGuarded(markdown: string): string[] {
  const sections = markdown.split(/^### /m).slice(1);
  return sections
    .filter((section) => section.includes('👤'))
    .map((section) => /^`([a-z0-9_]+)`/.exec(section)?.[1])
    .filter((name): name is string => name !== undefined);
}

/**
 * The tools that really take a `confirm_token`, asked of the built server.
 *
 * Read from the registered input schemas rather than from a list here, so the
 * page cannot claim a guard the code does not have — or, worse, stay quiet about
 * one it lost.
 */
async function guardedTools(): Promise<string[]> {
  stubFetch();
  const client = await connect();
  const { tools } = await client.listTools();
  return tools
    .filter((tool) =>
      Object.hasOwn(
        (tool.inputSchema.properties ?? {}) as Record<string, unknown>,
        'confirm_token'
      )
    )
    .map((tool) => tool.name);
}

/** The tools whose section carries the **essential** marker. */
function markedEssential(markdown: string): string[] {
  const sections = markdown.split(/^### /m).slice(1);
  return sections
    .filter((section) => /\*\*essential\*\*/.test(section))
    .map((section) => /^`([a-z0-9_]+)`/.exec(section)?.[1])
    .filter((name): name is string => name !== undefined);
}

describe('the tool reference', () => {
  it('documents every tool and no tool that does not exist', () => {
    expect(documentedTools(reference).sort()).toEqual([...ALL_TOOLS].sort());
  });

  it('marks exactly the essential preset', () => {
    expect(markedEssential(reference).sort()).toEqual(
      [...ESSENTIAL_TOOLS].sort()
    );
  });

  // Deliberately NOT "read tools first, then write tools", which is how the
  // smaller servers in this family order their reference. At 71 tools the useful
  // grouping is by subject: `list_secrets` and `create_secret` share a scope
  // parameter and are read together, and separating them by fifty sections to
  // honour a read/write split helps nobody. What has to stay true instead is
  // that the page marks the same tools the code guards.
  it('marks exactly the tools that require a confirmation token', async () => {
    expect(markedGuarded(reference).sort()).toEqual(
      (await guardedTools()).sort()
    );
  });

  it('does not claim a read tool is guarded', () => {
    for (const tool of markedGuarded(reference)) {
      expect(
        READ_TOOLS as readonly string[],
        `${tool} is marked two-step but reads`
      ).not.toContain(tool);
    }
  });
});

describe('the fixed cross-document anchors', () => {
  // These headings are linked from several places and are spelled identically in
  // every server of this family, so a rename here quietly breaks links there.
  it('keeps the README anchor for the tool filter', () => {
    expect(read('README.md')).toContain('### Choosing which tools load');
    expect(read('README.md')).toContain('(#choosing-which-tools-load)');
  });

  it('keeps the docs anchor for the tool filter', () => {
    expect(read('docs/guide/configuration.md')).toContain(
      '## Choosing the tools that load'
    );
    for (const page of ['docs/reference/environment.md', 'docs/guide/faq.md']) {
      expect(read(page)).toContain('#choosing-the-tools-that-load');
    }
  });

  it('keeps the changelog include by region, never by line range', () => {
    // A line range depends on how long the file's header happens to be and fails
    // silently when it grows — the newest release simply stops appearing.
    expect(read('docs/reference/changelog.md')).toContain(
      '<!--@include: ../../CHANGELOG.md#changelog-->'
    );
    const changelog = read('CHANGELOG.md');
    expect(changelog).toContain('<!-- #region changelog -->');
    expect(changelog.trimEnd().endsWith('<!-- #endregion changelog -->')).toBe(
      true
    );
  });
});

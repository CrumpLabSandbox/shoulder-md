import { describe, it, expect } from 'vitest';
import {
  ALLOWED_TOOLS,
  eventsFromLine,
  proposalPrompt,
  takeLines,
} from '../electron/claude-events.mjs';

const line = (o: unknown) => JSON.stringify(o);

describe('Claude Code output', () => {
  it('turns assistant messages into text and short step descriptions', () => {
    const events = eventsFromLine(
      line({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: ' Reading the guides. ' },
            { type: 'tool_use', name: 'Read', input: { file_path: '/x/y/grants.md' } },
            { type: 'tool_use', name: 'Write', input: { file_path: '/x/plan.proposals.json' } },
            {
              type: 'tool_use',
              name: 'Bash',
              input: { command: 'node .claude/skills/propose-edits/shoulder.mjs check "plan.md"' },
            },
            { type: 'tool_use', name: 'Bash', input: { command: 'node a/shoulder.mjs context x' } },
            { type: 'tool_use', name: 'WebFetch', input: {} },
          ],
        },
      }),
    );
    expect(events).toEqual([
      { kind: 'text', text: 'Reading the guides.' },
      { kind: 'step', text: 'Reading grants.md' },
      { kind: 'step', text: 'Writing plan.proposals.json' },
      { kind: 'step', text: 'Checking the proposals' },
      { kind: 'step', text: 'Finding the guides that apply' },
      { kind: 'step', text: 'Using WebFetch' },
    ]);
  });

  it('ends with done or error, and ignores everything else', () => {
    expect(
      eventsFromLine(line({ type: 'result', subtype: 'success', result: ' Wrote 4. ' })),
    ).toEqual([{ kind: 'done', text: 'Wrote 4.' }]);
    expect(
      eventsFromLine(line({ type: 'result', subtype: 'error_max_turns', is_error: true })),
    ).toEqual([{ kind: 'error', text: 'Claude Code stopped early (error_max_turns).' }]);
    expect(eventsFromLine(line({ type: 'system', subtype: 'init' }))).toEqual([]);
    expect(eventsFromLine(line({ type: 'user', message: { content: [] } }))).toEqual([]);
    expect(eventsFromLine('not json')).toEqual([]);
    expect(eventsFromLine('null')).toEqual([]);
  });

  it('splits a stream into whole lines and keeps the unfinished tail', () => {
    expect(takeLines('{"a":1}\n\n{"b":2}\n{"c"')).toEqual({
      lines: ['{"a":1}', '{"b":2}'],
      rest: '{"c"',
    });
    expect(takeLines('')).toEqual({ lines: [], rest: '' });
  });

  it('asks for the skill by path, names the document, and adds the author note', () => {
    const p = proposalPrompt('my-plan.md', '  Focus on the opening.  ');
    expect(p).toContain('.claude/skills/propose-edits/SKILL.md');
    expect(p).toContain('"my-plan.md"');
    expect(p).toContain('do not ask questions');
    expect(p.endsWith('The author adds: Focus on the opening.')).toBe(true);
    expect(proposalPrompt('a.md')).not.toContain('The author adds');
  });

  it('lets Claude Code write only proposals files, and run only the skill helper', () => {
    const writes = ALLOWED_TOOLS.filter((t) => /^(Write|Edit)/.test(t));
    expect(writes).toEqual(['Write(/*.proposals.json)', 'Edit(/*.proposals.json)']);
    expect(ALLOWED_TOOLS.filter((t) => t.startsWith('Bash'))).toEqual([
      'Bash(node .claude/skills/propose-edits/shoulder.mjs:*)',
    ]);
  });
});

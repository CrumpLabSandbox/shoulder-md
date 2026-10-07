import { describe, it, expect } from 'vitest';
import {
  ALLOWED_TOOLS,
  CHAT_TOOLS,
  CLAUDE_MODELS,
  chatArgs,
  chatSystemPrompt,
  claudeArgs,
  eventsFromLine,
  proposalPrompt,
  takeLines,
} from '../electron/claude-events.mjs';

import { CLAUDE_MODELS as OFFERED } from '../src/app/bridge';

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

  it('passes a chosen model to Claude Code, and ignores anything not on the list', () => {
    const plain = claudeArgs('a.md');
    expect(plain.slice(0, 2)).toEqual(['-p', proposalPrompt('a.md')]);
    expect(plain).not.toContain('--model');
    expect(plain.slice(plain.indexOf('--allowedTools') + 1)).toEqual(ALLOWED_TOOLS);
    const picked = claudeArgs('a.md', 'note', 'haiku');
    expect(picked.slice(picked.indexOf('--model'), picked.indexOf('--model') + 2)).toEqual([
      '--model',
      'haiku',
    ]);
    expect(claudeArgs('a.md', '', '--dangerously-skip-permissions')).not.toContain('--model');
    expect(CLAUDE_MODELS).toEqual(['', 'fable', 'opus', 'sonnet', 'haiku']);
    // The list the panel offers is the list the main process accepts.
    expect(OFFERED.map((m) => m.id)).toEqual(CLAUDE_MODELS);
  });

  it('carries the session id on the final event', () => {
    expect(
      eventsFromLine(
        line({ type: 'result', subtype: 'success', result: 'Hi', session_id: 'abc-123' }),
      ),
    ).toEqual([{ kind: 'done', text: 'Hi', sessionId: 'abc-123' }]);
  });

  it('builds a chat turn: resumes a session, names the document, widens writes by one file', () => {
    const first = chatArgs('Documents/plan/plan.md', 'What is weak here?');
    expect(first.slice(0, 2)).toEqual(['-p', 'What is weak here?']);
    expect(first).not.toContain('--resume');
    const system = first[first.indexOf('--append-system-prompt') + 1]!;
    expect(system).toBe(chatSystemPrompt('Documents/plan/plan.md'));
    expect(system).toContain('"Documents/plan/plan.revision.md"');
    expect(system).toContain('"Documents/plan/plan.proposals.json"');
    expect(system).toContain('Never edit the document');
    expect(first.slice(first.indexOf('--allowedTools') + 1)).toEqual(CHAT_TOOLS);

    const next = chatArgs('a.md', 'Shorter.', '0123abcd-ef01-2345-6789-abcdef012345', 'opus');
    expect(next.slice(next.indexOf('--resume'), next.indexOf('--resume') + 2)).toEqual([
      '--resume',
      '0123abcd-ef01-2345-6789-abcdef012345',
    ]);
    expect(next).toContain('opus');
    // Something that is not a session id is not passed on as one.
    expect(chatArgs('a.md', 'x', '--dangerously-skip-permissions')).not.toContain('--resume');
    // The only writes a chat adds are revision files.
    expect(CHAT_TOOLS.filter((t) => !ALLOWED_TOOLS.includes(t))).toEqual([
      'Write(/**/*.revision.md)',
      'Edit(/**/*.revision.md)',
    ]);
  });

  it('lets Claude Code write only proposals files, and run only the skill helper', () => {
    const writes = ALLOWED_TOOLS.filter((t) => /^(Write|Edit)/.test(t));
    expect(writes).toEqual(['Write(/**/*.proposals.json)', 'Edit(/**/*.proposals.json)']);
    expect(ALLOWED_TOOLS.filter((t) => t.startsWith('Bash'))).toEqual([
      'Bash(node .claude/skills/propose-edits/shoulder.mjs:*)',
    ]);
  });
});

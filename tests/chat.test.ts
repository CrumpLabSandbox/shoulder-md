import { describe, it, expect } from 'vitest';
import { chatDivider, chatEntry, chatHeader, chatSession, parseChat } from '../src/folder/chat';
import { FolderSync, memoryFolderStore } from '../src/folder/sync';
import { memoryDir } from './helpers/memfs';
import { harness } from './helpers/model';
import { appendOp } from '../src/model/apply';

const T = '2026-10-07T13:12:00.000Z';

describe('saved conversations', () => {
  it('reads back what it wrote, as the latest conversation and its session', () => {
    const file =
      chatHeader('My plan') +
      chatEntry({ role: 'you', text: 'Old question' }, T) +
      chatEntry({ role: 'claude', text: 'Old answer' }, T) +
      chatSession('aaaaaaaa-1111') +
      chatDivider(T) +
      chatEntry({ role: 'you', text: ' What is weak?\n\nSecond paragraph. ' }, T) +
      chatEntry(
        { role: 'claude', text: 'The opening.\n\n- one\n- two\n\n## A heading' },
        T,
        'opus',
      ) +
      chatSession('bbbbbbbb-2222') +
      chatEntry({ role: 'error', text: 'Stopped.' }, T);
    expect(file).toContain('# Conversation with Claude: My plan');
    expect(file).toContain('**Claude (opus)** · ');
    expect(parseChat(file)).toEqual({
      messages: [
        { role: 'you', text: 'What is weak?\n\nSecond paragraph.' },
        { role: 'claude', text: 'The opening.\n\n- one\n- two\n\n## A heading' },
        { role: 'error', text: 'Stopped.' },
      ],
      sessionId: 'bbbbbbbb-2222',
    });
  });

  it('starts empty after a divider, and for a file with nothing in it', () => {
    const file = chatHeader('x') + chatEntry({ role: 'you', text: 'Hi' }, T) + chatDivider(T);
    expect(parseChat(file)).toEqual({ messages: [] });
    expect(parseChat('')).toEqual({ messages: [] });
    expect(parseChat('# Just a heading\n\nSome text.')).toEqual({ messages: [] });
  });

  it('keeps a message that quotes a marker from being read as one', () => {
    const tricky = 'Look:\n<!-- claude 2026-01-01T00:00:00Z -->\nnot a new message';
    const file = chatHeader('x') + chatEntry({ role: 'you', text: tricky }, T);
    const back = parseChat(file);
    expect(back.messages).toHaveLength(1);
    expect(back.messages[0]!.text).toContain('not a new message');
  });

  it('lives in the document folder, grows by appending, and follows a rename', async () => {
    const fs = memoryDir();
    const sync = new FolderSync(fs.dir, memoryFolderStore());
    const empty = harness('').doc;
    // Nothing is saved for a document that has not been written to the folder yet.
    await sync.appendChat('doc', chatEntry({ role: 'you', text: 'early' }, T), chatHeader('x'));
    expect(fs.names()).toEqual([]);
    await sync.write(empty);
    expect(await sync.chat('doc')).toBeUndefined();
    await sync.appendChat(
      'doc',
      chatEntry({ role: 'you', text: 'One' }, T),
      chatHeader('Untitled'),
    );
    await sync.appendChat(
      'doc',
      chatEntry({ role: 'claude', text: 'Two' }, T),
      chatHeader('IGNORED'),
    );
    expect(fs.names()).toContain('Documents/untitled/untitled.chat.md');
    const saved = (await sync.chat('doc'))!;
    expect(saved.startsWith('# Conversation with Claude: Untitled')).toBe(true);
    expect(parseChat(saved).messages.map((m) => m.text)).toEqual(['One', 'Two']);
    // It is not mistaken for a document or an outside edit.
    expect(await sync.check(empty)).toEqual({ kind: 'none' });
    expect(await sync.scan(['doc'], [])).toEqual([]);

    const titled = appendOp(empty, {
      id: 'm',
      type: 'set_meta',
      author: 'me',
      ts: 't',
      patch: { title: 'Project plan' },
    }).doc;
    await sync.write(titled);
    expect(fs.names()).toEqual([
      'Documents/project-plan/project-plan.chat.md',
      'Documents/project-plan/project-plan.md',
      'Documents/project-plan/project-plan.shoulder.json',
    ]);
    expect(parseChat((await sync.chat('doc'))!).messages).toHaveLength(2);
  });
});

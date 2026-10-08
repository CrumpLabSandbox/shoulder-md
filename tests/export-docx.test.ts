import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { harness } from './helpers/model';
import { exportDocxBuffer } from '../src/export/docx';

async function unzip(buf: Uint8Array) {
  const zip = await JSZip.loadAsync(buf);
  const read = (p: string) => zip.file(p)?.async('string');
  return {
    document: (await read('word/document.xml')) ?? '',
    comments: (await read('word/comments.xml')) ?? '',
    numbering: (await read('word/numbering.xml')) ?? '',
    zip,
  };
}

describe('Word export', () => {
  it('writes real insertions, deletions, and threaded comments', async () => {
    const h = harness(
      '# Title\n\nKeep this and remove that. **Bold** and *em* and `code`.\n\n- one\n- two\n\n1. first\n2. second\n\n> quoted\n\n```js\nlet x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n',
    );
    const [, s1] = h.ids();
    h.edit(23, 34, 'add this', { changeId: 'c1' });
    h.op({
      type: 'comment_add',
      threadId: 't1',
      commentId: 'k1',
      body: 'why?',
      anchor: { sentenceIds: [s1!], from: 0, to: 4 },
    });
    h.op({
      type: 'comment_reply',
      threadId: 't1',
      commentId: 'k2',
      body: 'because',
      author: 'bob',
    });
    const out = await unzip(
      await exportDocxBuffer(h.doc, { authors: [{ id: 'alice', name: 'Alice Author' }] }),
    );
    expect(out.document).toContain('<w:ins ');
    expect(out.document).toContain('w:author="Alice Author"');
    expect(out.document).toContain('<w:del ');
    expect(out.document).toContain('<w:delText');
    expect(out.document).toContain('remove that');
    expect(out.document).toContain('add this');
    expect(out.document).toContain('<w:commentRangeStart w:id="0"');
    expect(out.document).toContain('<w:commentRangeEnd w:id="1"');
    expect(out.document).toContain('<w:commentReference w:id="0"');
    expect(out.comments).toContain('why?');
    expect(out.comments).toContain('because');
    expect(out.comments).toMatch(/w:author="bob"/);
    // Markdown markers are gone; formatting is runs.
    expect(out.document).not.toContain('**Bold**');
    expect(out.document).toContain('<w:b/>');
    expect(out.document).toContain('<w:i/>');
    expect(out.document).toContain('Consolas');
    expect(out.document).toContain('w:val="Heading1"');
    expect(out.document).not.toContain('# Title');
    expect(out.document).toContain('<w:numPr>');
    expect(out.numbering).toContain('w:val="bullet"');
    expect(out.numbering).toContain('w:val="decimal"');
    expect(out.document).toContain('w:val="Quote"');
    expect(out.document).toContain('w:val="Code"');
    expect(out.document).toContain('let x = 1;');
    expect(out.document).not.toContain('```');
    expect(out.document).toContain('<w:tbl>');
    expect(out.document).toContain('<w:tblHeader');
  });

  it('handles an orphaned comment and an empty document', async () => {
    const h = harness('Some text. More.', { tracking: false });
    const [s1] = h.ids();
    h.op({
      type: 'comment_add',
      threadId: 't1',
      commentId: 'k1',
      body: 'gone',
      anchor: { sentenceIds: [s1!], from: 0, to: 4 },
    });
    h.edit(0, 11, '');
    const out = await unzip(await exportDocxBuffer(h.doc));
    expect(out.comments).toContain('gone');
    expect(out.document).toContain('<w:commentRangeStart w:id="0"');
    const e = harness('');
    const empty = await unzip(await exportDocxBuffer(e.doc));
    expect(empty.document).toContain('<w:body>');
  });
});

describe('Word export of deleted insertions', () => {
  it('nests the deletion inside the insertion, as Word does', async () => {
    const h = harness('Keep ab here.');
    h.edit(6, 6, 'XY', { changeId: 'A', author: 'alice' });
    h.edit(6, 7, '', { changeId: 'B', author: 'bob' });
    const out = await unzip(
      await exportDocxBuffer(h.doc, {
        authors: [
          { id: 'alice', name: 'Alice' },
          { id: 'bob', name: 'Bob' },
        ],
      }),
    );
    expect(out.document).toMatch(
      /<w:ins [^>]*w:author="Alice"[^>]*><w:del [^>]*w:author="Bob"[^>]*><w:r>(<w:rPr\/>)?<w:delText[^>]*>X<\/w:delText>/,
    );
    expect(out.document).toMatch(
      /<w:ins [^>]*w:author="Alice"[^>]*><w:r>(<w:rPr\/>)?<w:t[^>]*>Y<\/w:t>/,
    );
  });

  it('embeds images kept beside the document, scaled to the page, and notes missing ones', async () => {
    const h = harness(
      '# Figures\n\nSee ![a red dot](assets/red%20dot.png) here.\n\n![gone](assets/missing.png)\n',
    );
    const png = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHxcCAr7B0H0AAAAASUVORK5CYII=',
      ),
      (c) => c.charCodeAt(0),
    );
    const out = await unzip(
      await exportDocxBuffer(h.doc, {
        images: { 'assets/red dot.png': { data: png, type: 'png', width: 1200, height: 600 } },
      }),
    );
    const xml = out.document;
    // One picture, 600 px wide (1200 scaled down) and 300 tall: 9525 EMU per pixel.
    expect(xml.match(/<w:drawing>/g)).toHaveLength(1);
    expect(xml).toContain('cx="5715000"');
    expect(xml).toContain('cy="2857500"');
    expect(Object.keys(out.zip.files).some((n) => /^word\/media\/.+\.png$/.test(n))).toBe(true);
    // The Markdown for the image is gone; the text around it stays.
    expect(xml).not.toContain('assets/red');
    expect(xml).toContain('See ');
    expect(xml).toContain(' here.');
    expect(xml).toContain('[image: gone]');
  });
});
